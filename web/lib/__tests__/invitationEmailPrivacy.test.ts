// M3.4d — application email privacy boundary, bounded invitation delivery,
// and the production sending-domain registry (founder decisions).
//
//   - The patient invitation names only the organization and carries the
//     link: no clinician identity, and no care / rehabilitation / treatment,
//     diagnosis, injury, pain, prescription or other clinical wording.
//   - The development-only tester invitation carries no condition wording.
//   - The invitation Resend call is bounded (15 s); a hung call is "not sent".
//   - notify.tenotrainer.com is the registered production sending domain:
//     production accepts it as the sender; development refuses it as sender
//     and as recipient.
//
// Run (server-only module graph):
//   node --conditions=react-server --experimental-strip-types <ts hooks runner> lib/__tests__/invitationEmailPrivacy.test.ts
import { buildPatientInvitationEmail, invitationHtml, invitationText, INVITATION_DELIVERY_TIMEOUT_MS, withDeliveryTimeout } from "../email";
import { ConfigError, validateConfig } from "../config/parse";
import { RESOURCE_IDENTITY } from "../config/identity";

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

// Clinical / care wording that must never appear in a patient invitation.
const FORBIDDEN = [
  /achilles/i, /tendin/i, /tendon/i, /rehab/i, /injur/i, /\bpain/i, /prescri/i, /diagnos/i, /treatment/i, /therap/i,
  /clinician/i, /physio/i, /\bprogram/i, /exercise/i, /recovery/i, /\bcare\b/i, /condition/i, /symptom/i, /health/i, /patient/i,
];
const scan = (s: string) => FORBIDDEN.filter((re) => re.test(s)).map(String);

const ORG = "Northside Group";
const LINK = "https://app.tenotrainer.com/invite/accept?token=abc123";
const TO = "invitee@example.com";

await test("patient invitation: exact approved content — invited by the organization, with the link", () => {
  const m = buildPatientInvitationEmail({ to: TO, inviteUrl: LINK, orgName: ORG });
  assert(m.subject === "Your TenoTrainer invitation", m.subject);
  assert(m.text.startsWith(`You've been invited to TenoTrainer by ${ORG}.`), m.text);
  assert(m.text.includes(`Accept your invitation:\n${LINK}`), "link in text");
  assert(m.html.includes(`invited to TenoTrainer by <strong>${ORG}</strong>`), "org in html");
  assert(m.html.includes(`href="${LINK}"`), "link in html");
});
await test("patient invitation: no clinical / care / clinician wording in subject, text or html", () => {
  const m = buildPatientInvitationEmail({ to: TO, inviteUrl: LINK, orgName: ORG });
  const hits = [...scan(m.subject), ...scan(m.text), ...scan(m.html)];
  assert(hits.length === 0, `forbidden wording: ${hits.join(", ")}`);
});
await test("patient invitation: a clinician name passed by a caller can never appear", () => {
  const m = buildPatientInvitationEmail({ to: TO, inviteUrl: LINK, orgName: ORG, clinicianName: "Dr Zelda Quorum" } as never);
  assert(!/Zelda|Quorum/.test(m.text + m.html + m.subject), "clinician name leaked");
});
await test("patient invitation: the organization name is HTML-escaped", () => {
  const m = buildPatientInvitationEmail({ to: TO, inviteUrl: LINK, orgName: `A & B <script>alert(1)</script>` });
  assert(m.html.includes("A &amp; B &lt;script&gt;alert(1)&lt;/script&gt;") && !m.html.includes("<script>"), "escaping");
});
await test("tester invitation (development-only): no condition or rehabilitation wording", () => {
  const o = { inviteUrl: LINK, orgName: ORG, humanRole: "TenoTrainer User Tester", recipientEmail: TO };
  const hits = [/achilles/i, /tendin/i, /rehab/i, /injur/i, /\bpain/i, /diagnos/i].filter((re) => re.test(invitationHtml(o) + invitationText(o))).map(String);
  assert(hits.length === 0, `forbidden wording: ${hits.join(", ")}`);
});

await test("invitation delivery is bounded at 15 s", () => {
  assert(INVITATION_DELIVERY_TIMEOUT_MS === 15000, String(INVITATION_DELIVERY_TIMEOUT_MS));
});
await test("withDeliveryTimeout: a hung call resolves to 'timeout' (and the timer is cleared)", async () => {
  const t0 = Date.now();
  const r = await withDeliveryTimeout(new Promise<never>(() => {}), 50);
  assert(r === "timeout" && Date.now() - t0 < 1000, String(r));
});
await test("withDeliveryTimeout: a prompt result passes through unchanged", async () => {
  const r = await withDeliveryTimeout(Promise.resolve({ error: null }), 1000);
  assert(r !== "timeout" && r.error === null, JSON.stringify(r));
});
await test("withDeliveryTimeout: a provider rejection still propagates to the caller's catch", async () => {
  let caught = false;
  try { await withDeliveryTimeout(Promise.reject(new Error("network")), 1000); } catch { caught = true; }
  assert(caught, "rejection swallowed");
});

// ---------------------------------------------------------------- registry boundary
type Env = Record<string, string | undefined>;
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ iss: "supabase", ...claims })}.sig`;
const DEV_REF = "kpdxlzqtvueiytwjamiw";
const PROD_REF = "abcdefghijklmnopqrst";
const sb = (ref: string) => ({ SUPABASE_URL: `https://${ref}.supabase.co`, TENOTRAINER_SUPABASE_PROJECT_REF: ref, SUPABASE_ANON_KEY: jwt({ role: "anon", ref }), SUPABASE_SERVICE_ROLE_KEY: jwt({ role: "service_role", ref }) });
const problems = (env: Env) => { try { validateConfig(env); return []; } catch (e) { if (e instanceof ConfigError) return e.problems; throw e; } };
const PROD: Env = { VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production", TENOTRAINER_MODE: "production", TENOTRAINER_APP_ORIGIN: "https://app.tenotrainer-verify.org", ...sb(PROD_REF),
  TENOTRAINER_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_placeholder_not_a_key", TENOTRAINER_NOTIFICATION_EMAIL_FROM: "TenoTrainer <no-reply@notify.tenotrainer.com>", SAFETY_DISPATCH_SECRET: "m34d-dispatch-secret-0123456789abcdef-xyz" };
const DEV: Env = { TENOTRAINER_MODE: "development", TENOTRAINER_APP_ORIGIN: "http://localhost:3000", ...sb(DEV_REF), TENOTRAINER_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_placeholder_not_a_key",
  TENOTRAINER_NOTIFICATION_EMAIL_FROM: "TenoTrainer <x@dev-mail.tenotrainer.test>", TENOTRAINER_DEV_EMAIL_RECIPIENTS: "dev@example.com" };

await test("registry: notify.tenotrainer.com is the registered production sending domain", () => {
  assert(RESOURCE_IDENTITY.productionEmailDomains.includes("notify.tenotrainer.com"), JSON.stringify(RESOURCE_IDENTITY.productionEmailDomains));
});
await test("production accepts the approved sender TenoTrainer <no-reply@notify.tenotrainer.com>", () => {
  const p = problems(PROD);
  assert(p.length === 0, JSON.stringify(p));
});
await test("development refuses the production sending domain as sender", () => {
  const p = problems({ ...DEV, TENOTRAINER_NOTIFICATION_EMAIL_FROM: "TenoTrainer <no-reply@notify.tenotrainer.com>" });
  assert(p.some((x) => x.includes("TENOTRAINER_NOTIFICATION_EMAIL_FROM")), JSON.stringify(p));
});
await test("development refuses a production-domain recipient in the allow-list", () => {
  const p = problems({ ...DEV, TENOTRAINER_DEV_EMAIL_RECIPIENTS: "someone@notify.tenotrainer.com" });
  assert(p.some((x) => x.includes("registered production email domain is refused")), JSON.stringify(p));
});
await test("a Vercel Preview (development mode) cannot send as the production domain either", () => {
  const p = problems({ ...DEV, VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production", TENOTRAINER_NOTIFICATION_EMAIL_FROM: "TenoTrainer <no-reply@notify.tenotrainer.com>" });
  assert(p.some((x) => x.includes("TENOTRAINER_NOTIFICATION_EMAIL_FROM")), JSON.stringify(p));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
