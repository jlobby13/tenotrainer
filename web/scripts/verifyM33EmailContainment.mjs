// M3.3 S3c — unified email-provider contract and development email
// containment, proven at the TRANSPORT: every process here runs with the
// test-only Resend interceptor (scripts/lib/resendInterceptor.mjs), which
// answers api.resend.com locally and records each attempted provider call.
// No test needs, or can make, a real internet email request.
//
//   A. real modules in-process: invitation + safety delivery by provider /
//      mode, the post-claim recheck — counted Resend transport calls.
//   B. a spawned development server with the resend provider and a
//      dedicated exact-id fixture (two pending intents; never the preserved
//      L5): explicit dispatch scope, allow-list intersection, dispatch-secret
//      rotation, invitation delivery through the real UI.
//   C. startup refusals (production / maintenance / development).
//   D. the harness real-email kill switch itself.
//   E. preserved L5 untouched (PRE == POST), fixture residue zero.
//
// Run from web/ (after `next build`):  TENOTRAINER_MODE=development node scripts/verifyM33EmailContainment.mjs
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { FixtureRun, FIXTURE_PASSWORD, guardedSql, loadEnv, q } from "./lib/m32Fixtures.mjs";
import { assertNoRealEmail, RealEmailRefused, RESEND_INTERCEPTOR_IMPORT, withEmailContainment, withoutRetiredNames } from "./lib/harnessEnv.mjs";
import { fakeKeysFor } from "./lib/fakeSupabaseKeys.mjs";

const PORTS = { dev: 3190, refuse: 3191 };
const DEV = `http://localhost:${PORTS.dev}`;
const DISPATCH = "/api/internal/safety-notifications/dispatch";
const L5_OUTBOX = "f73aeb4d-6517-481b-ac6e-cc73fa0afc67";
const DEV_SENDER = "TenoTrainer <notifications@dev-mail.tenotrainer.test>";
const INERT_KEY = "re_s3c_intercepted_inert_key";
const SECRET = `s3c-current-${randomUUID()}-${randomUUID()}`;
const SECRET_NEXT = `s3c-next-${randomUUID()}-${randomUUID()}`;
const REF = "kpdxlzqtvueiytwjamiw";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
const section = (t) => console.log(`\n--- ${t} ---`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = loadEnv(".env.local");
assertDevTestTarget(env);
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const WORK = mkdtempSync(join(tmpdir(), "m33-s3c-"));
const intercepted = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// ================================================================ A (in-process)
// The REAL application modules, in a child process with the interceptor
// preloaded and an explicit configuration. Prints one JSON result line.
const CHILD = `
import { register } from "node:module";
register(new URL("./scripts/lib/tsServerModuleHooks.mjs", "file://" + process.cwd() + "/"));
const sc = JSON.parse(process.env.__SCENARIO);
const out = {};
try {
  const email = await import("./lib/email.ts");
  const safety = await import("./lib/safetyEmail/index.ts");
  const { dispatchSafetyEmails } = await import("./lib/safetyEmail/dispatcher.ts");
  for (const to of sc.invite ?? []) {
    out["patient:" + to] = await email.sendPatientInvitationEmail({ to, inviteUrl: "http://x/invite/accept?token=t", orgName: "Org" });
    out["tester:" + to] = await email.sendInvitationEmail({ to, inviteUrl: "http://x/invite/accept?token=t", orgName: "Org", invitationType: "USER_TESTER" });
  }
  const provider = safety.selectSafetyEmailProvider();
  out.provider = provider ? provider.constructor.name : null;
  for (const to of sc.safety ?? []) out["safety:" + to] = provider ? await provider.send({ to, subject: "s", text: "t", html: "h" }, { idempotencyKey: "k-" + to }) : null;
  if (sc.postClaim) {
    // A claim whose recipient is NOT allow-listed (e.g. changed after the
    // pre-claim intersection): the recheck must refuse before any call.
    const recorded = [];
    const rpc = async (fn, args) => {
      if (fn === "safety_email_claim") return { data: recorded.length ? [] : [{ outbox_id: "00000000-0000-4000-8000-000000000001", claim_token: "00000000-0000-4000-8000-000000000002",
        idempotency_key: "k", attempt_no: 1, tier: "urgent_clinician_review", recipient_id: "r", recipient_email: sc.postClaim, organization_name: "Org" }], error: null };
      recorded.push({ fn, args });
      return { data: { result: "recorded", status: "failed_permanent" }, error: null };
    };
    const summary = await dispatchSafetyEmails({ rpc, provider, render: (c) => ({ to: c.recipient_email, subject: "s", text: "t", html: "h" }), scope: ["00000000-0000-4000-8000-000000000001"], maxBatches: 1 });
    out.postClaim = { summary, recorded: recorded.map((r) => ({ outcome: r.args.p_outcome, code: r.args.p_error_code })) };
  }
} catch (e) { out.error = String(e && e.message || e); }
process.stdout.write(JSON.stringify(out));
`;
function runChild(label, config, scenario) {
  const log = join(WORK, `${label}.jsonl`);
  const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, RESEND_INTERCEPT_LOG: log, __SCENARIO: JSON.stringify(scenario),
    SUPABASE_URL: `https://${REF}.supabase.co`, ...fakeKeysFor(REF), ...config };
  const raw = execFileSync(process.execPath, ["--conditions=react-server", "--experimental-strip-types", RESEND_INTERCEPTOR_IMPORT, "--input-type=module", "-e", CHILD],
    { cwd: process.cwd(), env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { out: JSON.parse(raw), calls: intercepted(log), raw };
}
const DEV_BASE = { TENOTRAINER_MODE: "development", TENOTRAINER_APP_ORIGIN: "http://localhost:3000" };
const ALLOWED = "clin.allowed@example.invalid";
const OTHER = "someone.else@example.invalid";

function partA() {
  section("A. Real modules: delivery by provider / mode, counted at the Resend transport");
  const a1 = runChild("a1", { ...DEV_BASE, TENOTRAINER_EMAIL_PROVIDER: "disabled", RESEND_API_KEY: "re_valid_looking_real_shape_key" }, { invite: [ALLOWED, OTHER], safety: [ALLOWED] });
  check("development + disabled + valid-looking Resend key: invitations not sent (email_disabled)", ["patient", "tester"].every((k) => a1.out[`${k}:${ALLOWED}`]?.reason === "email_disabled" && a1.out[`${k}:${OTHER}`]?.reason === "email_disabled"), JSON.stringify(a1.out));
  check("development + disabled + Resend key: no safety provider at all", a1.out.provider === null);
  check("development + disabled + Resend key: ZERO Resend transport calls", a1.calls.length === 0, String(a1.calls.length));

  const a2 = runChild("a2", { ...DEV_BASE, TENOTRAINER_EMAIL_PROVIDER: "fake", RESEND_API_KEY: "re_valid_looking_real_shape_key" }, { invite: [ALLOWED], safety: [ALLOWED] });
  check("development + fake + Resend key: invitations not sent (email_fake_provider)", a2.out[`patient:${ALLOWED}`]?.reason === "email_fake_provider" && a2.out[`tester:${ALLOWED}`]?.reason === "email_fake_provider", JSON.stringify(a2.out));
  check("development + fake: the safety provider is the fake (accepted locally)", a2.out.provider === "FakeSafetyEmailProvider" && a2.out[`safety:${ALLOWED}`]?.kind === "accepted");
  check("development + fake + Resend key: ZERO Resend transport calls", a2.calls.length === 0, String(a2.calls.length));

  const devResend = { ...DEV_BASE, TENOTRAINER_EMAIL_PROVIDER: "resend", RESEND_API_KEY: INERT_KEY, TENOTRAINER_NOTIFICATION_EMAIL_FROM: DEV_SENDER, TENOTRAINER_DEV_EMAIL_RECIPIENTS: ALLOWED };
  const a3 = runChild("a3", devResend, { invite: [OTHER], safety: [OTHER, `${ALLOWED}.evil.example`, `x${ALLOWED}`] });
  check("development + resend: non-allow-listed invitation recipients suppressed", a3.out[`patient:${OTHER}`]?.reason === "email_suppressed_development_recipient" && a3.out[`tester:${OTHER}`]?.reason === "email_suppressed_development_recipient", JSON.stringify(a3.out));
  check("development + resend: the safety provider is the contained provider", a3.out.provider === "ContainedSafetyEmailProvider");
  check("development + resend: non-allow-listed / lookalike safety recipients refused permanently (dev_recipient_not_allowlisted)",
    [OTHER, `${ALLOWED}.evil.example`, `x${ALLOWED}`].every((to) => a3.out[`safety:${to}`]?.kind === "permanent" && a3.out[`safety:${to}`]?.code === "dev_recipient_not_allowlisted"), JSON.stringify(a3.out));
  check("development + resend: non-allow-listed recipients -> ZERO Resend transport calls", a3.calls.length === 0, String(a3.calls.length));

  const a4 = runChild("a4", devResend, { invite: [ALLOWED.toUpperCase()], safety: [ALLOWED] });
  check("development + resend: exact allow-listed invitation recipient sent (patient + tester)", a4.out[`patient:${ALLOWED.toUpperCase()}`]?.sent === true && a4.out[`tester:${ALLOWED.toUpperCase()}`]?.sent === true, JSON.stringify(a4.out));
  check("development + resend: exact allow-listed safety recipient accepted by the provider", a4.out[`safety:${ALLOWED}`]?.kind === "accepted" && String(a4.out[`safety:${ALLOWED}`]?.providerMessageId).startsWith("intercepted_"));
  check("development + resend: exactly the 3 expected calls, all to the allow-listed address, from the development sender, ONLY via the intercepted transport",
    a4.calls.length === 3 && a4.calls.every((c) => c.intercepted && c.to.length === 1 && c.to[0].toLowerCase() === ALLOWED && c.from === DEV_SENDER && c.path === "/emails"), JSON.stringify(a4.calls));

  const a5 = runChild("a5", devResend, { postClaim: OTHER });
  check("post-claim recheck: a claimed non-allow-listed recipient is recorded rejected_permanent / dev_recipient_not_allowlisted",
    a5.out.postClaim?.recorded?.length === 1 && a5.out.postClaim.recorded[0].outcome === "rejected_permanent" && a5.out.postClaim.recorded[0].code === "dev_recipient_not_allowlisted", JSON.stringify(a5.out));
  check("post-claim recheck: ZERO Resend transport calls", a5.calls.length === 0, String(a5.calls.length));

  const prodIsolated = { TENOTRAINER_MODE: "production", NODE_ENV: "production", TENOTRAINER_APP_ORIGIN: "https://app.tenotrainer.test", TENOTRAINER_SUPABASE_PROJECT_REF: REF,
    TENOTRAINER_EMAIL_PROVIDER: "resend", RESEND_API_KEY: INERT_KEY, TENOTRAINER_NOTIFICATION_EMAIL_FROM: "TenoTrainer <safety@tenotrainer.test>", SAFETY_DISPATCH_SECRET: SECRET };
  const a6 = runChild("a6", prodIsolated, { invite: [OTHER], safety: [OTHER] });
  check("production: the safety provider is the unchanged Resend provider (no development containment)", a6.out.provider === "ResendSafetyEmailProvider", a6.out.provider);
  check("production: delivery goes to the provider transport (intercepted here; no development allow-list involved)",
    a6.out[`patient:${OTHER}`]?.sent === true && a6.out[`safety:${OTHER}`]?.kind === "accepted" && a6.calls.length === 3, `${JSON.stringify(a6.out)} calls=${a6.calls.length}`);
  check("no Resend API key value appears in any intercepted record or child output",
    ![a1, a2, a3, a4, a5, a6].some((r) => r.raw.includes(INERT_KEY) || JSON.stringify(r.calls).includes(INERT_KEY) || r.raw.includes("re_valid_looking")));
}

// ================================================================ B (spawned development server)
const started = [];
function baseServerEnv(overrides) {
  const base = withoutRetiredNames({ ...process.env });
  for (const k of ["FASTAPI_URL", "BRIDGE_SECRET", "TENOTRAINER_APP_ORIGIN", "VERCEL", "VERCEL_ENV", "NODE_OPTIONS"]) delete base[k];
  for (const k of ["TENOTRAINER_MODE", "C5_PATIENT_RUNTIME_ENABLED", "C5_PRESCRIPTION_PUBLISH_ENABLED", "TENOTRAINER_EMAIL_PROVIDER", "SAFETY_DISPATCH_SECRET", "SAFETY_DISPATCH_SECRET_NEXT",
    "RESEND_API_KEY", "TENOTRAINER_NOTIFICATION_EMAIL_FROM", "TENOTRAINER_DEV_EMAIL_RECIPIENTS", "SAFETY_FAKE_PROVIDER_LOG", "SAFETY_FAKE_PROVIDER_SCRIPT", "RESEND_BASE_URL"]) base[k] = "";
  return { ...base, ...overrides };
}
async function listening(port) {
  try { await fetch(`http://127.0.0.1:${port}/login`, { signal: AbortSignal.timeout(2000), redirect: "manual" }); return true; } catch { return false; }
}
function spawnServer(port, overrides, interceptLog) {
  const proc = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
    env: withEmailContainment(baseServerEnv(overrides), { interceptLog }), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const s = { port, proc, pid: proc.pid, log: "", exited: null };
  proc.stdout.on("data", (d) => (s.log += d));
  proc.stderr.on("data", (d) => (s.log += d));
  proc.on("exit", (code) => (s.exited = code ?? -1));
  started.push(s);
  return s;
}
async function startServer(port, overrides, interceptLog) {
  const s = spawnServer(port, overrides, interceptLog);
  for (let i = 0; i < 120; i++) {
    if (s.exited !== null) throw new Error(`server on ${port} exited (${s.exited}):\n${s.log.slice(-1500)}`);
    if (await listening(port)) return s;
    await sleep(500);
  }
  throw new Error(`server on ${port} did not become ready`);
}
async function stopServer(s) {
  if (s.exited !== null) return;
  try { process.kill(-s.pid, "SIGTERM"); } catch { /* gone */ }
  for (let i = 0; i < 40 && s.exited === null; i++) await sleep(250);
  if (s.exited === null) { try { process.kill(-s.pid, "SIGKILL"); } catch { /* gone */ } }
  for (let i = 0; i < 40 && (await listening(s.port)); i++) await sleep(250);
}
async function dispatch(body, secret = SECRET) {
  const r = await fetch(`${DEV}${DISPATCH}`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch { /* not json */ }
  return { status: r.status, body: json };
}
const outboxRows = (ids) => guardedSql(env, `SELECT id, status, attempt_count, provider_message_id, (SELECT count(*) FROM safety_email_attempts a WHERE a.outbox_id = o.id) AS attempts
  FROM safety_email_outbox o WHERE o.id IN (${ids.map(q).join(", ")}) ORDER BY id`);

async function partB(run) {
  section("B. Development server, resend provider, dedicated fixture (never the preserved L5)");
  const patient = await run.user("patient");
  const cA = await run.user("allowed");
  const cB = await run.user("other");
  const invitee = `m33c-invitee-${randomUUID().slice(0, 8)}@example.invalid`;
  const strangerInvitee = `m33c-stranger-${randomUUID().slice(0, 8)}@example.invalid`;
  const { ceId } = run.setup({
    orgName: "M3.3 S3c containment org",
    members: [["fixture", patient.id, "member"], ["fixture", cA.id, "clinician"], ["fixture", cB.id, "clinician"]],
    assignments: [["fixture", cA.id, patient.id], ["fixture", cB.id, patient.id]],
    names: { [patient.id]: "M33c Patient", [cA.id]: "M33c Allowed", [cB.id]: "M33c Other" },
  });
  run.safetyFlow(patient.id, cA.id, ceId, "l5");
  const ob = {};
  for (const r of guardedSql(env, `SELECT o.id, r.recipient_user_id FROM safety_email_outbox o JOIN safety_notification_events e ON e.id = o.event_id
      JOIN safety_notification_recipients r ON r.id = o.recipient_id WHERE e.patient_id = ${q(patient.id)}`)) ob[r.recipient_user_id === cA.id ? "A" : "B"] = r.id;
  check("fixture: one pending urgent intent per clinician (allowed / other), neither is the preserved L5", !!ob.A && !!ob.B && ob.A !== L5_OUTBOX && ob.B !== L5_OUTBOX
    && outboxRows([ob.A, ob.B]).every((r) => r.status === "pending" && Number(r.attempts) === 0), JSON.stringify(ob));

  const log = join(WORK, "dev-server.jsonl");
  const dev = await startServer(PORTS.dev, {
    TENOTRAINER_MODE: "development", TENOTRAINER_APP_ORIGIN: DEV, C5_PATIENT_RUNTIME_ENABLED: "true", FASTAPI_URL: "http://127.0.0.1:59999",
    TENOTRAINER_EMAIL_PROVIDER: "resend", RESEND_API_KEY: INERT_KEY, TENOTRAINER_NOTIFICATION_EMAIL_FROM: DEV_SENDER,
    TENOTRAINER_DEV_EMAIL_RECIPIENTS: `${cA.email},${invitee}`, SAFETY_DISPATCH_SECRET: SECRET, SAFETY_DISPATCH_SECRET_NEXT: SECRET_NEXT,
  }, log);
  check("development server started with the resend provider under the interceptor", dev.log.includes("TenoTrainer operating mode: development"));

  // ---- dispatch secret rotation + the mandatory explicit scope
  const wrong = await dispatch(undefined, `wrong-${randomUUID()}-${randomUUID()}`);
  check("dispatch: wrong secret refused (401)", wrong.status === 401 && wrong.body?.error === "UNAUTHORIZED", String(wrong.status));
  const cur = await dispatch(undefined, SECRET);
  check("dispatch: current secret accepted; development resend without an explicit scope -> 400 DEVELOPMENT_DISPATCH_SCOPE_REQUIRED", cur.status === 400 && cur.body?.error === "DEVELOPMENT_DISPATCH_SCOPE_REQUIRED", `${cur.status} ${JSON.stringify(cur.body)}`);
  const nxt = await dispatch(undefined, SECRET_NEXT);
  check("dispatch: rotation partner (SAFETY_DISPATCH_SECRET_NEXT) accepted", nxt.status === 400 && nxt.body?.error === "DEVELOPMENT_DISPATCH_SCOPE_REQUIRED", String(nxt.status));
  for (const [label, body] of [["empty list", { outboxIds: [] }], ["not a uuid", { outboxIds: ["nope"] }], ["not a list", { outboxIds: ob.A }], ["too many ids", { outboxIds: Array.from({ length: 51 }, () => randomUUID()) }]]) {
    const r = await dispatch(body);
    check(`dispatch: invalid explicit scope refused (${label}) -> 400, nothing claimed`, r.status === 400 && r.body?.error === "DEVELOPMENT_DISPATCH_SCOPE_REQUIRED", String(r.status));
  }
  check("dispatch: nothing claimed and ZERO transport calls so far", outboxRows([ob.A, ob.B]).every((r) => r.status === "pending" && Number(r.attempts) === 0) && intercepted(log).length === 0);

  // ---- allow-list intersection before the scoped claim
  const onlyB = await dispatch({ outboxIds: [ob.B] });
  check("dispatch [other]: the non-allow-listed recipient's intent is never claimed (claimed 0)", onlyB.status === 200 && onlyB.body?.claimed === 0, JSON.stringify(onlyB.body));
  const unknown = await dispatch({ outboxIds: [randomUUID(), randomUUID()] });
  check("dispatch [unknown ids]: claimed 0", unknown.status === 200 && unknown.body?.claimed === 0, JSON.stringify(unknown.body));
  check("after non-allow-listed dispatch: ZERO transport calls; both intents still pending with no attempt", intercepted(log).length === 0
    && outboxRows([ob.A, ob.B]).every((r) => r.status === "pending" && Number(r.attempts) === 0), JSON.stringify(outboxRows([ob.A, ob.B])));
  const both = await dispatch({ outboxIds: [ob.A, ob.B] });
  check("dispatch [allowed, other]: exactly the allowed intent claimed and accepted", both.status === 200 && both.body?.claimed === 1 && both.body?.accepted === 1, JSON.stringify(both.body));
  const calls = intercepted(log);
  check("exactly one transport call, to the allow-listed clinician, from the development sender, intercepted (no network)",
    calls.length === 1 && calls[0].intercepted && calls[0].to.length === 1 && calls[0].to[0].toLowerCase() === cA.email && calls[0].from === DEV_SENDER, JSON.stringify(calls));
  const rows = Object.fromEntries(outboxRows([ob.A, ob.B]).map((r) => [r.id, r]));
  check("allowed intent: provider_accepted with the intercepted message id, one attempt", rows[ob.A].status === "provider_accepted" && String(rows[ob.A].provider_message_id).startsWith("intercepted_") && Number(rows[ob.A].attempts) === 1, JSON.stringify(rows[ob.A]));
  check("other intent: untouched (pending, no attempt) — the safety state machine is unchanged", rows[ob.B].status === "pending" && Number(rows[ob.B].attempts) === 0, JSON.stringify(rows[ob.B]));

  // ---- invitation delivery through the real clinician UI
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${DEV}/login`);
    await page.fill("#email", cA.email);
    await page.fill("#password", FIXTURE_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
    const invite = async (to) => {
      await page.goto(`${DEV}/clinician/invitations`);
      await page.getByTestId("invite-email").fill(to);
      await page.getByTestId("send-invitation").click();
      const box = page.getByTestId("invite-result").first();
      await box.waitFor({ timeout: 20000 });
      return { text: await box.innerText(), link: (await page.getByTestId("invite-link").first().innerText().catch(() => "")).trim() };
    };
    const before = intercepted(log).length;
    const stranger = await invite(strangerInvitee);
    check("invitation to a non-allow-listed address: created, NOT emailed, one-time link shown", stranger.text.includes("could not be sent") && stranger.link.includes("/invite/accept?token="), stranger.text);
    check("invitation to a non-allow-listed address: ZERO transport calls", intercepted(log).length === before, String(intercepted(log).length - before));
    const allowedInvite = await invite(invitee);
    const after = intercepted(log);
    check("invitation to the exact allow-listed address: emailed", allowedInvite.text.includes("Invitation emailed to"), allowedInvite.text);
    check("invitation to the exact allow-listed address: exactly one intercepted call, to that address, from the development sender",
      after.length === before + 1 && after[after.length - 1].to[0].toLowerCase() === invitee && after[after.length - 1].from === DEV_SENDER, JSON.stringify(after.slice(before)));
    check("invitation links use the configured origin", allowedInvite.link.startsWith(`${DEV}/invite/accept?token=`) && stranger.link.startsWith(`${DEV}/invite/accept?token=`), allowedInvite.link);
    const invRows = guardedSql(env, `SELECT email, status, (email_sent_at IS NOT NULL) AS sent FROM invitations WHERE invited_by = ${q(cA.id)} ORDER BY email`);
    check("invitation lifecycle unchanged: both pending; email_sent_at only for the delivered one",
      invRows.length === 2 && invRows.every((r) => r.status === "pending") && invRows.find((r) => r.email === invitee)?.sent === true && invRows.find((r) => r.email === strangerInvitee)?.sent === false, JSON.stringify(invRows));
    await ctx.close();
  } finally {
    await browser.close();
  }
  check("no secret (dispatch secrets, Resend key) appears in the server log", ![SECRET, SECRET_NEXT, INERT_KEY].some((v) => dev.log.includes(v)));
  await stopServer(dev);
}

// ================================================================ C (startup refusals)
async function expectRefusal(label, overrides, mentions) {
  const s = spawnServer(PORTS.refuse, overrides, join(WORK, `refuse-${randomUUID()}.jsonl`));
  for (let i = 0; i < 60 && s.exited === null; i++) await sleep(500);
  if (s.exited === null) await stopServer(s);
  check(`startup refused: ${label}`, s.exited !== null && s.exited !== 0 && s.log.includes("TenoTrainer refused to start") && s.log.includes(mentions), `exit ${s.exited} ${s.log.slice(-300)}`);
}
async function partC() {
  section("C. Startup refusals");
  const PROD = { TENOTRAINER_MODE: "production", TENOTRAINER_APP_ORIGIN: "https://app.tenotrainer.test", C5_PATIENT_RUNTIME_ENABLED: "true", FASTAPI_URL: "", BRIDGE_SECRET: "",
    TENOTRAINER_EMAIL_PROVIDER: "resend", RESEND_API_KEY: INERT_KEY, TENOTRAINER_NOTIFICATION_EMAIL_FROM: "TenoTrainer <safety@tenotrainer.test>", SAFETY_DISPATCH_SECRET: SECRET };
  await expectRefusal("production + provider disabled", { ...PROD, TENOTRAINER_EMAIL_PROVIDER: "disabled" }, 'TENOTRAINER_EMAIL_PROVIDER: must be "resend"');
  await expectRefusal("production + provider unset", { ...PROD, TENOTRAINER_EMAIL_PROVIDER: "" }, 'TENOTRAINER_EMAIL_PROVIDER: must be "resend"');
  await expectRefusal("production + fake provider", { ...PROD, TENOTRAINER_EMAIL_PROVIDER: "fake" }, '"fake" is forbidden');
  await expectRefusal("maintenance + fake provider", { ...PROD, TENOTRAINER_MODE: "maintenance", TENOTRAINER_EMAIL_PROVIDER: "fake" }, '"fake" is forbidden');
  await expectRefusal("production + development recipient allow-list", { ...PROD, TENOTRAINER_DEV_EMAIL_RECIPIENTS: ALLOWED }, "TENOTRAINER_DEV_EMAIL_RECIPIENTS: is a development-only control");
  await expectRefusal("production + fake-provider log knob", { ...PROD, SAFETY_FAKE_PROVIDER_LOG: join(WORK, "fake.log") }, "SAFETY_FAKE_PROVIDER_LOG: is a test-only fake-provider control");
  await expectRefusal("production + a non-Resend key shape", { ...PROD, RESEND_API_KEY: "sk_not_resend" }, "RESEND_API_KEY: is not a Resend API key");
  await expectRefusal("production + retired SAFETY_EMAIL_PROVIDER", { ...PROD, SAFETY_EMAIL_PROVIDER: "resend" }, "SAFETY_EMAIL_PROVIDER: has been renamed");
  await expectRefusal("production + sandbox sender", { ...PROD, TENOTRAINER_NOTIFICATION_EMAIL_FROM: "TenoTrainer <onboarding@resend.dev>" }, "sandbox sender domain");
  const DEVR = { TENOTRAINER_MODE: "development", TENOTRAINER_APP_ORIGIN: `http://localhost:${PORTS.refuse}`, TENOTRAINER_EMAIL_PROVIDER: "resend", RESEND_API_KEY: INERT_KEY, TENOTRAINER_NOTIFICATION_EMAIL_FROM: DEV_SENDER };
  await expectRefusal("development + resend + missing allow-list", DEVR, "TENOTRAINER_DEV_EMAIL_RECIPIENTS: is required");
  await expectRefusal("development + resend + malformed allow-list", { ...DEVR, TENOTRAINER_DEV_EMAIL_RECIPIENTS: "*@example.invalid" }, "every entry must be one exact email address");
  await expectRefusal("development + resend + 21 recipients", { ...DEVR, TENOTRAINER_DEV_EMAIL_RECIPIENTS: Array.from({ length: 21 }, (_, i) => `r${i}@example.invalid`).join(",") }, "at most 20 entries");
  await expectRefusal("development + resend + unregistered sender domain", { ...DEVR, TENOTRAINER_DEV_EMAIL_RECIPIENTS: ALLOWED, TENOTRAINER_NOTIFICATION_EMAIL_FROM: "x@tenotrainer-verify.org" }, "requires a registered development sending domain");
}

// ================================================================ D (harness kill switch)
function partD() {
  section("D. Harness real-email kill switch");
  const refused = (fn) => { try { fn(); return false; } catch (e) { return e instanceof RealEmailRefused; } };
  check("kill switch: resend provider without the interceptor is refused", refused(() => assertNoRealEmail({ TENOTRAINER_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x" })));
  check("kill switch: a Resend key on a non-resend server is refused", refused(() => assertNoRealEmail({ TENOTRAINER_EMAIL_PROVIDER: "disabled", RESEND_API_KEY: "re_x" })));
  check("kill switch: recipients on a non-resend server are refused", refused(() => assertNoRealEmail({ TENOTRAINER_EMAIL_PROVIDER: "", TENOTRAINER_DEV_EMAIL_RECIPIENTS: "a@b.co" })));
  check("kill switch: RESEND_BASE_URL is refused", refused(() => assertNoRealEmail({ TENOTRAINER_EMAIL_PROVIDER: "", RESEND_BASE_URL: "http://x" })));
  const stripped = withEmailContainment({ TENOTRAINER_EMAIL_PROVIDER: "disabled", RESEND_API_KEY: "re_from_developer_env", TENOTRAINER_DEV_EMAIL_RECIPIENTS: "me@real.example" });
  check("containment strips a developer Resend key and recipients from non-resend servers", stripped.RESEND_API_KEY === "" && stripped.TENOTRAINER_DEV_EMAIL_RECIPIENTS === "");
  const contained = withEmailContainment({ TENOTRAINER_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x" });
  check("containment always preloads the interceptor for resend servers", String(contained.NODE_OPTIONS).includes("resendInterceptor.mjs") && !!contained.RESEND_INTERCEPT_LOG);
}

// ================================================================ main
const l5Before = guardedSql(env, `SELECT to_jsonb(o) AS row, (SELECT count(*) FROM safety_email_attempts a WHERE a.outbox_id = o.id) AS attempts FROM safety_email_outbox o WHERE o.id = ${q(L5_OUTBOX)}`)[0];
const run = new FixtureRun(env, admin, "s3c");
try {
  partA();
  partD();
  await partB(run);
  await partC();
} catch (e) {
  check("suite ran without an unexpected error", false, e?.stack ?? String(e));
} finally {
  for (const s of started) await stopServer(s);
  try {
    run.teardown();
    check("fixture teardown: exact ids purged, zero residue (FixtureRun verification)", true);
  } catch (e) {
    check("fixture teardown", false, e.message);
  }
  const l5After = guardedSql(env, `SELECT to_jsonb(o) AS row, (SELECT count(*) FROM safety_email_attempts a WHERE a.outbox_id = o.id) AS attempts FROM safety_email_outbox o WHERE o.id = ${q(L5_OUTBOX)}`)[0];
  check("preserved L5 byte-for-byte unchanged (accepted baseline), 0 attempts", JSON.stringify(l5After) === JSON.stringify(l5Before) && Number(l5After.attempts) === 0 && l5After.row.status === "suppressed_episode_released");
  let lingering = 0;
  for (const p of Object.values(PORTS)) if (await listening(p)) lingering++;
  check("no server this suite started is still listening", lingering === 0);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
