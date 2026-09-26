// C5.3 — Draft & Publish Engine. Live HTTP-layer verification. Drives the
// REAL Next.js API routes over authenticated HTTP via Playwright, using
// entirely throwaway fixture users — never the founder's own real clinical
// data. Mirrors verifyC4PatientReview.mjs's conventions exactly (makeUser/
// addOrgMember/loginContext, REAL_ORG_ID, full teardown in `finally`).
//
// This complements web/scripts/verifyC5Stage3DraftPublishEngine.sql (which
// already exhaustively covers RPC-level mechanics inside one rolled-back
// transaction). This script's job is the layer that SQL script cannot
// cover: real session cookies, real requireClinicianAuthForRoute() wiring,
// and the LIVE C5_PRESCRIPTION_PUBLISH_ENABLED gate as currently configured
// on the running dev server (this environment does not set it, so publish
// is expected to return PUBLISH_DISABLED — the exact default-safe behavior
// C5.3B locked).
//
// Requires: `next dev` running on localhost:3000, web/.env.local populated.
// Point at a dev/staging Supabase project only.
//
// Run from the web/ directory:
//   node scripts/verifyC5Stage3HttpLayer.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";

// createDraft/publish/pause/resume are high-consequence (C5.3B decision 1):
// they require a POSITIVE synchronous confirmation from the legacy
// SQLite supervisor_patients table, not just the Postgres mirror. A
// throwaway Supabase-only fixture has no legacy counterpart at all, so
// without also seeding legacy SQLite here, every one of those calls would
// correctly (and instructively) fail closed with PATIENT_NOT_AUTHORIZED —
// which is itself a real, valuable confirmation of the fail-closed
// property, but does not exercise the positive path. This script seeds a
// real, throwaway legacy SQLite users/supervisor_patients pair (deleted in
// teardown) specifically so createDraft's positive path can be verified
// end-to-end, matching what a real active clinician-patient relationship
// looks like on both systems.
const LEGACY_DB_PATH = "../app/tenotrainer.db";

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
const BASE_URL = "http://localhost:3000";
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
const PASSWORD = "throwaway-verification-1!";

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

async function makeUser(label) {
  const email = `c5s3-verify-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const userId = data.user.id;
  const { error: profileError } = await admin.from("profiles").upsert({ id: userId, name: label });
  if (profileError) throw profileError;
  return { userId, email };
}
async function addOrgMember(userId, role) {
  const { error } = await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: userId, role });
  if (error) throw error;
}
async function loginContext(browser, email) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
  await page.close();
  return context;
}

async function main() {
  const clinician1 = await makeUser("owner");
  const clinician2 = await makeUser("other");
  const patient1 = await makeUser("patient"); // has BOTH PG and legacy active relationships -> full positive path
  const patient2 = await makeUser("patient-pg-only"); // PG-only relationship, no legacy row -> fail-closed path
  let patientPrescriptionId = null;
  let legacyClinicianId = null;
  let legacyPatientId = null;

  const legacyDb = new DatabaseSync(LEGACY_DB_PATH);
  try {
    const insertUser = legacyDb.prepare("INSERT INTO users (name, email, role, supabase_id) VALUES (?, ?, ?, ?)");
    legacyClinicianId = insertUser.run("c5s3-verify-owner", clinician1.email, "supervisor", clinician1.userId).lastInsertRowid;
    legacyPatientId = insertUser.run("c5s3-verify-patient", patient1.email, "patient", patient1.userId).lastInsertRowid;
    legacyDb
      .prepare("INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (?, ?, 'active')")
      .run(legacyClinicianId, legacyPatientId);
  } finally {
    legacyDb.close();
  }

  try {
    await addOrgMember(clinician1.userId, "clinician");
    await addOrgMember(clinician2.userId, "clinician");
    await addOrgMember(patient1.userId, "member");
    await addOrgMember(patient2.userId, "member");
    const { error: sp1Error } = await admin
      .from("supervisor_patients")
      .insert({ supervisor_id: clinician1.userId, patient_id: patient1.userId, status: "active" });
    if (sp1Error) throw sp1Error;
    const { error: sp2Error } = await admin
      .from("supervisor_patients")
      .insert({ supervisor_id: clinician2.userId, patient_id: patient1.userId, status: "active" });
    if (sp2Error) throw sp2Error;
    const { error: sp3Error } = await admin
      .from("supervisor_patients")
      .insert({ supervisor_id: clinician1.userId, patient_id: patient2.userId, status: "active" });
    if (sp3Error) throw sp3Error;

    const browser = await chromium.launch();
    try {
      const ctxOwner = await loginContext(browser, clinician1.email);
      const ctxOther = await loginContext(browser, clinician2.email);
      const ctxAnon = await browser.newContext(); // no login at all

      // --- unauthenticated ---
      // Caught by the app-wide proxy.ts (a pre-existing global auth gate,
      // not part of this stage) before it ever reaches our route handler —
      // hence "Unauthorized" rather than our own UNAUTHENTICATED code.
      // requireClinicianForRoute()'s own UNAUTHENTICATED branch is
      // consequently unreachable for a fully-anonymous request in
      // practice; it remains meaningful for an authenticated-but-
      // non-clinician-role caller, which proxy.ts does not check.
      const anonResp = await ctxAnon.request.post(`${BASE_URL}/api/clinician/patients/${patient1.userId}/prescription-drafts`, {
        data: { source: "empty" },
      });
      check("unauthenticated createDraft -> 401", anonResp.status() === 401, `got ${anonResp.status()}`);
      const anonBody = await anonResp.json().catch(() => ({}));
      check("unauthenticated body carries an auth-denial code (proxy.ts's own, ahead of our route)", anonBody.error === "Unauthorized", JSON.stringify(anonBody));

      // --- createDraft against a PG-only relationship (no legacy SQLite
      // counterpart) MUST fail closed, even though the PG mirror itself
      // says active — proves there is no PG-only fallback path. ---
      const pgOnlyResp = await ctxOwner.request.post(`${BASE_URL}/api/clinician/patients/${patient2.userId}/prescription-drafts`, {
        data: { source: "empty" },
      });
      check(
        "createDraft against PG-only relationship -> 403 PATIENT_NOT_AUTHORIZED (fail closed, no PG-only fallback)",
        pgOnlyResp.status() === 403,
        `got ${pgOnlyResp.status()}: ${await pgOnlyResp.text()}`
      );
      const pgOnlyBody = await pgOnlyResp.json().catch(() => ({}));
      check("PG-only fail-closed body carries PATIENT_NOT_AUTHORIZED", pgOnlyBody.error === "PATIENT_NOT_AUTHORIZED", JSON.stringify(pgOnlyBody));

      // --- createDraft (owner, patient1 — has BOTH PG and legacy active) ---
      const createResp = await ctxOwner.request.post(`${BASE_URL}/api/clinician/patients/${patient1.userId}/prescription-drafts`, {
        data: { source: "empty" },
      });
      check("owner createDraft -> 201", createResp.status() === 201, `got ${createResp.status()}: ${await createResp.text()}`);
      const { draftId } = await createResp.json();
      check("createDraft returns a draftId", typeof draftId === "string" && draftId.length > 0);

      const { data: ppRow } = await admin.from("patient_prescriptions").select("id").eq("patient_id", patient1.userId).maybeSingle();
      patientPrescriptionId = ppRow?.id ?? null;
      check("patient_prescriptions row exists after createDraft", !!patientPrescriptionId);

      // --- getDraft (owner, then other authorized clinician: both allowed to READ) ---
      const getOwnerResp = await ctxOwner.request.get(`${BASE_URL}/api/clinician/prescription-drafts/${draftId}`);
      check("owner getDraft -> 200", getOwnerResp.status() === 200, `got ${getOwnerResp.status()}`);

      const getOtherResp = await ctxOther.request.get(`${BASE_URL}/api/clinician/prescription-drafts/${draftId}`);
      check("other authorized clinician getDraft -> 200 (view allowed)", getOtherResp.status() === 200, `got ${getOtherResp.status()}`);

      // --- other clinician cannot MUTATE ---
      const otherPatchResp = await ctxOther.request.fetch(`${BASE_URL}/api/clinician/prescription-drafts/${draftId}`, {
        method: "PATCH",
        data: { phase: "early" },
      });
      check("other clinician updateDraftMetadata -> 403 DRAFT_NOT_OWNED_BY_CALLER", otherPatchResp.status() === 403, `got ${otherPatchResp.status()}`);
      const otherPatchBody = await otherPatchResp.json().catch(() => ({}));
      check("other clinician mutation body carries DRAFT_NOT_OWNED_BY_CALLER", otherPatchBody.error === "DRAFT_NOT_OWNED_BY_CALLER", JSON.stringify(otherPatchBody));

      // --- owner CAN mutate ---
      const ownerPatchResp = await ctxOwner.request.fetch(`${BASE_URL}/api/clinician/prescription-drafts/${draftId}`, {
        method: "PATCH",
        data: { phase: "early" },
      });
      check("owner updateDraftMetadata -> 200", ownerPatchResp.status() === 200, `got ${ownerPatchResp.status()}: ${await ownerPatchResp.text()}`);

      // --- addWorkout (owner) ---
      const addWorkoutResp = await ctxOwner.request.post(`${BASE_URL}/api/clinician/prescription-drafts/${draftId}/workouts`, {
        data: { orderIndex: 0 },
      });
      check("owner addWorkout -> 201", addWorkoutResp.status() === 201, `got ${addWorkoutResp.status()}: ${await addWorkoutResp.text()}`);

      // --- validateDraft (should fail: no active exercise yet) ---
      const validateResp = await ctxOwner.request.get(`${BASE_URL}/api/clinician/prescription-drafts/${draftId}/validate`);
      check("validateDraft -> 200", validateResp.status() === 200);
      const validateBody = await validateResp.json();
      check("validateDraft reports NOT publishable (no active exercise yet)", validateBody.publishable === false, JSON.stringify(validateBody));

      // --- publish -> PUBLISH_DISABLED (live default-safe gate, no bypass by omission) ---
      const publishResp = await ctxOwner.request.post(`${BASE_URL}/api/clinician/prescription-drafts/${draftId}/publish`);
      check("owner publish (gate unset in this env) -> 403 PUBLISH_DISABLED", publishResp.status() === 403, `got ${publishResp.status()}: ${await publishResp.text()}`);
      const publishBody = await publishResp.json().catch(() => ({}));
      check("publish body carries PUBLISH_DISABLED code, not a DB/validation error", publishBody.error === "PUBLISH_DISABLED", JSON.stringify(publishBody));

      // --- pause/resume: patient1 has a real legacy relationship too, so
      // the high-consequence check should positively confirm and succeed.
      const pauseResp = await ctxOwner.request.post(`${BASE_URL}/api/clinician/patients/${patient1.userId}/prescription/pause`);
      check("pause with real legacy relationship -> 200", pauseResp.status() === 200, `got ${pauseResp.status()}: ${await pauseResp.text()}`);

      const resumeResp = await ctxOwner.request.post(`${BASE_URL}/api/clinician/patients/${patient1.userId}/prescription/resume`);
      check("resume with real legacy relationship -> 200", resumeResp.status() === 200, `got ${resumeResp.status()}: ${await resumeResp.text()}`);

      // --- pause against the PG-only patient2 -> fail closed, same as createDraft above ---
      const pausePgOnlyResp = await ctxOwner.request.post(`${BASE_URL}/api/clinician/patients/${patient2.userId}/prescription/pause`);
      check(
        "pause against PG-only relationship -> 403 PATIENT_NOT_AUTHORIZED (fail closed)",
        pausePgOnlyResp.status() === 403,
        `got ${pausePgOnlyResp.status()}: ${await pausePgOnlyResp.text()}`
      );

      // --- discard (owner) ---
      const discardResp = await ctxOwner.request.fetch(`${BASE_URL}/api/clinician/prescription-drafts/${draftId}`, { method: "DELETE" });
      check("owner discardDraft -> 200", discardResp.status() === 200, `got ${discardResp.status()}`);

      await ctxOwner.close();
      await ctxOther.close();
      await ctxAnon.close();
    } finally {
      await browser.close();
    }
  } finally {
    // Teardown — deleting patient_prescriptions cascades to
    // drafts/workouts/exercises/dosage/sequence_state/notifications.
    if (patientPrescriptionId) {
      await admin.from("patient_prescriptions").delete().eq("id", patientPrescriptionId);
    }
    await admin.from("supervisor_patients").delete().in("patient_id", [patient1.userId, patient2.userId]);
    await admin.from("organization_members").delete().in("user_id", [clinician1.userId, clinician2.userId, patient1.userId, patient2.userId]);
    await admin.from("profiles").delete().in("id", [clinician1.userId, clinician2.userId, patient1.userId, patient2.userId]);
    await admin.auth.admin.deleteUser(clinician1.userId);
    await admin.auth.admin.deleteUser(clinician2.userId);
    await admin.auth.admin.deleteUser(patient1.userId);
    await admin.auth.admin.deleteUser(patient2.userId);

    const legacyDbTeardown = new DatabaseSync(LEGACY_DB_PATH);
    try {
      if (legacyClinicianId != null && legacyPatientId != null) {
        legacyDbTeardown.prepare("DELETE FROM supervisor_patients WHERE supervisor_id = ? AND patient_id = ?").run(legacyClinicianId, legacyPatientId);
      }
      if (legacyClinicianId != null) legacyDbTeardown.prepare("DELETE FROM users WHERE id = ?").run(legacyClinicianId);
      if (legacyPatientId != null) legacyDbTeardown.prepare("DELETE FROM users WHERE id = ?").run(legacyPatientId);
    } finally {
      legacyDbTeardown.close();
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
