// C5.4D final correction — verifies that the two C5.4D publish invariants
// (workouts_have_active_exercise, active_exercise_dosage_valid) are enforced
// INSIDE the atomic publish transaction (20261010000001), and that the
// check-then-act race is closed by the draft-row lock protocol.
//
// Sections:
//   1. TS <-> SQL dosage-validity parity: the real web/lib/dosageEditor.ts
//      validateDosageInput() (compiled at test time) vs. the SQL
//      prescription_dosage_validation_errors(), case by case across every
//      supported dosage dimension, comparing the exact field codes.
//   2. Direct bypass: invalid drafts are refused by the RPC itself and by the
//      publish route, with no Review/preflight involved.
//   3. Deterministic races (real concurrent database sessions):
//        writer-first  — an uncommitted invalidating write holds the draft
//                        lock; publish must wait for it, then refuse.
//        writer-first  — positive control: an uncommitted VALID write; publish
//                        waits, then publishes the writer's committed value.
//        publish-first — a held publish transaction; an invalidating write must
//                        wait until publication commits and must never reach
//                        the published version.
//   4. Randomized stress: publish racing destructive writes; every published
//      version must satisfy both invariants.
//   5. Valid first + replacement publication still succeed; the prior
//      version stays byte-identical.
//
// Uses throwaway fixture users only. Needs the linked Supabase CLI
// (`supabase db query --linked`) for the concurrent sessions, and a
// gate-enabled server for the route checks:
//   node scripts/verifyC5Stage4dAtomicPublish.mjs [gateOnUrl]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ON = process.argv[2] ?? "http://localhost:3001";
const REPO_ROOT = "..";
const LEGACY_DB_PATH = "../app/tenotrainer.db";
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
const PASSWORD = "throwaway-verification-1!";

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const eq = t.indexOf("=");
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}
const env = loadEnv(".env.local");
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const WORK = mkdtempSync(join(tmpdir(), "c54d-atomic-"));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}
function section(t) {
  console.log(`\n--- ${t} ---`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- SQL via the linked CLI (never prints credentials) ----
function sqlFile(sql) {
  const path = join(WORK, `q-${randomUUID()}.sql`);
  writeFileSync(path, sql);
  return path;
}
function parseRows(out) {
  const start = out.indexOf("{");
  const parsed = JSON.parse(out.slice(start));
  return parsed.rows ?? [];
}
function sqlQuery(sql) {
  const out = execFileSync("supabase", ["db", "query", "--linked", "--file", sqlFile(sql)], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return parseRows(out);
}
// Runs a SQL script in its own session WITHOUT waiting; resolves when it ends.
function sqlSessionAsync(sql) {
  return new Promise((resolve) => {
    const child = spawn("supabase", ["db", "query", "--linked", "--file", sqlFile(sql)], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}
// The Supabase CLI cannot run two `db query` sessions at once (concurrent
// login-role initialisation hangs one of them), so a held-open session is
// never polled through the CLI. Instead the session first COMMITS a marker
// (a fixture-only profile name) that the test polls over REST, then opens
// its transaction and holds it for HOLD_SECONDS. The hold stays well under
// the API roles' 8s statement_timeout / lock_timeout. Every race asserts the
// MEASURED wait of the concurrent operation, so a mistimed run fails rather
// than passing falsely.
const HOLD_SECONDS = 5;
let markerProfileId = null;
function heldSession(marker, body) {
  return sqlSessionAsync(`UPDATE profiles SET name = '${marker}' WHERE id = '${markerProfileId}';
COMMIT;
BEGIN;
${body}
SELECT pg_sleep(${HOLD_SECONDS});
COMMIT;`);
}
async function waitForMarker(marker, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data } = await admin.from("profiles").select("name").eq("id", markerProfileId).maybeSingle();
    if (data?.name === marker) {
      await sleep(1000); // let the session's BEGIN + locking statement run
      return true;
    }
    await sleep(100);
  }
  return false;
}

// ---- fixtures ----
const createdUsers = [];
const legacyUserIds = [];
const legacyLinkIds = [];
async function makeUser(label) {
  const email = `c54d-atomic-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  createdUsers.push(data.user.id);
  await admin.from("profiles").upsert({ id: data.user.id, name: label });
  return { userId: data.user.id, email, label };
}

const DOSE = (sets) => ({ dosage_type: "repetition", sets, reps_mode: "exact", reps_exact: 8, load_type: "not_applicable" });

// A valid two-workout draft built with direct service-role writes (the race
// tests exercise the database boundary, not the HTTP layer).
async function makeDraft(clinician, ppId, exerciseIds) {
  await admin.from("prescription_drafts").update({ status: "discarded" }).eq("patient_prescription_id", ppId).eq("status", "editing");
  const { data: pp } = await admin.from("patient_prescriptions").select("current_prescription_version_id").eq("id", ppId).single();
  const { data: draft, error } = await admin
    .from("prescription_drafts")
    .insert({
      patient_prescription_id: ppId,
      status: "editing",
      source: "empty",
      stale_base_prescription_version_id: pp.current_prescription_version_id,
      created_by: clinician.userId,
      editing_clinician_id: clinician.userId,
      updated_by: clinician.userId,
      scheduling_mode: "sequence",
      target_sessions_per_week: 2,
    })
    .select("id")
    .single();
  if (error) throw error;
  const workouts = [];
  for (const [i, exId] of exerciseIds.entries()) {
    const { data: w } = await admin.from("prescription_workouts").insert({ prescription_draft_id: draft.id, label: `W${i}`, order_index: i }).select("id").single();
    const { data: pe } = await admin.from("prescription_exercises").insert({ prescription_workout_id: w.id, canonical_exercise_id: exId, order_index: 0 }).select("id").single();
    const { data: d } = await admin.from("prescription_exercise_dosage").insert({ prescription_exercise_id: pe.id, ...DOSE(3) }).select("id").single();
    workouts.push({ workoutId: w.id, exerciseId: pe.id, dosageId: d.id });
  }
  return { draftId: draft.id, workouts };
}
async function versionsFor(ppId) {
  const { data } = await admin.from("prescription_versions").select("id, version_number").eq("patient_prescription_id", ppId).order("version_number");
  return data ?? [];
}
// Both invariants, evaluated by the database over every version given.
function invariantViolations(versionIds) {
  if (versionIds.length === 0) return 0;
  const list = versionIds.map((id) => `'${id}'`).join(",");
  const rows = sqlQuery(`
    SELECT
      (SELECT count(*) FROM prescription_workouts pw WHERE pw.prescription_version_id IN (${list})
         AND NOT EXISTS (SELECT 1 FROM prescription_exercises pe WHERE pe.prescription_workout_id = pw.id AND pe.status = 'active'))::int AS empty_workouts,
      (SELECT count(*) FROM prescription_exercise_dosage ped
         JOIN prescription_exercises pe ON pe.id = ped.prescription_exercise_id
         JOIN prescription_workouts pw ON pw.id = pe.prescription_workout_id
         WHERE pw.prescription_version_id IN (${list}) AND pe.status = 'active'
           AND cardinality(prescription_dosage_validation_errors(ped)) > 0)::int AS invalid_dosages;`);
  return rows[0].empty_workouts + rows[0].invalid_dosages;
}
async function versionSnapshot(versionId) {
  const { data: v } = await admin.from("prescription_versions").select("*").eq("id", versionId).single();
  const { data: ws } = await admin.from("prescription_workouts").select("*, prescription_exercises(*, prescription_exercise_dosage(*))").eq("prescription_version_id", versionId).order("order_index");
  return JSON.stringify({ v, ws });
}

// ---- 1. parity ----
function loadTsValidator() {
  const out = join(WORK, "ts");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "package.json"), JSON.stringify({ type: "commonjs" }));
  execFileSync("npx", ["tsc", "lib/dosageEditor.ts", "--outDir", out, "--module", "commonjs", "--target", "es2022", "--moduleResolution", "node", "--skipLibCheck", "--strict"], { stdio: "pipe" });
  return createRequire(join(out, "x.js"))("./dosageEditor.js").validateDosageInput;
}
const COLUMN = {
  sets: "sets", repsMode: "reps_mode", repsExact: "reps_exact", repsMin: "reps_min", repsMax: "reps_max",
  contactsMode: "contacts_mode", contactsExact: "contacts_exact", contactsMin: "contacts_min", contactsMax: "contacts_max",
  holdDurationMode: "hold_duration_mode", holdDurationExactSeconds: "hold_duration_exact_seconds", holdDurationMinSeconds: "hold_duration_min_seconds", holdDurationMaxSeconds: "hold_duration_max_seconds",
  timeDurationMode: "time_duration_mode", timeDurationExactSeconds: "time_duration_exact_seconds", timeDurationMinSeconds: "time_duration_min_seconds", timeDurationMaxSeconds: "time_duration_max_seconds",
  intervalWorkSeconds: "interval_work_seconds", intervalRecoverySeconds: "interval_recovery_seconds", intervalRounds: "interval_rounds",
  distanceMode: "distance_mode", distanceExactValue: "distance_exact_value", distanceMinValue: "distance_min_value", distanceMaxValue: "distance_max_value", distanceUnit: "distance_unit",
  concentricDurationSeconds: "concentric_duration_seconds", repHoldDurationSeconds: "rep_hold_duration_seconds", eccentricDurationSeconds: "eccentric_duration_seconds", tempoDescription: "tempo_description",
  restSeconds: "rest_seconds", loadType: "load_type", loadValueExact: "load_value_exact", loadUnit: "load_unit", loadMode: "load_mode", loadValueMin: "load_value_min", loadValueMax: "load_value_max",
  rpe: "rpe", rir: "rir", rom: "rom", assistanceLevel: "assistance_level", side: "side",
};
function parityCases() {
  const base = { dosageType: "repetition", loadType: "not_applicable" };
  const c = (name, fields) => ({ name, input: { ...base, ...fields } });
  const exactRange = (dim, mode, exact, min, max, extra = {}) => {
    const k = { reps: ["repsMode", "repsExact", "repsMin", "repsMax"], contacts: ["contactsMode", "contactsExact", "contactsMin", "contactsMax"], hold: ["holdDurationMode", "holdDurationExactSeconds", "holdDurationMinSeconds", "holdDurationMaxSeconds"], time: ["timeDurationMode", "timeDurationExactSeconds", "timeDurationMinSeconds", "timeDurationMaxSeconds"], distance: ["distanceMode", "distanceExactValue", "distanceMinValue", "distanceMaxValue"] }[dim];
    return { [k[0]]: mode, [k[1]]: exact, [k[2]]: min, [k[3]]: max, ...extra };
  };
  const cases = [
    c("empty (no dimension)", {}),
    c("sets only", { sets: 3 }),
    c("sets zero", { sets: 0 }),
  ];
  for (const dim of ["reps", "contacts", "hold", "time", "distance"]) {
    const unit = dim === "distance" ? { distanceUnit: "m" } : {};
    cases.push(
      c(`${dim} exact valid`, exactRange(dim, "exact", 10, null, null, unit)),
      c(`${dim} exact zero`, exactRange(dim, "exact", 0, null, null, unit)),
      c(`${dim} exact negative`, exactRange(dim, "exact", -5, null, null, unit)),
      c(`${dim} exact missing`, exactRange(dim, "exact", null, null, null, unit)),
      c(`${dim} range valid`, exactRange(dim, "range", null, 8, 12, unit)),
      c(`${dim} range equal`, exactRange(dim, "range", null, 10, 10, unit)),
      c(`${dim} range min>max`, exactRange(dim, "range", null, 12, 8, unit)),
      c(`${dim} range missing max`, exactRange(dim, "range", null, 8, null, unit)),
      c(`${dim} range zero min`, exactRange(dim, "range", null, 0, 8, unit)),
      c(`${dim} unknown mode`, exactRange(dim, "bogus", 10, null, null, unit)),
      c(`${dim} + sets`, { sets: 3, ...exactRange(dim, "exact", 10, null, null, unit) })
    );
    // reps/contacts are INTEGER columns; fractions only exist for NUMERIC ones.
    if (["hold", "time", "distance"].includes(dim)) cases.push(c(`${dim} exact fractional`, exactRange(dim, "exact", 2.5, null, null, unit)));
  }
  cases.push(
    c("distance unit without mode", { distanceUnit: "km" }),
    c("distance mode without unit", { distanceMode: "exact", distanceExactValue: 400 }),
    c("interval valid", { intervalWorkSeconds: 30, intervalRecoverySeconds: 30, intervalRounds: 8 }),
    c("interval work zero", { intervalWorkSeconds: 0 }),
    c("interval recovery negative", { intervalRecoverySeconds: -1 }),
    c("interval rounds zero", { intervalRounds: 0 }),
    c("interval rounds only", { intervalRounds: 4 }),
    c("load bodyweight only", { loadType: "bodyweight" }),
    c("load assisted only", { loadType: "assisted" }),
    c("load external exact kg", { loadType: "external", loadMode: "exact", loadValueExact: 40, loadUnit: "kg" }),
    c("load external exact lb (legacy null mode)", { loadType: "external", loadValueExact: 45, loadUnit: "lb" }),
    c("load external no unit", { loadType: "external", loadMode: "exact", loadValueExact: 40 }),
    c("load external exact zero", { loadType: "external", loadMode: "exact", loadValueExact: 0, loadUnit: "kg" }),
    c("load external exact missing", { loadType: "external", loadMode: "exact", loadUnit: "kg" }),
    c("load external no mode no value", { loadType: "external", loadUnit: "kg" }),
    c("load external range valid", { loadType: "external", loadMode: "range", loadValueMin: 20, loadValueMax: 25, loadUnit: "kg" }),
    c("load external range min>max", { loadType: "external", loadMode: "range", loadValueMin: 30, loadValueMax: 25, loadUnit: "kg" }),
    c("load external range missing min", { loadType: "external", loadMode: "range", loadValueMax: 25, loadUnit: "lb" }),
    c("load external range zero", { loadType: "external", loadMode: "range", loadValueMin: 0, loadValueMax: 25, loadUnit: "lb" }),
    c("load n/a with sets", { sets: 2, loadType: "not_applicable" }),
    c("rpe valid", { sets: 3, rpe: 7 }),
    c("rpe 0 and 10 bounds", { sets: 3, rpe: 10 }),
    c("rpe > 10", { sets: 3, rpe: 11 }),
    c("rpe < 0", { sets: 3, rpe: -1 }),
    c("rir valid", { sets: 3, rir: 2 }),
    c("rir > 10", { sets: 3, rir: 11 }),
    c("rpe + rir together", { sets: 3, rpe: 7, rir: 2 }),
    c("rest zero allowed", { sets: 3, restSeconds: 0 }),
    c("rest negative", { sets: 3, restSeconds: -10 }),
    c("tempo/rom/assistance/side only (no dimension)", { concentricDurationSeconds: 2, eccentricDurationSeconds: 3, tempoDescription: "slow", rom: "full", assistanceLevel: "minimal", side: "left" }),
    c("modifiers with sets", { sets: 3, concentricDurationSeconds: 2, repHoldDurationSeconds: 1, eccentricDurationSeconds: 3, rom: "full", assistanceLevel: "moderate", side: "both_sides_separately" }),
    c("everything valid", { sets: 4, repsMode: "exact", repsExact: 8, holdDurationMode: "range", holdDurationMinSeconds: 30, holdDurationMaxSeconds: 45, loadType: "external", loadMode: "exact", loadValueExact: 45, loadUnit: "lb", restSeconds: 90, rpe: 7 }),
    c("multiple errors at once", { repsMode: "range", repsMin: 12, repsMax: 8, loadType: "external", rpe: 7, rir: 2, restSeconds: -1 })
  );
  return cases;
}

async function main() {
  // =====================================================================
  section("1. TS validateDosageInput() <-> SQL prescription_dosage_validation_errors() parity");
  {
    const validateDosageInput = loadTsValidator();
    const cases = parityCases();
    const values = cases
      .map((cs, i) => {
        const row = {};
        for (const [k, v] of Object.entries(cs.input)) if (COLUMN[k] && v !== undefined) row[COLUMN[k]] = v;
        return `(${i}, $j$${JSON.stringify(row)}$j$::jsonb)`;
      })
      .join(",\n");
    const rows = sqlQuery(`SELECT idx, prescription_dosage_validation_errors(jsonb_populate_record(NULL::prescription_exercise_dosage, j)) AS errors FROM (VALUES ${values}) v(idx, j) ORDER BY idx;`);
    let mismatches = 0;
    let invalidCount = 0;
    for (const [i, cs] of cases.entries()) {
      const ts = validateDosageInput(cs.input).map((e) => e.field).sort();
      const sql = (rows[i]?.errors ?? []).slice().sort();
      if (ts.length > 0) invalidCount++;
      if (JSON.stringify(ts) !== JSON.stringify(sql)) {
        mismatches++;
        console.log(`      mismatch "${cs.name}": ts=${JSON.stringify(ts)} sql=${JSON.stringify(sql)}`);
      }
    }
    check(`identical field codes for all ${cases.length} cases (every dimension, exact/range/edge)`, mismatches === 0 && rows.length === cases.length, `${mismatches} mismatches`);
    check("case set exercises both valid and invalid outcomes", invalidCount > 30 && invalidCount < cases.length - 15, `invalid=${invalidCount}/${cases.length}`);
    const byName = Object.fromEntries(cases.map((cs, i) => [cs.name, (rows[i]?.errors ?? []).slice().sort().join(",")]));
    check("RPE + RIR together rejected (the TS-only rule, now in SQL)", byName["rpe + rir together"] === "rpeRir");
    check("no-dimension dosage rejected", byName["empty (no dimension)"] === "dosage" && byName["tempo/rom/assistance/side only (no dimension)"] === "dosage");
    check("legacy NULL load_mode with exact value accepted", byName["load external exact lb (legacy null mode)"] === "");
    check("multiple simultaneous errors all reported", byName["multiple errors at once"] === "loadUnit,loadValueExact,repsRange,restSeconds,rpeRir");
  }

  // ---- fixtures for sections 2-5 ----
  const { data: lib } = await admin.from("canonical_exercises").select("id").eq("active", true).eq("visibility", "global").order("name").limit(2);
  const exA = lib[0].id;
  const exB = lib[1].id;
  const clinician = await makeUser("clinician");
  const patient = await makeUser("patient");
  await admin.from("organization_members").insert([
    { organization_id: REAL_ORG_ID, user_id: clinician.userId, role: "clinician" },
    { organization_id: REAL_ORG_ID, user_id: patient.userId, role: "member" },
  ]);
  await admin.from("supervisor_patients").insert({ supervisor_id: clinician.userId, patient_id: patient.userId, status: "active" });
  await admin.from("prescription_versions").insert({ user_id: patient.userId, stage: 1, irritability: "low", is_insertional: false, source: "onboarding" });
  const db = new DatabaseSync(LEGACY_DB_PATH);
  try {
    const ins = db.prepare("INSERT INTO users (name, email, role, supabase_id) VALUES (?, ?, ?, ?)");
    const lc = ins.run("c54d-atomic-clin", clinician.email, "supervisor", clinician.userId).lastInsertRowid;
    const lp = ins.run("c54d-atomic-pat", patient.email, "patient", patient.userId).lastInsertRowid;
    legacyUserIds.push(lc, lp);
    legacyLinkIds.push(db.prepare("INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (?, ?, 'active')").run(lc, lp).lastInsertRowid);
  } finally {
    db.close();
  }
  const { data: pp } = await admin.from("patient_prescriptions").insert({ patient_id: patient.userId }).select("id").single();
  const ppId = pp.id;
  markerProfileId = patient.userId;
  const rpcPublish = (draftId) => admin.rpc("publish_prescription_draft", { p_draft_id: draftId, p_clinician_id: clinician.userId });

  // Clinician session for the publish route.
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  {
    const page = await ctx.newPage();
    await page.goto(`${ON}/login`);
    await page.fill("#email", clinician.email);
    await page.fill("#password", PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForLoadState("networkidle");
    await page.close();
  }
  const routePublish = async (draftId) => {
    const r = await ctx.request.post(`${ON}/api/clinician/prescription-drafts/${draftId}/publish`, { data: {}, failOnStatusCode: false });
    return { status: r.status(), body: await r.json().catch(() => null) };
  };

  try {
    // =====================================================================
    section("2. Direct bypass — invalid drafts refused by the RPC itself (no Review, no preflight)");
    {
      const d = await makeDraft(clinician, ppId, [exA, exB]);
      await admin.from("prescription_exercises").delete().eq("id", d.workouts[1].exerciseId);
      const r = await rpcPublish(d.draftId);
      check("empty workout: direct RPC call -> VALIDATION_FAILED", r.error?.message?.includes("VALIDATION_FAILED"), JSON.stringify(r.error));
      const h = await routePublish(d.draftId);
      check("empty workout: publish route (no fingerprint, no Review) -> 422 VALIDATION_FAILED", h.status === 422 && h.body?.error === "VALIDATION_FAILED", JSON.stringify(h));
      const rules = (await admin.rpc("validate_prescription_draft", { p_draft_id: d.draftId })).data ?? [];
      check("validate_prescription_draft reports workouts_have_active_exercise", rules.some((x) => x.rule === "workouts_have_active_exercise" && !x.passed));
      await admin.from("prescription_drafts").update({ status: "discarded" }).eq("id", d.draftId);
    }
    {
      const d = await makeDraft(clinician, ppId, [exA, exB]);
      await admin.from("prescription_exercise_dosage").update({ rpe: 7, rir: 2 }).eq("id", d.workouts[0].dosageId);
      const r = await rpcPublish(d.draftId);
      check("invalid dosage (RPE+RIR, DB-permitted): direct RPC -> VALIDATION_FAILED", r.error?.message?.includes("VALIDATION_FAILED"), JSON.stringify(r.error));
      const h = await routePublish(d.draftId);
      check("invalid dosage: publish route -> 422 VALIDATION_FAILED", h.status === 422 && h.body?.error === "VALIDATION_FAILED", JSON.stringify(h));
      const rules = (await admin.rpc("validate_prescription_draft", { p_draft_id: d.draftId })).data ?? [];
      check("validate_prescription_draft reports active_exercise_dosage_valid", rules.some((x) => x.rule === "active_exercise_dosage_valid" && !x.passed));
      check("all pre-existing C5.3 rules still reported", ["has_workout", "has_active_exercise", "active_exercises_have_dosage", "scheduling_mode_present", "sequence_ordering_valid", "calendar_days_present", "calendar_weekdays_exclusive", "sequence_target_frequency_present", "calendar_target_frequency_absent", "exercises_active_and_accessible", "has_prior_clinical_state"].every((rule) => rules.some((x) => x.rule === rule)));
      await admin.from("prescription_exercise_dosage").update({ rir: null }).eq("id", d.workouts[0].dosageId);
      const paused = await admin.from("prescription_exercise_dosage").select("id").eq("id", d.workouts[0].dosageId);
      check("fixture repaired", paused.data?.length === 1);
      await admin.from("prescription_drafts").update({ status: "discarded" }).eq("id", d.draftId);
    }
    check("no version created by any refused publish", (await versionsFor(ppId)).length === 0);

    // =====================================================================
    section("5a. Valid first publication still succeeds (route)");
    let v1 = null;
    {
      const d = await makeDraft(clinician, ppId, [exA, exB]);
      const h = await routePublish(d.draftId);
      check("valid first publication -> 200, Version 1", h.status === 200 && h.body?.versionNumber === 1, JSON.stringify(h));
      v1 = h.body?.versionId;
    }
    const v1Snapshot = await versionSnapshot(v1);

    // =====================================================================
    section("3A. Race — empty-workout write holds the draft lock, publish arrives");
    {
      const d = await makeDraft(clinician, ppId, [exA, exB]);
      const marker = `c54d_race_${randomUUID().replace(/-/g, "")}`;
      const writer = heldSession(marker, `DELETE FROM prescription_exercises WHERE id = '${d.workouts[1].exerciseId}';`);
      check("held session opened (marker committed)", await waitForMarker(marker));
      const t0 = Date.now();
      const r = await rpcPublish(d.draftId);
      const waited = Date.now() - t0;
      const w = await writer;
      check("writer committed", w.code === 0, w.err.slice(0, 300));
      check("publish blocked until the writer committed (waited for the draft lock)", waited > 2500, `waited ${waited}ms`);
      check("publish then saw the committed empty workout and refused (VALIDATION_FAILED)", r.error?.message?.includes("VALIDATION_FAILED"), JSON.stringify(r));
      check("no version with an empty workout was created", (await versionsFor(ppId)).length === 1);
      await admin.from("prescription_drafts").update({ status: "discarded" }).eq("id", d.draftId);
    }

    section("3B. Race — invalid-dosage write holds the draft lock, publish arrives");
    {
      const d = await makeDraft(clinician, ppId, [exA, exB]);
      const marker = `c54d_race_${randomUUID().replace(/-/g, "")}`;
      const writer = heldSession(marker, `UPDATE prescription_exercise_dosage SET rpe = 7, rir = 2 WHERE id = '${d.workouts[0].dosageId}';`);
      check("held session opened (marker committed)", await waitForMarker(marker));
      const t0 = Date.now();
      const r = await rpcPublish(d.draftId);
      const waited = Date.now() - t0;
      await writer;
      check("publish blocked until the writer committed", waited > 2500, `waited ${waited}ms`);
      check("publish refused the committed invalid dosage (VALIDATION_FAILED)", r.error?.message?.includes("VALIDATION_FAILED"), JSON.stringify(r));
      check("no version with invalid dosage was created", (await versionsFor(ppId)).length === 1);
      await admin.from("prescription_drafts").update({ status: "discarded" }).eq("id", d.draftId);
    }

    section("3C. Race — positive control: a VALID uncommitted write is waited for and published");
    {
      const d = await makeDraft(clinician, ppId, [exA, exB]);
      const marker = `c54d_race_${randomUUID().replace(/-/g, "")}`;
      const writer = heldSession(marker, `UPDATE prescription_exercise_dosage SET sets = 5 WHERE id = '${d.workouts[0].dosageId}';`);
      check("held session opened (marker committed)", await waitForMarker(marker));
      const t0 = Date.now();
      const r = await rpcPublish(d.draftId);
      const waited = Date.now() - t0;
      await writer;
      check("publish waited for the writer", waited > 2500, `waited ${waited}ms`);
      check("publish succeeded", !r.error && typeof r.data === "string", JSON.stringify(r.error));
      const { data: ws } = await admin.from("prescription_workouts").select("order_index, prescription_exercises(prescription_exercise_dosage(sets))").eq("prescription_version_id", r.data).order("order_index");
      const sets = ws?.[0]?.prescription_exercises?.[0]?.prescription_exercise_dosage;
      check("published version contains the writer's committed value (validated == copied state)", (Array.isArray(sets) ? sets[0]?.sets : sets?.sets) === 5, JSON.stringify(ws));
    }

    section("3D. Race — publish holds its transaction open, invalidating writes arrive");
    {
      const d = await makeDraft(clinician, ppId, [exA, exB]);
      const marker = `c54d_race_${randomUUID().replace(/-/g, "")}`;
      const publisher = heldSession(marker, `SELECT publish_prescription_draft('${d.draftId}', '${clinician.userId}') AS version_id;`);
      check("held session opened (marker committed)", await waitForMarker(marker));
      const t0 = Date.now();
      const [del, upd] = await Promise.all([
        admin.from("prescription_exercises").delete().eq("id", d.workouts[1].exerciseId),
        admin.from("prescription_exercise_dosage").update({ rpe: 7, rir: 2 }).eq("id", d.workouts[0].dosageId),
      ]);
      const waited = Date.now() - t0;
      const p = await publisher;
      check("publish committed", p.code === 0, p.err.slice(0, 300));
      check("both invalidating writes blocked until publication committed", waited > 2500 && !del.error && !upd.error, `waited ${waited}ms ${JSON.stringify([del.error, upd.error])}`);
      const versions = await versionsFor(ppId);
      const latest = versions[versions.length - 1];
      check("the publication produced a new version", versions.length === 3, JSON.stringify(versions));
      check("published version has no empty workout and no invalid dosage", invariantViolations([latest.id]) === 0);
      const { data: ws } = await admin.from("prescription_workouts").select("id, prescription_exercises(id)").eq("prescription_version_id", latest.id);
      check("published version kept both workouts' exercises (late delete never reached it)", (ws ?? []).length === 2 && ws.every((w) => w.prescription_exercises.length === 1));
    }

    // =====================================================================
    section("4. Randomized stress — publish racing destructive writes");
    {
      const TRIALS = 24;
      let published = 0;
      let refused = 0;
      const publishedIds = [];
      for (let t = 0; t < TRIALS; t++) {
        const d = await makeDraft(clinician, ppId, [exA, exB]);
        const destructive =
          t % 2 === 0
            ? () => admin.from("prescription_exercises").delete().eq("id", d.workouts[1].exerciseId)
            : () => admin.from("prescription_exercise_dosage").update({ rpe: 8, rir: 1 }).eq("id", d.workouts[0].dosageId);
        const delay = Math.floor(Math.random() * 40);
        const [r] = await Promise.all([rpcPublish(d.draftId), sleep(delay).then(destructive)]);
        if (r.error) {
          refused++;
          if (!r.error.message.includes("VALIDATION_FAILED")) check(`trial ${t}: refusal is VALIDATION_FAILED`, false, r.error.message);
          await admin.from("prescription_drafts").update({ status: "discarded" }).eq("id", d.draftId);
        } else {
          published++;
          publishedIds.push(r.data);
        }
      }
      console.log(`      ${TRIALS} trials: ${published} published, ${refused} refused`);
      check(`stress: every one of ${published} published versions satisfies both invariants`, invariantViolations(publishedIds) === 0);
      check("stress: every trial ended in exactly one clean outcome", published + refused === TRIALS);
    }

    // =====================================================================
    section("5b. Valid replacement publication still succeeds; prior version immutable");
    {
      const before = (await versionsFor(ppId)).length;
      const d = await makeDraft(clinician, ppId, [exA, exB]);
      const h = await routePublish(d.draftId);
      check("valid replacement publication -> 200, next version number", h.status === 200 && h.body?.versionNumber === before + 1, JSON.stringify(h));
      const { data: ppRow } = await admin.from("patient_prescriptions").select("current_prescription_version_id").eq("id", ppId).single();
      check("current pointer -> newest version", ppRow.current_prescription_version_id === h.body?.versionId);
      check("version 1 byte-identical after every race, stress trial, and replacement", (await versionSnapshot(v1)) === v1Snapshot);
      check("all published versions satisfy both invariants", invariantViolations((await versionsFor(ppId)).map((v) => v.id)) === 0);
    }
  } finally {
    await browser.close();
  }
}

async function teardown() {
  for (const userId of createdUsers) {
    const { data: pp } = await admin.from("patient_prescriptions").select("id").eq("patient_id", userId).maybeSingle();
    if (pp) {
      await admin.from("patient_prescriptions").update({ current_prescription_version_id: null }).eq("id", pp.id);
      await admin.from("prescription_sequence_state").delete().eq("patient_prescription_id", pp.id);
      await admin.from("prescription_drafts").delete().eq("patient_prescription_id", pp.id);
    }
    await admin.from("notifications").delete().eq("patient_id", userId);
    await admin.from("prescription_versions").delete().eq("user_id", userId);
    if (pp) await admin.from("patient_prescriptions").delete().eq("id", pp.id);
  }
  await admin.from("supervisor_patients").delete().in("supervisor_id", createdUsers);
  await admin.from("organization_members").delete().in("user_id", createdUsers);
  await admin.from("profiles").delete().in("id", createdUsers);
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
  const db = new DatabaseSync(LEGACY_DB_PATH);
  try {
    for (const id of legacyLinkIds) db.prepare("DELETE FROM supervisor_patients WHERE id = ?").run(id);
    for (const id of legacyUserIds) db.prepare("DELETE FROM users WHERE id = ?").run(id);
  } finally {
    db.close();
  }
  const { count } = await admin.from("prescription_versions").select("id", { count: "exact", head: true }).in("user_id", createdUsers);
  console.log(`\nteardown: fixture users removed; remaining fixture versions: ${count ?? 0}`);
}

try {
  await main();
} catch (err) {
  fail++;
  console.error("ERROR", err);
} finally {
  await teardown().catch((e) => console.error("teardown error", e));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
