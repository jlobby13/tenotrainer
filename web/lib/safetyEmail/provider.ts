// M3.2 — the safety email provider boundary. A provider only reports what
// the provider said about one request; it never claims delivery or reading.
//
//   accepted    — the provider accepted the request (NOT inbox delivery)
//   permanent   — the provider refused it; retrying cannot help
//   transient   — a temporary failure; retry with the SAME idempotency key
//   ambiguous   — no answer (timeout / connection lost after sending): the
//                 provider may or may not have accepted it; retry with the
//                 SAME key so the provider can deduplicate
//
// `code` is a short [a-z0-9_] code — never provider free text or PHI.
// No imports: the dispatcher core and its tests load this without Next.

export type SafetyEmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export type SafetyEmailSendResult =
  | { kind: "accepted"; providerMessageId: string; httpStatus?: number }
  | { kind: "permanent" | "transient" | "ambiguous"; code: string; httpStatus?: number };

export interface SafetyEmailProvider {
  readonly name: "resend" | "fake";
  send(message: SafetyEmailMessage, options: { idempotencyKey: string }): Promise<SafetyEmailSendResult>;
}

export function errorCode(raw: unknown, fallback: string): string {
  const s = String(raw ?? "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  return s.length > 0 ? s : fallback;
}
