// C5.3D — Canonical Library Administration Foundation. Live RLS
// verification. Uses the anon-key Supabase client, signed in as real
// throwaway fixture users of each role, to exercise the ACTUAL Postgres
// RLS policies exactly as a real request would — not the service-role
// client, which bypasses RLS entirely and would prove nothing here.
//
// Entirely throwaway fixture users, full teardown via the admin
// (service-role) client in `finally`, matching every other C5 verify
// script's convention.
//
// Run from the web/ directory:
//   node scripts/verifyC5Stage3dCanonicalLibraryAdmin.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

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

async function makeUser(label, role) {
  const email = `c5s3d-verify-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const userId = data.user.id;
  await admin.from("profiles").upsert({ id: userId, name: label });
  await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: userId, role });
  return { userId, email };
}
function authedClient() {
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
async function signIn(email) {
  const client = authedClient();
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return client;
}

async function main() {
  const superUser = await makeUser("super", "super_user");
  const clinicianAdmin = await makeUser("cadmin", "clinician_admin");
  const clinician = await makeUser("clinician", "clinician");
  const member = await makeUser("member", "member");
  const otherClinicianOwner = await makeUser("owner", "clinician");

  let globalExerciseId = null;
  let privateExerciseId = null;
  const cleanupExerciseIds = [];

  try {
    // Seed a global exercise via service-role (simulating the future 47-exercise
    // seed's own write path) and a private exercise owned by a different clinician.
    const { data: globalRow, error: globalErr } = await admin
      .from("canonical_exercises")
      .insert({ name: "C5.3D verify seeded global", visibility: "global", created_by: null })
      .select("id")
      .single();
    if (globalErr) throw globalErr;
    globalExerciseId = globalRow.id;
    cleanupExerciseIds.push(globalExerciseId);

    const { data: privateRow, error: privateErr } = await admin
      .from("canonical_exercises")
      .insert({ name: "C5.3D verify private", visibility: "private", owner_clinician_id: otherClinicianOwner.userId })
      .select("id")
      .single();
    if (privateErr) throw privateErr;
    privateExerciseId = privateRow.id;
    cleanupExerciseIds.push(privateExerciseId);

    const superClient = await signIn(superUser.email);
    const cadminClient = await signIn(clinicianAdmin.email);
    const clinicianClient = await signIn(clinician.email);
    const memberClient = await signIn(member.email);

    // --- super_user can create a global exercise, created_by set correctly ---
    const { data: created, error: createErr } = await superClient
      .from("canonical_exercises")
      .insert({ name: "C5.3D verify new global", visibility: "global", created_by: superUser.userId })
      .select("id, created_by")
      .single();
    check("super_user create global exercise -> succeeds", !createErr, createErr?.message);
    if (created) {
      cleanupExerciseIds.push(created.id);
      check("created row records correct created_by", created.created_by === superUser.userId);
    }

    // --- super_user can edit the global exercise ---
    const { data: updated, error: updateErr } = await superClient
      .from("canonical_exercises")
      .update({ name: "C5.3D verify seeded global (edited)", updated_by: superUser.userId })
      .eq("id", globalExerciseId)
      .select("name, updated_by")
      .maybeSingle();
    check("super_user update global exercise -> succeeds", !updateErr && !!updated, updateErr?.message);
    check("updated row records correct updated_by", updated?.updated_by === superUser.userId);

    // --- archive / reactivate ---
    const { error: archiveErr } = await superClient.from("canonical_exercises").update({ active: false, updated_by: superUser.userId }).eq("id", globalExerciseId);
    check("super_user archive (active=false) -> succeeds", !archiveErr, archiveErr?.message);
    const { data: afterArchive } = await admin.from("canonical_exercises").select("active").eq("id", globalExerciseId).single();
    check("archived row has active=false", afterArchive?.active === false);

    const { error: reactivateErr } = await superClient.from("canonical_exercises").update({ active: true, updated_by: superUser.userId }).eq("id", globalExerciseId);
    check("super_user reactivate (active=true) -> succeeds", !reactivateErr, reactivateErr?.message);

    // --- reference dosage: create/update/delete ---
    const { data: dosageRow, error: dosageCreateErr } = await superClient
      .from("exercise_reference_dosage")
      .insert({ exercise_id: globalExerciseId, dosage_type: "repetition", sets: 3, reps_mode: "exact", reps_exact: 10 })
      .select("id")
      .single();
    check("super_user create reference dosage for global exercise -> succeeds", !dosageCreateErr, dosageCreateErr?.message);

    if (dosageRow) {
      const { error: dosageUpdateErr } = await superClient.from("exercise_reference_dosage").update({ reps_exact: 12 }).eq("id", dosageRow.id);
      check("super_user update reference dosage -> succeeds", !dosageUpdateErr, dosageUpdateErr?.message);

      const { error: dosageDeleteErr } = await superClient.from("exercise_reference_dosage").delete().eq("id", dosageRow.id);
      check("super_user delete reference dosage row -> succeeds", !dosageDeleteErr, dosageDeleteErr?.message);

      const { data: exerciseStillThere } = await admin.from("canonical_exercises").select("id").eq("id", globalExerciseId).maybeSingle();
      check("deleting reference dosage does NOT delete the canonical exercise itself", !!exerciseStillThere);
    }

    // --- canonical_exercises DELETE remains unavailable to everyone ---
    const { error: superDeleteErr } = await superClient.from("canonical_exercises").delete().eq("id", globalExerciseId);
    check("super_user CANNOT delete canonical_exercises row (no grant/policy)", !!superDeleteErr, "expected an error, got none");
    const { data: stillExists } = await admin.from("canonical_exercises").select("id").eq("id", globalExerciseId).maybeSingle();
    check("global exercise still exists after attempted delete", !!stillExists);

    // --- other roles cannot create/edit global exercises ---
    const { error: cadminCreateErr } = await cadminClient.from("canonical_exercises").insert({ name: "should fail", visibility: "global" });
    check("clinician_admin CANNOT create global exercise", !!cadminCreateErr);
    await cadminClient.from("canonical_exercises").update({ name: "should fail" }).eq("id", globalExerciseId);
    // An RLS-blocked UPDATE matches zero rows and returns success with no
    // error (PostgREST semantics) — the only reliable check is the
    // resulting state, read back via the service-role client.
    const { data: afterCadminAttempt } = await admin.from("canonical_exercises").select("name").eq("id", globalExerciseId).single();
    check("clinician_admin update had zero effect on the row", afterCadminAttempt.name === "C5.3D verify seeded global (edited)");

    const { error: clinicianCreateErr } = await clinicianClient.from("canonical_exercises").insert({ name: "should fail", visibility: "global" });
    check("clinician CANNOT create global exercise", !!clinicianCreateErr);

    const { error: memberCreateErr } = await memberClient.from("canonical_exercises").insert({ name: "should fail", visibility: "global" });
    check("member (patient-tier) CANNOT create global exercise", !!memberCreateErr);

    const { error: cadminDosageErr } = await cadminClient.from("exercise_reference_dosage").insert({ exercise_id: globalExerciseId, dosage_type: "repetition", sets: 3, reps_mode: "exact", reps_exact: 5 });
    check("clinician_admin CANNOT create reference dosage for global exercise", !!cadminDosageErr);

    // --- ownership invariant enforcement ---
    const { error: ownerSetErr } = await superClient
      .from("canonical_exercises")
      .insert({ name: "should fail: owner set on global", visibility: "global", owner_clinician_id: superUser.userId });
    check("global exercise CANNOT be created with owner_clinician_id set", !!ownerSetErr);

    const { error: orgSetErr } = await superClient
      .from("canonical_exercises")
      .insert({ name: "should fail: org set on global", visibility: "global", organization_id: REAL_ORG_ID });
    check("global exercise CANNOT be created with organization_id set", !!orgSetErr);

    // --- non-superuser cannot transform a private exercise into global ---
    const ownerClient = await signIn(otherClinicianOwner.email);
    await ownerClient.from("canonical_exercises").update({ visibility: "global" }).eq("id", privateExerciseId);
    const { data: stillPrivate } = await admin.from("canonical_exercises").select("visibility").eq("id", privateExerciseId).single();
    check("private exercise remains private after attempted self-promotion", stillPrivate.visibility === "private");

    // --- super_user cannot use THIS permission to turn a global exercise into private/org_shared ---
    await superClient
      .from("canonical_exercises")
      .update({ visibility: "private", owner_clinician_id: superUser.userId })
      .eq("id", globalExerciseId);
    const { data: stillGlobal } = await admin.from("canonical_exercises").select("visibility").eq("id", globalExerciseId).single();
    check("exercise remains global after attempted demotion", stillGlobal.visibility === "global");

    // --- provenance cannot be spoofed ---
    const { error: spoofCreateErr } = await superClient
      .from("canonical_exercises")
      .insert({ name: "should fail: spoofed created_by", visibility: "global", created_by: clinicianAdmin.userId });
    check("super_user CANNOT spoof created_by to another user's id", !!spoofCreateErr);

    await superClient
      .from("canonical_exercises")
      .update({ name: "spoofed update", updated_by: clinicianAdmin.userId })
      .eq("id", globalExerciseId);
    const { data: afterSpoofAttempt } = await admin.from("canonical_exercises").select("updated_by").eq("id", globalExerciseId).single();
    check("updated_by was not overwritten by the spoofing attempt", afterSpoofAttempt.updated_by === superUser.userId);

    // --- created_by = NULL is valid for system/legacy origin (service-role insert, already proven at setup) ---
    const { data: nullCreatedBy } = await admin.from("canonical_exercises").select("created_by").eq("id", globalExerciseId).maybeSingle();
    check("system/legacy-origin row may have created_by = NULL", nullCreatedBy.created_by === null);
  } finally {
    for (const id of cleanupExerciseIds) {
      await admin.from("exercise_reference_dosage").delete().eq("exercise_id", id);
      await admin.from("canonical_exercises").delete().eq("id", id);
    }
    const allUserIds = [superUser, clinicianAdmin, clinician, member, otherClinicianOwner].map((u) => u.userId);
    await admin.from("organization_members").delete().in("user_id", allUserIds);
    await admin.from("profiles").delete().in("id", allUserIds);
    for (const id of allUserIds) {
      await admin.auth.admin.deleteUser(id);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
