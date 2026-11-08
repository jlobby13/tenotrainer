// M3.3 S3c — the one application email delivery policy (lib/emailPolicy.ts)
// and the development post-claim recheck (lib/safetyEmail/containedProvider.ts).
import { emailDeliveryDecision } from "../emailPolicy";
import { ContainedSafetyEmailProvider, DEV_RECIPIENT_NOT_ALLOWLISTED } from "../safetyEmail/containedProvider";
import type { SafetyEmailMessage, SafetyEmailProvider } from "../safetyEmail/provider";
import type { AppConfig } from "../config/types";

let pass = 0;
let fail = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const base = {
  appOrigin: "http://localhost:3000",
  supabase: { url: "https://kpdxlzqtvueiytwjamiw.supabase.co", anonKey: "x", kind: "hosted" as const, ref: "kpdxlzqtvueiytwjamiw" },
  runtimeGate: true, publishGate: false, safetyDispatchConfigured: false, platform: { isDevServer: false, onVercel: false }, warnings: [],
};
const dev = (provider: "disabled" | "fake" | "resend", recipients: string[] | null): AppConfig => ({
  ...base, mode: "development", isolatedTestProfile: false, email: { provider, from: "n@dev-mail.tenotrainer.test" },
  legacyBridge: { fastapiUrl: "http://localhost:8000" }, fakeProvider: { logPath: undefined, scriptPath: undefined }, devEmailRecipients: recipients,
});
const prod = (provider: "disabled" | "fake" | "resend"): AppConfig => ({ ...base, mode: "production", isolatedTestProfile: false, email: { provider, from: "n@x.org" } });
const ALLOWED = "clin.one@example.invalid";
const decide = (c: AppConfig, to: string) => emailDeliveryDecision(c, to);

await test("disabled never delivers (any mode, any recipient)", () => {
  for (const c of [dev("disabled", null), prod("disabled")]) {
    const d = decide(c, ALLOWED);
    assert(!d.deliver && d.code === "email_disabled", JSON.stringify(d));
  }
});
await test("fake never delivers", () => {
  const d = decide(dev("fake", null), ALLOWED);
  assert(!d.deliver && d.code === "email_fake_provider", JSON.stringify(d));
});
await test("production resend delivers (no development allow-list involved)", () => {
  assert(decide(prod("resend"), "anyone@clinic.example").deliver, "prod");
});
await test("development resend: exact allow-listed address delivers (case / surrounding whitespace normalized)", () => {
  const c = dev("resend", [ALLOWED]);
  for (const to of [ALLOWED, "Clin.One@Example.Invalid", "  clin.one@example.invalid "]) assert(decide(c, to).deliver, to);
});
await test("development resend: no fuzzy matching — lookalikes are suppressed", () => {
  const c = dev("resend", [ALLOWED]);
  for (const to of ["clin.one@example.invalid.evil.example", "xclin.one@example.invalid", "clin.on@example.invalid", "clin.one+x@example.invalid",
    "other@example.invalid", "clin.one@sub.example.invalid", "clin.one@example.invalidx", "clin.ｏne@example.invalid", "clin.one​@example.invalid",
    `${ALLOWED},evil@example.com`, `Clin <${ALLOWED}>`, "", "   "]) {
    const d = decide(c, to);
    assert(!d.deliver && d.code === "email_suppressed_development_recipient", `${JSON.stringify(to)} -> ${JSON.stringify(d)}`);
  }
});
await test("development resend with an empty / missing allow-list suppresses everything", () => {
  assert(!decide(dev("resend", []), ALLOWED).deliver && !decide(dev("resend", null), ALLOWED).deliver, "empty");
});

// ---------------------------------------------------------------- contained provider (post-claim recheck)
function countingProvider() {
  const calls: SafetyEmailMessage[] = [];
  const p: SafetyEmailProvider = { name: "resend", async send(m) { calls.push(m); return { kind: "accepted", providerMessageId: "inner-1" }; } };
  return { p, calls };
}
const msg = (to: string): SafetyEmailMessage => ({ to, subject: "s", text: "t", html: "h" });
await test("contained provider: an allowed recipient reaches the inner provider exactly once", async () => {
  const { p, calls } = countingProvider();
  const c = new ContainedSafetyEmailProvider(p, (to) => decide(dev("resend", [ALLOWED]), to).deliver);
  const r = await c.send(msg(ALLOWED), { idempotencyKey: "k" });
  assert(r.kind === "accepted" && calls.length === 1, JSON.stringify(r));
});
await test("contained provider: a non-allowed recipient is a permanent refusal with NO inner provider call", async () => {
  const { p, calls } = countingProvider();
  const c = new ContainedSafetyEmailProvider(p, (to) => decide(dev("resend", [ALLOWED]), to).deliver);
  const r = await c.send(msg("other@example.invalid"), { idempotencyKey: "k" });
  assert(r.kind === "permanent" && r.code === DEV_RECIPIENT_NOT_ALLOWLISTED && calls.length === 0, JSON.stringify(r));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
