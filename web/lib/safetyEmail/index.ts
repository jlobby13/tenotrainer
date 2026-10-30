import "server-only";

// M3.2 — server wiring for safety email delivery: provider selection from
// the validated configuration, and the production dispatch run (scope NULL:
// every eligible due intent). Nothing here is reachable from a browser; the
// only caller is the secret-authenticated internal dispatch route.
import { getServerConfig } from "../env";
import { createServiceRoleClient } from "../supabase/server";
import { dispatchSafetyEmails, type ClaimRow, type DispatchSummary } from "./dispatcher";
import { FakeSafetyEmailProvider } from "./fakeProvider";
import type { SafetyEmailProvider } from "./provider";
import { ResendSafetyEmailProvider } from "./resendProvider";
import { buildSafetyEmail, notificationLink } from "./template";

export function selectSafetyEmailProvider(): SafetyEmailProvider | null {
  const config = getServerConfig();
  if (config.safetyEmailProvider === "fake") {
    // envValidation already refuses "fake" outside development; this is the
    // second, independent refusal.
    if (config.mode !== "development") return null;
    return new FakeSafetyEmailProvider({
      mode: config.mode,
      logPath: process.env.SAFETY_FAKE_PROVIDER_LOG || undefined,
      scriptPath: process.env.SAFETY_FAKE_PROVIDER_SCRIPT || undefined,
    });
  }
  if (config.safetyEmailProvider === "resend") {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM;
    if (!apiKey || !from) return null;
    return new ResendSafetyEmailProvider(apiKey, from);
  }
  return null; // dispatch disabled (development default)
}

export function structuredLog(line: Record<string, unknown>): void {
  // Codes, counts and opaque ids only — never addresses, names or PHI.
  console.info(JSON.stringify({ at: new Date().toISOString(), ...line }));
}

export type DispatchRunResult =
  | { ok: true; provider: string; summary: DispatchSummary }
  | { ok: false; reason: "provider_not_configured" | "dispatch_failed" };

export async function runSafetyDispatch(): Promise<DispatchRunResult> {
  const provider = selectSafetyEmailProvider();
  const admin = createServiceRoleClient();
  const heartbeat = (ok: boolean, code: string | null, summary: unknown) =>
    admin.rpc("safety_email_dispatch_heartbeat", { p_ok: ok, p_error_code: code, p_summary: summary ?? null });
  if (!provider) {
    structuredLog({ event: "tenotrainer.safety_dispatch.disabled" });
    return { ok: false, reason: "provider_not_configured" };
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  try {
    const summary = await dispatchSafetyEmails({
      rpc: async (fn, args) => {
        const { data, error } = await admin.rpc(fn, args);
        return { data, error: error ? { message: error.message } : null };
      },
      provider,
      scope: null, // production: every eligible due intent — never caller-scoped
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
