import "server-only";

// M3.2 — server wiring for safety email delivery: provider selection from
// the validated configuration, and the production dispatch run (scope NULL:
// every eligible due intent). Nothing here is reachable from a browser; the
// only caller is the secret-authenticated internal dispatch route.
import { getAppOrigin, getConfig } from "../config";
import { getResendApiKey } from "../config/secrets";
import { emailDeliveryDecision } from "../emailPolicy";
import { ContainedSafetyEmailProvider } from "./containedProvider";
import { createServiceRoleClient } from "../supabase/server";
import { dispatchSafetyEmails, type ClaimRow, type DispatchSummary } from "./dispatcher";
import { FakeSafetyEmailProvider } from "./fakeProvider";
import type { SafetyEmailProvider } from "./provider";
import { ResendSafetyEmailProvider } from "./resendProvider";
import { buildSafetyEmail, notificationLink } from "./template";

export function selectSafetyEmailProvider(): SafetyEmailProvider | null {
  const config = getConfig();
  if (config.email.provider === "fake") {
    // The configuration contract already refuses "fake" outside development;
    // this is the second, independent refusal.
    if (config.mode !== "development") return null;
    return new FakeSafetyEmailProvider({
      mode: config.mode,
      logPath: config.fakeProvider.logPath,
      scriptPath: config.fakeProvider.scriptPath,
    });
  }
  if (config.email.provider === "resend") {
    const apiKey = getResendApiKey();
    const from = config.email.from;
    if (!apiKey || !from) return null;
    const resend = new ResendSafetyEmailProvider(apiKey, from);
    // M3.3 S3c — development: the post-claim recheck against the exact
    // recipient allow-list, immediately before any provider call.
    // Production / maintenance use the provider unchanged.
    if (config.mode !== "development") return resend;
    return new ContainedSafetyEmailProvider(resend, (to) => emailDeliveryDecision(config, to).deliver);
  }
  return null; // dispatch disabled (development default)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEV_DISPATCH_MAX_IDS = 50;

// M3.3 S3c — development Resend dispatch never claims the open queue: the
// caller names the outbox ids, and only those whose recipient address is
// EXACTLY allow-listed are passed to the existing scoped claim. Returns the
// claim scope (possibly empty), or null when the request is invalid.
async function developmentResendScope(requested: unknown, admin: ReturnType<typeof createServiceRoleClient>): Promise<string[] | null> {
  if (!Array.isArray(requested) || requested.length === 0 || requested.length > DEV_DISPATCH_MAX_IDS) return null;
  if (!requested.every((id) => typeof id === "string" && UUID_RE.test(id))) return null;
  const ids = [...new Set((requested as string[]).map((id) => id.toLowerCase()))];
  const config = getConfig();
  const { data: outbox, error } = await admin.from("safety_email_outbox").select("id, recipient_id").in("id", ids);
  if (error) throw new Error("outbox lookup failed");
  const recipientIds = [...new Set((outbox ?? []).map((o) => o.recipient_id as string))];
  const { data: recipients, error: rErr } = recipientIds.length
    ? await admin.from("safety_notification_recipients").select("id, recipient_user_id").in("id", recipientIds)
    : { data: [], error: null };
  if (rErr) throw new Error("recipient lookup failed");
  const allowed: string[] = [];
  for (const o of outbox ?? []) {
    const r = (recipients ?? []).find((x) => x.id === o.recipient_id);
    if (!r) continue;
    const { data: u } = await admin.auth.admin.getUserById(r.recipient_user_id as string);
    const email = u?.user?.email ?? "";
    if (email && emailDeliveryDecision(config, email).deliver) allowed.push(o.id as string);
  }
  return allowed;
}

export function structuredLog(line: Record<string, unknown>): void {
  // Codes, counts and opaque ids only — never addresses, names or PHI.
  console.info(JSON.stringify({ at: new Date().toISOString(), ...line }));
}

export type DispatchRunResult =
  | { ok: true; provider: string; summary: DispatchSummary }
  | { ok: false; reason: "provider_not_configured" | "dispatch_failed" | "development_scope_required" };

// `request.outboxIds` is read ONLY for development Resend dispatch;
// production / maintenance always dispatch every eligible due intent
// (scope NULL) and ignore any caller input.
export async function runSafetyDispatch(request: { outboxIds?: unknown } = {}): Promise<DispatchRunResult> {
  const provider = selectSafetyEmailProvider();
  const admin = createServiceRoleClient();
  const config = getConfig();
  const heartbeat = (ok: boolean, code: string | null, summary: unknown) =>
    admin.rpc("safety_email_dispatch_heartbeat", { p_ok: ok, p_error_code: code, p_summary: summary ?? null });
  if (!provider) {
    structuredLog({ event: "tenotrainer.safety_dispatch.disabled" });
    return { ok: false, reason: "provider_not_configured" };
  }
  const appUrl = getAppOrigin(); // M3.3 S3 — configured canonical origin
  let scope: string[] | null = null; // production: every eligible due intent — never caller-scoped
  if (config.mode === "development" && config.email.provider === "resend") {
    const devScope = await developmentResendScope(request.outboxIds, admin).catch(() => undefined);
    if (devScope === undefined) {
      structuredLog({ event: "tenotrainer.safety_dispatch.failed" });
      return { ok: false, reason: "dispatch_failed" };
    }
    if (devScope === null) {
      structuredLog({ event: "tenotrainer.safety_dispatch.development_scope_required" });
      return { ok: false, reason: "development_scope_required" };
    }
    scope = devScope;
  }
  try {
    const summary = await dispatchSafetyEmails({
      rpc: async (fn, args) => {
        const { data, error } = await admin.rpc(fn, args);
        return { data, error: error ? { message: error.message } : null };
      },
      provider,
      scope,
      render: (c: ClaimRow) => buildSafetyEmail({
        to: c.recipient_email, tier: c.tier, organizationName: c.organization_name, link: notificationLink(appUrl, c.recipient_id),
      }),
      log: structuredLog,
    });
    await heartbeat(true, null, summary);
    structuredLog({ event: "tenotrainer.safety_dispatch.run", provider: provider.name, ...summary });
    return { ok: true, provider: provider.name, summary };
  } catch {
    await heartbeat(false, "dispatch_failed", null);
    structuredLog({ event: "tenotrainer.safety_dispatch.failed" });
    return { ok: false, reason: "dispatch_failed" };
  }
}
