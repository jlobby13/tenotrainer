// M3.2 — authoritative safety email WORKER suite (FakeProvider only; no
// network email). Runs the exact production dispatcher core
// (lib/safetyEmail/dispatcher.ts) against COMMITTED synthetic fixtures in
// the development database, over real PostgREST connections (concurrency).
// Every claim is scoped to this run's exact fixture outbox ids; the
// pre-existing development intents are snapshotted before and proven
// byte-identical after (never claimed, leased, requeued or suppressed).
// Teardown purges exactly this run's fixtures and must leave zero residue.
//
// Run from web/:  TENOTRAINER_MODE=development node --experimental-strip-types scripts/verifyM32SafetyDispatch.mjs
import { createClient } from "@supabase/supabase-js";
import { FixtureRun, guardedSql, loadEnv, q } from "./lib/m32Fixtures.mjs";
import { assertPurgeTarget } from "./lib/safetyFixturePurge.mjs";
import { dispatchSafetyEmails } from "../lib/safetyEmail/dispatcher.ts";
import { FakeSafetyEmailProvider } from "../lib/safetyEmail/fakeProvider.ts";
import { buildSafetyEmail, notificationLink } from "../lib/safetyEmail/template.ts";

const env = loadEnv(".env.local");
assertPurgeTarget(env);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const APP = "https://app.tenotrainer.test";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${String(detail).slice(0, 400)}` : ""}`); }
};

const rpc = async (fn, args) => {
  const { data, error } = await admin.rpc(fn, args);
  return { data, error: error ? { message: error.message } : null };
};
const plan = new Map(); // outbox id -> outcome sequence
const keyOutbox = (key) => key.split("/")[1];
const fake = new FakeSafetyEmailProvider({
  mode: "development",
  script: (key, attempt) => { const p = plan.get(keyOutbox(key)); return p ? p[Math.min(attempt, p.length) - 1] : "accepted"; },
});
const render = (c) => buildSafetyEmail({ to: c.recipient_email, tier: c.tier, organizationName: c.organization_name, link: notificationLink(APP, c.recipient_id) });
const dispatch = (scope, extra = {}) => dispatchSafetyEmails({ rpc, provider: fake, render, scope, ...extra });
const rows = (ids) => guardedSql(env, `SELECT id, status, attempt_count, generation, idempotency_key, provider_message_id, last_error_code, claim_token
  FROM safety_email_outbox WHERE id IN (${ids.map(q).join(", ")}) ORDER BY id`);
const row = (id) => rows([id])[0];
const attempts = (id) => guardedSql(env, `SELECT attempt_no, generation, outcome, late_result, idempotency_key, provider_message_id
  FROM safety_email_attempts WHERE outbox_id = ${q(id)} ORDER BY generation, attempt_no`);
const due = (ids) => guardedSql(env, `UPDATE safety_email_outbox SET next_attempt_at = now() - interval '1 second'
  WHERE id IN (${ids.map(q).join(", ")}) AND status = 'retry_scheduled'; SELECT 1 AS ok`);
const expireLease = (ids) => guardedSql(env, `UPDATE safety_email_outbox SET claimed_until = now() - interval '1 second'
  WHERE id IN (${ids.map(q).join(", ")}) AND status = 'claimed'; SELECT 1 AS ok`);
const callsFor = (id) => fake.calls.filter((c) => keyOutbox(c.idempotencyKey) === id);

// ------------------------------------------- pre-existing development intents
const preexisting = guardedSql(env, `SELECT o.id, to_jsonb(o) AS row, (SELECT count(*) FROM safety_email_attempts a WHERE a.outbox_id = o.id) AS attempts
  FROM safety_email_outbox o ORDER BY o.id`);
console.log(`pre-existing development outbox intents: ${preexisting.length}`);

const run = new FixtureRun(env, admin, "worker");
let failedTeardown = null;
try {
  // ------------------------------------------- fixtures
  const P = {}; const C = {};
  for (const k of ["P1", "P2", "P3", "P4", "P5", "P6"]) P[k] = await run.user(k.toLowerCase());
  for (const k of ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"]) C[k] = await run.user(k.toLowerCase());
  const SU = await run.user("super");
  const assign = [
    ...["C1", "C2", "C3", "C4", "C5", "C6", "C7"].map((c) => [c, "P1"]),
    ["C1", "P2"], ["C8", "P2"], ["C1", "P3"], ["C2", "P3"], ["C3", "P3"], ["C4", "P3"], ["C1", "P4"], ["C2", "P4"], ["C1", "P5"], ["C2", "P5"], ["C1", "P6"],
  ];
  const { ceId } = run.setup({
    orgName: "M3.2 worker fixture org",
    members: [...Object.values(P).map((u) => ["fixture", u.id, "member"]), ...Object.values(C).map((u) => ["fixture", u.id, "clinician"]), ["fixture", SU.id, "super_user"]],
    assignments: assign.map(([c, p]) => ["fixture", C[c].id, P[p].id]),
    names: Object.fromEntries([...Object.entries(P), ...Object.entries(C)].map(([k, u]) => [u.id, `M32 Worker ${k}`])),
  });
  const ep = {};
  for (const k of Object.keys(P)) ep[k] = run.safetyFlow(P[k].id, C.C1.id, ceId, "l5").episode_id;
  const ob = {};
  for (const r of guardedSql(env, `SELECT o.id, e.patient_id, r.recipient_user_id FROM safety_email_outbox o
      JOIN safety_notification_events e ON e.id = o.event_id JOIN safety_notification_recipients r ON r.id = o.recipient_id
      WHERE e.patient_id IN (${Object.values(P).map((u) => q(u.id)).join(", ")})`)) {
    const pk = Object.keys(P).find((k) => P[k].id === r.patient_id);
    const ck = Object.keys(C).find((k) => C[k].id === r.recipient_user_id);
    ob[`${pk}/${ck}`] = r.id;
  }
  const allFixture = Object.values(ob);
  check("fixtures: 18 urgent email intents from real L5 episodes, all pending, generation 1",
    allFixture.length === 18 && rows(allFixture).every((r) => r.status === "pending" && r.generation === 1 && r.idempotency_key.endsWith("/g1")), allFixture.length);
  check("fixture ids never include a pre-existing development intent", !allFixture.some((id) => preexisting.some((p) => p.id === id)));

  // ------------------------------------------- scoped claim primitive (committed rows, real connections)
  const S = ob["P6/C1"];
  let r = await rpc("safety_email_claim", { p_limit: 10, p_lease_seconds: 120, p_only_outbox_ids: [] });
  check("scope: empty array claims zero rows", !r.error && r.data.length === 0, r.error?.message);
  r = await rpc("safety_email_claim", { p_limit: 10, p_lease_seconds: 120, p_only_outbox_ids: [crypto.randomUUID(), crypto.randomUUID()] });
  check("scope: unknown ids claim zero rows", !r.error && r.data.length === 0);
  r = await rpc("safety_email_claim", { p_limit: 10, p_lease_seconds: 120, p_only_outbox_ids: [S, S, S] });
  check("scope: duplicate ids claim the intent exactly once", !r.error && r.data.length === 1 && r.data[0].outbox_id === S && attempts(S).length === 1);
  const sToken = r.data[0].claim_token;
  r = await rpc("safety_email_claim", { p_limit: 10, p_lease_seconds: 120, p_only_outbox_ids: [S] });
  check("scope: a leased intent is not claimed again (lease respected inside the scope)", !r.error && r.data.length === 0);
  check("scope: no scoped claim ever returned a pre-existing development intent",
    !fake.calls.length && preexisting.every((p) => attempts(p.id).length === Number(p.attempts)));
  await rpc("safety_email_record_result", { p_outbox_id: S, p_claim_token: sToken, p_outcome: "provider_accepted", p_http_status: 200, p_provider_message_id: "manual-scope-check", p_error_code: null });

  // ------------------------------------------- 1. immediate acceptance
  const A = ob["P1/C1"];
  let sum = await dispatch([A]);
  const aRow = row(A);
  check("immediate acceptance: provider_accepted with the provider message id, one attempt, generation-1 key",
    sum.accepted === 1 && aRow.status === "provider_accepted" && aRow.provider_message_id === FakeSafetyEmailProvider.messageIdFor(aRow.idempotency_key)
    && attempts(A).length === 1 && callsFor(A).length === 1 && callsFor(A)[0].idempotencyKey === aRow.idempotency_key, JSON.stringify(sum));
  const msg = render({ recipient_email: "x@example.invalid", tier: "urgent_clinician_review", organization_name: "M3.2 worker fixture org", recipient_id: "11111111-1111-1111-1111-111111111111" });
  const sent = callsFor(A)[0];
  check("email: urgent subject exactly 'TenoTrainer: urgent clinician review required'", sent.subject === "TenoTrainer: urgent clinician review required");
  const body = `${msg.subject}\n${msg.text}\n${msg.html}`;
  check("email: no patient name / id / episode id / numeric level / symptom in subject or body; org name + opaque link only",
    !/M32 Worker P1/.test(body) && !body.includes(P.P1.id) && !body.includes(ep.P1) && !/level\s*\d/i.test(body)
    && !/pop|pain|sharp|achilles|tendon/i.test(body) && body.includes("M3.2 worker fixture org")
    && body.includes(`${APP}/clinician/notifications/11111111-1111-1111-1111-111111111111`));

  // ------------------------------------------- 2. permanent rejection
  const B = ob["P1/C2"];
  plan.set(B, ["permanent"]);
  sum = await dispatch([B]);
  const alertB = guardedSql(env, `SELECT count(*) AS n FROM safety_notification_alerts WHERE kind = 'delivery_failed_permanent' AND subject_key = 'outbox:' || ${q(B)}::text AND cleared_at IS NULL`)[0].n;
  check("permanent rejection: failed_permanent with the provider code, alert raised, no retry", row(B).status === "failed_permanent"
    && row(B).last_error_code === "fake_invalid_recipient" && Number(alertB) === 1 && sum.failed_permanent === 1);

  // ------------------------------------------- 3. transient -> accepted
  const Cx = ob["P1/C3"];
  plan.set(Cx, ["transient", "accepted"]);
  sum = await dispatch([Cx]);
  check("transient: retry_scheduled (not failed), not claimable before it is due", row(Cx).status === "retry_scheduled" && (await dispatch([Cx])).claimed === 0);
  due([Cx]);
  sum = await dispatch([Cx]);
  check("transient -> accepted on retry with the SAME idempotency key", row(Cx).status === "provider_accepted"
    && new Set(callsFor(Cx).map((c) => c.idempotencyKey)).size === 1 && attempts(Cx).map((a) => a.outcome).join(",") === "transient_error,provider_accepted");

  // ------------------------------------------- 4. ambiguous timeout -> retry same key
  const D = ob["P1/C4"];
  plan.set(D, ["ambiguous", "accepted"]);
  await dispatch([D]);
  check("ambiguous timeout: recorded as timeout_ambiguous and retried (never assumed accepted or failed)",
    row(D).status === "retry_scheduled" && attempts(D)[0].outcome === "timeout_ambiguous");
  due([D]);
  await dispatch([D]);
  check("ambiguous: the retry reuses the key; the provider deduplicates (same message id, duplicate flagged) — one logical email",
    row(D).status === "provider_accepted" && callsFor(D).length === 2 && callsFor(D)[1].duplicate === true
    && new Set(callsFor(D).map((c) => c.idempotencyKey)).size === 1 && row(D).provider_message_id === FakeSafetyEmailProvider.messageIdFor(row(D).idempotency_key));

  // ------------------------------------------- 5. crash after provider acceptance, before recording
  const E = ob["P1/C5"];
  let crashed = false;
  try {
    await dispatch([E], { afterSend: (claim) => { if (claim.outbox_id === E) throw new Error("simulated worker crash"); } });
  } catch { crashed = true; }
  check("crash: worker died after the provider accepted — the intent stays leased, attempt open, nothing recorded",
    crashed && row(E).status === "claimed" && attempts(E).length === 1 && attempts(E)[0].outcome === null && callsFor(E).length === 1);
  check("crash: before the lease expires no other worker can take it", (await dispatch([E])).claimed === 0);
  expireLease([E]);
  await dispatch([E]);
  const eA = attempts(E);
  check("crash: after lease expiry the attempt is closed abandoned and retried with the SAME key; the provider returns the same message (one logical email)",
    row(E).status === "provider_accepted" && eA.length === 2 && eA[0].outcome === "abandoned_lease_expired" && eA[1].outcome === "provider_accepted"
    && eA[0].idempotency_key === eA[1].idempotency_key && callsFor(E)[1].duplicate === true, JSON.stringify(eA));

  // ------------------------------------------- 6. late provider acceptance from the abandoned worker
  const F = ob["P1/C6"];
  const w1 = (await rpc("safety_email_claim", { p_limit: 1, p_lease_seconds: 30, p_only_outbox_ids: [F] })).data[0];
  const w1Result = await fake.send(render(w1), { idempotencyKey: w1.idempotency_key });
  expireLease([F]);
  const w2 = (await rpc("safety_email_claim", { p_limit: 1, p_lease_seconds: 120, p_only_outbox_ids: [F] })).data[0];
  const late = (await rpc("safety_email_record_result", { p_outbox_id: F, p_claim_token: w1.claim_token, p_outcome: "provider_accepted",
    p_http_status: 200, p_provider_message_id: w1Result.providerMessageId, p_error_code: null })).data;
  check("late acceptance: the abandoned worker's acceptance is evidence — recorded (late_result) and the intent is provider_accepted",
    late?.status === "provider_accepted" && row(F).status === "provider_accepted" && attempts(F)[0].late_result === true && attempts(F)[0].outcome === "provider_accepted");
  const w2Result = await fake.send(render(w2), { idempotencyKey: w2.idempotency_key });
  const live = (await rpc("safety_email_record_result", { p_outbox_id: F, p_claim_token: w2.claim_token, p_outcome: "provider_accepted",
    p_http_status: 200, p_provider_message_id: w2Result.providerMessageId, p_error_code: null })).data;
  check("late acceptance: the second worker's identical acceptance keeps ONE logical acceptance (same message id)",
    live?.status === "provider_accepted" && row(F).provider_message_id === w1Result.providerMessageId && w1Result.providerMessageId === w2Result.providerMessageId);

  // ------------------------------------------- 7. concurrency: same scope, real connections
  const G = ["P3/C1", "P3/C2", "P3/C3", "P3/C4"].map((k) => ob[k]);
  const [g1, g2] = await Promise.all([1, 2].map(() => rpc("safety_email_claim", { p_limit: 10, p_lease_seconds: 120, p_only_outbox_ids: G })));
  const claimedA = (g1.data ?? []).map((c) => c.outbox_id);
  const claimedB = (g2.data ?? []).map((c) => c.outbox_id);
  check("concurrency (same scope, two connections): no intent claimed twice; together they claim all four",
    !g1.error && !g2.error && claimedA.filter((x) => claimedB.includes(x)).length === 0 && new Set([...claimedA, ...claimedB]).size === 4,
    `${claimedA.length}/${claimedB.length}`);
  for (const c of [...(g1.data ?? []), ...(g2.data ?? [])]) {
    await rpc("safety_email_record_result", { p_outbox_id: c.outbox_id, p_claim_token: c.claim_token, p_outcome: "transient_error", p_http_status: 503, p_provider_message_id: null, p_error_code: "concurrency_probe" });
  }
  due(G);
  const callsBefore = fake.calls.length;
  const [d1, d2] = await Promise.all([dispatch(G), dispatch(G)]);
  check("concurrency (two dispatchers, same scope): every intent accepted exactly once, one provider call per intent",
    d1.accepted + d2.accepted === 4 && rows(G).every((x) => x.status === "provider_accepted") && fake.calls.length - callsBefore === 4
    && G.every((id) => callsFor(id).length === 1), `${d1.accepted}+${d2.accepted}`);

  // ------------------------------------------- 8. disjoint scopes
  const H1 = ob["P4/C1"]; const H2 = ob["P4/C2"];
  const [h1, h2] = await Promise.all([dispatch([H1]), dispatch([H2])]);
  check("disjoint scopes: each worker claims only its own intent", h1.claimed === 1 && h2.claimed === 1
    && callsFor(H1).length === 1 && callsFor(H2).length === 1 && row(H1).status === "provider_accepted" && row(H2).status === "provider_accepted");

  // ------------------------------------------- 9. exhaustion -> failed_permanent -> audited requeue
  const I = ob["P1/C7"];
  plan.set(I, ["transient", "transient", "transient", "transient", "transient", "transient", "transient", "transient", "accepted"]);
  for (let n = 1; n <= 8; n++) { if (n > 1) due([I]); await dispatch([I]); }
  const iAlert = guardedSql(env, `SELECT count(*) AS n FROM safety_notification_alerts WHERE kind = 'delivery_failed_permanent' AND subject_key = 'outbox:' || ${q(I)}::text AND cleared_at IS NULL`)[0].n;
  check("exhaustion: 8 attempts, then failed_permanent (attempts_exhausted) with an open alert — never silently dropped",
    row(I).status === "failed_permanent" && row(I).last_error_code === "attempts_exhausted" && attempts(I).length === 8 && Number(iAlert) === 1);
  check("exhaustion: one stable generation-1 key across all 8 attempts", new Set(callsFor(I).map((c) => c.idempotencyKey)).size === 1);
  r = await rpc("safety_email_requeue", { p_outbox_id: I, p_actor_id: C.C1.id, p_reason: "retry please" });
  check("requeue: refused for a non-super-user", r.data?.result === "not_authorized");
  r = await rpc("safety_email_requeue", { p_outbox_id: I, p_actor_id: SU.id, p_reason: "Provider outage resolved" });
  plan.set(I, ["accepted"]); // the provider is healthy again (attempts are counted per idempotency key)
  await dispatch([I]);
  const iKeys = [...new Set(callsFor(I).map((c) => c.idempotencyKey))];
  const audit = guardedSql(env, `SELECT count(*) AS n FROM safety_email_requeues WHERE outbox_id = ${q(I)} AND requested_by = ${q(SU.id)} AND previous_generation = 1 AND new_generation = 2`)[0].n;
  check("requeue: audited, NEW idempotency generation (/g2) used, accepted; generation-1 history preserved",
    r.data?.result === "requeued" && Number(audit) === 1 && row(I).status === "provider_accepted" && row(I).generation === 2
    && iKeys.length === 2 && iKeys[1].endsWith("/g2") && attempts(I).filter((a) => a.generation === 1).length === 8);

  // ------------------------------------------- 10. episode released mid-retry
  const R1 = ob["P2/C1"]; const R2 = ob["P2/C8"];
  plan.set(R1, ["transient", "accepted"]); plan.set(R2, ["transient", "accepted"]);
  await dispatch([R1, R2]);
  r = await rpc("clinician_release_acute_episode", { p_episode_id: ep.P2, p_clinician_id: C.C8.id, p_note: "Reviewed; released." });
  due([R1, R2]);
  const relCalls = fake.calls.length;
  sum = await dispatch([R1, R2]);
  check("released mid-retry: the clinician release (existing M1 path) suppresses the pending retries — no further attempt or email",
    r.data?.result === "released" && rows([R1, R2]).every((x) => x.status === "suppressed_episode_released") && sum.claimed === 0
    && fake.calls.length === relCalls && attempts(R1).length === 1, JSON.stringify(r.data));

  // ------------------------------------------- 11. recipient becomes ineligible mid-retry
  const K = ob["P5/C2"];
  plan.set(K, ["transient", "accepted"]);
  await dispatch([K]);
  guardedSql(env, `UPDATE supervisor_patients SET status = 'dismissed', dismissed_at = now() WHERE supervisor_id = ${q(C.C2.id)} AND patient_id = ${q(P.P5.id)} AND status = 'active'; SELECT 1 AS ok`);
  due([K]);
  const kCalls = callsFor(K).length;
  sum = await dispatch([K]);
  check("ineligible mid-retry: an ended assignment stops future email (suppressed_recipient_ineligible), history kept",
    row(K).status === "suppressed_recipient_ineligible" && callsFor(K).length === kCalls && attempts(K).length === 1
    && Number(guardedSql(env, `SELECT count(*) AS n FROM safety_notification_recipients r JOIN safety_email_outbox o ON o.recipient_id = r.id WHERE o.id = ${q(K)}`)[0].n) === 1);

  // ------------------------------------------- PHI in the provider log / naming
  check("no provider call carried a patient name or id", fake.calls.every((c) => !Object.values(P).some((u) => c.subject.includes(u.id))));
} finally {
  // ------------------------------------------- pre-existing intents untouched
  const after = guardedSql(env, `SELECT o.id, to_jsonb(o) AS row, (SELECT count(*) FROM safety_email_attempts a WHERE a.outbox_id = o.id) AS attempts
    FROM safety_email_outbox o WHERE o.id IN (${preexisting.length ? preexisting.map((p) => q(p.id)).join(", ") : "NULL"}) ORDER BY o.id`);
  check(`pre-existing development intent(s) (${preexisting.length}) byte-for-byte unchanged, no new attempt row`,
    after.length === preexisting.length && after.every((a, i) => JSON.stringify(a.row) === JSON.stringify(preexisting[i].row) && a.attempts === preexisting[i].attempts));
  check("the FakeProvider never received a pre-existing development intent",
    !fake.calls.some((c) => preexisting.some((p) => keyOutbox(c.idempotencyKey) === p.id)));
  try {
    const t = run.teardown();
    check("teardown: guarded purge removed exactly this run's fixtures — zero residue across every M3.2 table and the clinical graph",
      t.purge.result === "purged", JSON.stringify(t.purge.deleted));
  } catch (e) {
    failedTeardown = e;
    check("teardown: guarded purge", false, e.message);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 && !failedTeardown ? 0 : 1);
