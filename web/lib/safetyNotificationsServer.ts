import "server-only";

// M3.2 — clinician safety notification inbox. Every read goes through the
// server-only database functions with the AUTHENTICATED user's own id; they
// return only rows whose recipient is still eligible (current assignment /
// current fallback authority), so a former clinician never sees a patient
// through a historical row. Reading never implies clinical review or
// release. In maintenance, opening a notification never records read_at.
import { createServiceRoleClient } from "./supabase/server";
import { isMutationAllowed } from "./operatingMode";

export type SafetyInboxItem = {
  recipientId: string;
  subjectKind: "episode_event" | "acute_stop_notice";
  tier: "safety_review" | "clinician_review" | "urgent_clinician_review" | null;
  basis: "assigned_clinician" | "fallback_clinician_admin" | "late_assignment";
  patientId: string;
  patientName: string | null;
  episodeId: string | null;
  sessionId: string | null;
  detectedAt: string;
  readAt: string | null;
  isOpen: boolean;
  resolvedAt: string | null;
  superseded: boolean;
  effectiveLevel: number | null;
  reviewReasons: string[] | null;
};

type Row = Record<string, unknown>;

export async function getSafetyInbox(userId: string): Promise<SafetyInboxItem[]> {
  const admin = createServiceRoleClient();
  const { data, error } = await admin.rpc("safety_notification_inbox", { p_user_id: userId, p_limit: 200 });
  if (error) throw new Error(`safety_notification_inbox failed: ${error.message}`);
  return ((data ?? []) as Row[]).map((r) => ({
    recipientId: r.recipient_id as string,
    subjectKind: r.subject_kind as SafetyInboxItem["subjectKind"],
    tier: (r.tier as SafetyInboxItem["tier"]) ?? null,
    basis: r.basis as SafetyInboxItem["basis"],
    patientId: r.patient_id as string,
    patientName: (r.patient_name as string | null) ?? null,
    episodeId: (r.acute_safety_episode_id as string | null) ?? null,
    sessionId: (r.rehab_session_id as string | null) ?? null,
    detectedAt: r.detected_at as string,
    readAt: (r.read_at as string | null) ?? null,
    isOpen: r.is_open as boolean,
    resolvedAt: (r.resolved_at as string | null) ?? null,
    superseded: r.superseded as boolean,
    effectiveLevel: (r.effective_level as number | null) ?? null,
    reviewReasons: (r.review_reasons as string[] | null) ?? null,
  }));
}

// The badge counts what still needs attention: unread AND open. Resolved or
// superseded items (e.g. an acute-stop notice replaced by its classified
// episode event) stay in the inbox as history but do not inflate the badge.
export async function getUnreadSafetyCount(userId: string): Promise<number> {
  try {
    return (await getSafetyInbox(userId)).filter((i) => !i.readAt && i.isOpen).length;
  } catch {
    return 0; // the badge is a convenience; the inbox page reports failures
  }
}

export type SafetyOpenTarget =
  | { kind: "patient_safety"; patientId: string; episodeId: string }
  | { kind: "patient_session"; patientId: string; sessionId: string }
  | { kind: "assign_clinician" }
  | { kind: "not_found" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Opens the recipient's own notification. read_at is recorded only when
// mutations are allowed (never in maintenance) — reading is not review.
export async function openSafetyNotification(recipientId: string, userId: string): Promise<SafetyOpenTarget> {
  if (!UUID_RE.test(recipientId)) return { kind: "not_found" };
  const admin = createServiceRoleClient();
  const { data, error } = await admin.rpc("safety_notification_open", {
    p_recipient_id: recipientId, p_user_id: userId, p_mark_read: isMutationAllowed(),
  });
  if (error) throw new Error(`safety_notification_open failed: ${error.message}`);
  const r = (data ?? {}) as Row;
  if (r.result !== "ok") return { kind: "not_found" };
  if (r.destination === "patient_safety") return { kind: "patient_safety", patientId: r.patient_id as string, episodeId: r.episode_id as string };
  if (r.destination === "patient_session") return { kind: "patient_session", patientId: r.patient_id as string, sessionId: r.session_id as string };
  return { kind: "assign_clinician" };
}

// Fallback clinician_admin only: where the EXISTING M2 assignment surface
// should open (the recipient row's organization + the patient). Grants
// nothing — /admin/assignments and its server actions keep their own M2
// authorization (clinician_admin / super_user of that organization).
export async function getFallbackAssignmentTarget(recipientId: string, userId: string): Promise<{ organizationId: string; patientId: string } | null> {
  if (!UUID_RE.test(recipientId)) return null;
  const item = (await getSafetyInbox(userId)).find((i) => i.recipientId === recipientId && i.basis === "fallback_clinician_admin");
  if (!item) return null;
  const admin = createServiceRoleClient();
  const { data, error } = await admin.from("safety_notification_recipients").select("organization_id")
    .eq("id", recipientId).eq("recipient_user_id", userId).eq("basis", "fallback_clinician_admin").maybeSingle();
  if (error || !data) return null;
  return { organizationId: data.organization_id as string, patientId: item.patientId };
}

// ---------------------------------------------------------------- health
// Super-user operational surface: counts, ages, codes and opaque ids only.
export type SafetyHealth = {
  view: Row | null;
  pendingOver5Minutes: number;
  urgentUnacceptedOver15Minutes: number;
  failedPermanentByTier: Record<string, number>;
  outboxByStatus: Record<string, number>;
  recipientResolutionFailures: number;
  repairedByHook: number;
  eventsDetectedBySweep: number;
  orphanReconciliations: number;
  openAlerts: { kind: string; subject: string; code: string | null; firstDetectedAt: string; lastDetectedAt: string; occurrences: number }[];
};

export async function getSafetyHealth(): Promise<SafetyHealth> {
  const admin = createServiceRoleClient();
  const now = Date.now();
  const [view, outbox, events, notices, alerts] = await Promise.all([
    admin.from("safety_notification_health").select("*").maybeSingle(),
    admin.from("safety_email_outbox").select("status, tier, created_at, provider_accepted_at"),
    admin.from("safety_notification_events").select("recipient_resolution, detected_by"),
    admin.from("safety_acute_stop_notices").select("recipient_resolution"),
    admin.from("safety_notification_alerts").select("kind, subject_key, detail_code, first_detected_at, last_detected_at, occurrences, cleared_at"),
  ]);
  for (const r of [view, outbox, events, notices, alerts]) if (r.error) throw new Error(`safety health read failed: ${r.error.message}`);
  const ob = (outbox.data ?? []) as Row[];
  const inFlight = (s: unknown) => s === "pending" || s === "retry_scheduled" || s === "claimed";
  const age = (t: unknown) => now - new Date(t as string).getTime();
  const byStatus: Record<string, number> = {};
  const failedByTier: Record<string, number> = {};
  for (const o of ob) {
    byStatus[o.status as string] = (byStatus[o.status as string] ?? 0) + 1;
    if (o.status === "failed_permanent") failedByTier[o.tier as string] = (failedByTier[o.tier as string] ?? 0) + 1;
  }
  const al = (alerts.data ?? []) as Row[];
  const failedRes = (r: Row) => String(r.recipient_resolution).startsWith("failed_") || r.recipient_resolution === "no_eligible_recipients";
  return {
    view: (view.data as Row | null) ?? null,
    pendingOver5Minutes: ob.filter((o) => inFlight(o.status) && age(o.created_at) > 5 * 60_000).length,
    urgentUnacceptedOver15Minutes: ob.filter((o) => o.tier === "urgent_clinician_review" && !o.provider_accepted_at
      && !String(o.status).startsWith("suppressed_") && age(o.created_at) > 15 * 60_000).length,
    failedPermanentByTier: failedByTier,
    outboxByStatus: byStatus,
    recipientResolutionFailures: ((events.data ?? []) as Row[]).filter(failedRes).length + ((notices.data ?? []) as Row[]).filter(failedRes).length,
    repairedByHook: al.filter((a) => a.kind === "notification_hook_failed" && a.cleared_at).length,
    eventsDetectedBySweep: ((events.data ?? []) as Row[]).filter((e) => e.detected_by === "sweep").length,
    orphanReconciliations: al.filter((a) => a.kind === "orphan_fact_reconciled").length,
    openAlerts: al.filter((a) => !a.cleared_at).map((a) => ({
      kind: a.kind as string, subject: a.subject_key as string, code: (a.detail_code as string | null) ?? null,
      firstDetectedAt: a.first_detected_at as string, lastDetectedAt: a.last_detected_at as string, occurrences: a.occurrences as number,
    })),
  };
}
