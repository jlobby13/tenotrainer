// M3.2 — Resend implementation of the safety email provider. The stable
// outbox idempotency key is sent as Resend's Idempotency-Key, so a retry of
// the same intent (after a timeout or a crash) is deduplicated by the
// provider within its idempotency window. Production Resend / sender-domain
// configuration is M3.4.
import { Resend } from "resend";
import { errorCode, type SafetyEmailMessage, type SafetyEmailProvider, type SafetyEmailSendResult } from "./provider";

// Resend error names that are worth retrying with the same key; any other
// provider refusal is permanent (bad recipient, sender, key, payload).
const TRANSIENT = new Set([
  "rate_limit_exceeded", "daily_quota_exceeded", "internal_server_error", "application_error",
  "concurrent_idempotent_requests", "service_unavailable",
]);

export class ResendSafetyEmailProvider implements SafetyEmailProvider {
  readonly name = "resend" as const;
  private readonly client: Resend;

  constructor(apiKey: string, private readonly from: string, private readonly timeoutMs = 15000) {
    this.client = new Resend(apiKey);
  }

  async send(message: SafetyEmailMessage, { idempotencyKey }: { idempotencyKey: string }): Promise<SafetyEmailSendResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), this.timeoutMs); });
    try {
      const outcome = await Promise.race([
        this.client.emails.send(
          { from: this.from, to: message.to, subject: message.subject, text: message.text, html: message.html },
          { idempotencyKey },
        ),
        timeout,
      ]);
      // No answer in time: the request may have been accepted. Ambiguous.
      if (outcome === "timeout") return { kind: "ambiguous", code: "provider_timeout" };
      const { data, error } = outcome;
      if (error) {
        const code = errorCode((error as { name?: string }).name, "provider_error");
        const httpStatus = (error as { statusCode?: number }).statusCode ?? undefined;
        if (TRANSIENT.has(code) || (httpStatus !== undefined && httpStatus >= 500)) return { kind: "transient", code, httpStatus };
        return { kind: "permanent", code, httpStatus };
      }
      if (!data?.id) return { kind: "ambiguous", code: "provider_no_message_id" };
      return { kind: "accepted", providerMessageId: data.id };
    } catch {
      // A thrown network error may happen after the request reached the provider.
      return { kind: "ambiguous", code: "provider_network_error" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
