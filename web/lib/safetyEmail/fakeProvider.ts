// M3.2 — development/test double for the safety email provider. It never
// touches the network. Refused at startup outside development
// (envValidation: SAFETY_EMAIL_PROVIDER "fake" is forbidden in production /
// maintenance) and refuses to construct outside development as well.
//
// Behaviour:
//   * Idempotent like the real provider: the same idempotency key always
//     returns the same provider message id, and a repeated key is recorded
//     as a duplicate (never a second logical email).
//   * Scriptable: `script(key, attempt)` returns the outcome for a call, or
//     a file named by SAFETY_FAKE_PROVIDER_SCRIPT maps outbox ids to an
//     outcome sequence (["transient", "accepted"], ...).
//   * Observable: every call can be appended (JSON lines) to the file named
//     by SAFETY_FAKE_PROVIDER_LOG — key, attempt, outcome, recipient domain.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { SafetyEmailMessage, SafetyEmailProvider, SafetyEmailSendResult } from "./provider";

export type FakeOutcome = "accepted" | "permanent" | "transient" | "ambiguous" | "hang";
export type FakeScript = (idempotencyKey: string, attempt: number) => FakeOutcome;

export class FakeSafetyEmailProvider implements SafetyEmailProvider {
  readonly name = "fake" as const;
  readonly calls: { idempotencyKey: string; to: string; subject: string; outcome: FakeOutcome; duplicate: boolean }[] = [];
  private readonly accepted = new Map<string, string>();
  private readonly attempts = new Map<string, number>();

  private readonly opts: { mode: string; script?: FakeScript; logPath?: string; scriptPath?: string; hangMs?: number };

  constructor(opts: { mode: string; script?: FakeScript; logPath?: string; scriptPath?: string; hangMs?: number }) {
    if (opts.mode !== "development") throw new Error("FakeSafetyEmailProvider is development-only");
    this.opts = opts;
  }

  static messageIdFor(idempotencyKey: string): string {
    return `fake_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
  }

  private scripted(key: string, attempt: number): FakeOutcome {
    if (this.opts.script) return this.opts.script(key, attempt);
    if (this.opts.scriptPath && existsSync(this.opts.scriptPath)) {
      const outbox = key.split("/")[1] ?? "";
      const plan = (JSON.parse(readFileSync(this.opts.scriptPath, "utf8")) as Record<string, FakeOutcome[]>)[outbox];
      if (plan && plan.length > 0) return plan[Math.min(attempt, plan.length) - 1];
    }
    return "accepted";
  }

  async send(message: SafetyEmailMessage, { idempotencyKey }: { idempotencyKey: string }): Promise<SafetyEmailSendResult> {
    const attempt = (this.attempts.get(idempotencyKey) ?? 0) + 1;
    this.attempts.set(idempotencyKey, attempt);
    const outcome = this.scripted(idempotencyKey, attempt);
    const duplicate = this.accepted.has(idempotencyKey);
    this.calls.push({ idempotencyKey, to: message.to, subject: message.subject, outcome, duplicate });
    if (this.opts.logPath) {
      appendFileSync(this.opts.logPath, JSON.stringify({
        at: new Date().toISOString(), idempotencyKey, attempt, outcome, duplicate,
        recipientDomain: message.to.split("@")[1] ?? "", subject: message.subject,
      }) + "\n");
    }
    if (outcome === "hang") await new Promise((r) => setTimeout(r, this.opts.hangMs ?? 60000));
    switch (outcome) {
      case "accepted":
      case "hang": {
        // Provider-side idempotency: the same key yields the same message id.
        const id = this.accepted.get(idempotencyKey) ?? FakeSafetyEmailProvider.messageIdFor(idempotencyKey);
        this.accepted.set(idempotencyKey, id);
        return { kind: "accepted", providerMessageId: id, httpStatus: 200 };
      }
      case "permanent":
        return { kind: "permanent", code: "fake_invalid_recipient", httpStatus: 422 };
      case "transient":
        return { kind: "transient", code: "fake_provider_unavailable", httpStatus: 503 };
      case "ambiguous":
        // The fake "accepted" it but the answer was lost — exactly the
        // ambiguous case; a retry with the same key returns the same id.
        this.accepted.set(idempotencyKey, this.accepted.get(idempotencyKey) ?? FakeSafetyEmailProvider.messageIdFor(idempotencyKey));
        return { kind: "ambiguous", code: "fake_timeout" };
    }
  }
}
