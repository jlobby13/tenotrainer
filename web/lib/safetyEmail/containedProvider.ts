// M3.3 S3c — development containment around the real safety email
// provider: the post-claim recheck. Every claimed message is checked again
// against the application email policy immediately before the provider is
// called; a recipient that is not (or no longer) allowed is refused as a
// permanent result WITHOUT any provider / network call (recorded as
// rejected_permanent / dev_recipient_not_allowlisted — an existing outcome,
// no schema change). Used only in development (see safetyEmail/index.ts).
//
// No runtime imports: the worker tests load this exact code.
import type { SafetyEmailMessage, SafetyEmailProvider, SafetyEmailSendResult } from "./provider";

export const DEV_RECIPIENT_NOT_ALLOWLISTED = "dev_recipient_not_allowlisted";

export class ContainedSafetyEmailProvider implements SafetyEmailProvider {
  readonly name: "resend" | "fake";
  private readonly inner: SafetyEmailProvider;
  private readonly allowed: (recipient: string) => boolean;

  constructor(inner: SafetyEmailProvider, allowed: (recipient: string) => boolean) {
    this.inner = inner;
    this.allowed = allowed;
    this.name = inner.name;
  }

  async send(message: SafetyEmailMessage, options: { idempotencyKey: string }): Promise<SafetyEmailSendResult> {
    if (!this.allowed(message.to)) return { kind: "permanent", code: DEV_RECIPIENT_NOT_ALLOWLISTED };
    return this.inner.send(message, options);
  }
}
