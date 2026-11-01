// M3.3 S3c — the ONE application email delivery policy. Every application
// email (patient / tester invitations and clinician safety notifications)
// asks this, and only this, whether a message may reach the network. A
// Resend API key existing is never, by itself, permission to send.
//
//   disabled  -> never sent (the development default)
//   fake      -> never reaches the network (test double / no delivery)
//   resend    -> production / maintenance: sent; development: sent ONLY to
//                an address that is EXACTLY (after the one normalization)
//                in TENOTRAINER_DEV_EMAIL_RECIPIENTS — no wildcard, suffix,
//                substring, pattern or same-domain matching.
//
// Pure (configuration in, decision out): no secrets, no I/O.
import type { AppConfig } from "./config/types";
import { normalizeEmailAddress } from "./config/parse";

export type EmailDeliveryCode =
  | "email_disabled"
  | "email_fake_provider"
  | "email_suppressed_development_recipient";

export type EmailDeliveryDecision = { deliver: true } | { deliver: false; code: EmailDeliveryCode };

export function emailDeliveryDecision(config: AppConfig, recipient: string): EmailDeliveryDecision {
  const { provider } = config.email;
  if (provider === "disabled") return { deliver: false, code: "email_disabled" };
  if (provider === "fake") return { deliver: false, code: "email_fake_provider" };
  if (config.mode !== "development") return { deliver: true };
  const allowed = config.devEmailRecipients ?? [];
  const normalized = normalizeEmailAddress(recipient);
  return normalized !== null && allowed.includes(normalized)
    ? { deliver: true }
    : { deliver: false, code: "email_suppressed_development_recipient" };
}
