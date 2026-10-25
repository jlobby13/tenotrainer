import "server-only";

// M1 — explicit clinician release of a professional-review training hold.
//
// Authorization: verifyHighConsequenceAuthorization — the same check as
// publish/pause/resume. Since M2 it is the native Postgres assignment
// authority only (no FastAPI/SQLite dependency); it fails closed.
//
// The release itself is clinician_release_acute_episode (server-only), which
// re-checks the active Postgres assignment, enforces the required note,
// refuses an episode that doesn't require a clinician release, records the
// clinician and database time, and is idempotent. The release guard trigger
// independently refuses any non-clinician release of such a hold.

import { createServiceRoleClient } from "./supabase/server";
import { verifyHighConsequenceAuthorization } from "./prescriptionDraftAuth";
import { PrescriptionDraftError } from "./prescriptionDraftErrors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ClinicianReleaseResult = { status: number; body: Record<string, unknown> };

export async function releaseAcuteEpisodeAsClinician(params: {
  clinicianId: string;
  patientId: string;
  episodeId: string;
  note: string;
}): Promise<ClinicianReleaseResult> {
  const { clinicianId, patientId, episodeId } = params;
  if (!UUID_RE.test(patientId) || !UUID_RE.test(episodeId)) return { status: 404, body: { result: "episode_not_found" } };

  try {
    await verifyHighConsequenceAuthorization(clinicianId, patientId);
  } catch (err) {
    if (err instanceof PrescriptionDraftError) return { status: 404, body: { result: "not_authorized" } };
    throw err;
  }

  const admin = createServiceRoleClient();
  // The episode must belong to the patient that was just authorized.
  const { data: ep, error } = await admin.from("acute_safety_episodes").select("id").eq("id", episodeId).eq("user_id", patientId).maybeSingle();
  if (error) throw new Error(`releaseAcuteEpisodeAsClinician failed: ${error.message}`);
  if (!ep) return { status: 404, body: { result: "episode_not_found" } };

  const { data, error: rpcError } = await admin.rpc("clinician_release_acute_episode", {
    p_episode_id: episodeId,
    p_clinician_id: clinicianId,
    p_note: params.note,
  });
  if (rpcError) {
    console.error("clinician_release_acute_episode failed", rpcError.message);
    return { status: 500, body: { result: "internal_error" } };
  }
  const body = (data ?? {}) as Record<string, unknown>;
  const status =
    body.result === "released" || body.result === "already_released"
      ? 200
      : body.result === "invalid_note"
        ? 400
        : body.result === "clinician_release_not_required"
          ? 409
          : 404;
  return { status, body };
}
