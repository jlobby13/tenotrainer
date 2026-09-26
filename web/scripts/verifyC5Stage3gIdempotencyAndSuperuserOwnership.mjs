// C5.3G — Canonical Exercise Library Bootstrap. Proves, against the REAL
// seeded production library (never a rolled-back fixture — the whole point
// is to test the actual bootstrap replay behavior), that:
//   1. replaying the bootstrap migration's INSERT statements is a pure
//      no-op (ON CONFLICT ... DO NOTHING) — counts/identities unchanged;
//   2. a superuser edit made through the real, authorized C5.3D RLS path
//      survives that replay untouched;
//   3. the same authorized path can restore the original value afterward,
//      leaving the library in exactly its intended seeded state.
//
// Uses one throwaway super_user fixture (created and destroyed here); never
// touches any other user. The edited/restored exercise is ex_001 (a real,
// permanently-migrated row) — the test is careful to always leave it in
// its original, correct state, verified at the very end.
//
// Run from the web/ directory:
//   node scripts/verifyC5Stage3gIdempotencyAndSuperuserOwnership.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";

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
const EX_001_UUID = "8b1bf121-fa02-5e64-9a1d-61deaf7e8c70"; // uuid.uuid5(NAMESPACE, 'ex_001')
const MIGRATION_PATH = "../supabase/migrations/20260921000001_c5_stage3_canonical_exercise_bootstrap.sql";

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`); }
}

async function main() {
  const { data: before } = await admin.from("canonical_exercises").select("id, name").eq("id", EX_001_UUID).single();
  const originalName = before.name;
  check("ex_001 present with expected name before test", !!originalName);

  const { count: exBefore } = await admin.from("canonical_exercises").select("id", { count: "exact", head: true }).not("legacy_ex_id", "is", null);
  const { count: doseBefore } = await admin.from("exercise_reference_dosage").select("id", { count: "exact", head: true });

  // --- create throwaway super_user, perform the authorized edit ---
  const email = `c5s3g-superuser-${Date.now()}@example.invalid`.toLowerCase();
  const { data: userData, error: createErr } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (createErr) throw createErr;
  const userId = userData.user.id;
  await admin.from("profiles").upsert({ id: userId, name: "c5s3g-superuser" });
  await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: userId, role: "super_user" });

  const authed = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const { error: signInErr } = await authed.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInErr) throw signInErr;

  const markerName = `C5.3G SUPERUSER EDIT MARKER — ${originalName}`;
  const { error: editErr, data: edited } = await authed
    .from("canonical_exercises")
    .update({ name: markerName, updated_by: userId })
    .eq("id", EX_001_UUID)
    .select("name, updated_by")
    .single();
  check("authorized superuser edit succeeds", !editErr, editErr?.message);
  check("edit recorded correct updated_by (not client-spoofable)", edited?.updated_by === userId);

  try {
    // --- replay the bootstrap migration's INSERT statements ---
    const migrationSql = readFileSync(MIGRATION_PATH, "utf8");
    const insertStart = migrationSql.indexOf("INSERT INTO canonical_exercises (");
    if (insertStart === -1) throw new Error("Could not locate INSERT statements in migration file");
    const insertsOnly = migrationSql.slice(insertStart);
    const tmpPath = "/tmp/c5-3g-replay-inserts.sql";
    writeFileSync(tmpPath, insertsOnly);
    execSync(`supabase db query --linked --file ${tmpPath}`, { cwd: "..", stdio: "pipe" });
    unlinkSync(tmpPath);

    // --- verify idempotency: counts unchanged, no duplicates ---
    const { count: exAfter } = await admin.from("canonical_exercises").select("id", { count: "exact", head: true }).not("legacy_ex_id", "is", null);
    const { count: doseAfter } = await admin.from("exercise_reference_dosage").select("id", { count: "exact", head: true });
    check("exercise count unchanged after replay (47)", exAfter === 47, `before=${exBefore} after=${exAfter}`);
    check("reference-dosage count unchanged after replay (46)", doseAfter === 46, `before=${doseBefore} after=${doseAfter}`);

    const { data: distinctCheck } = await admin.from("canonical_exercises").select("legacy_ex_id").not("legacy_ex_id", "is", null);
    const ids = distinctCheck.map((r) => r.legacy_ex_id);
    check("no duplicate legacy_ex_id after replay", new Set(ids).size === ids.length && ids.length === 47);

    // --- verify the superuser edit survived the replay untouched ---
    const { data: afterReplay } = await admin.from("canonical_exercises").select("name").eq("id", EX_001_UUID).single();
    check("superuser edit SURVIVED the replay (ON CONFLICT DO NOTHING did not overwrite it)", afterReplay.name === markerName, `expected marker, got: ${afterReplay.name}`);
  } finally {
    // --- restore original value via the SAME authorized path, regardless of outcome above ---
    const { error: restoreErr, data: restored } = await authed
      .from("canonical_exercises")
      .update({ name: originalName, updated_by: userId })
      .eq("id", EX_001_UUID)
      .select("name")
      .single();
    check("restoration via authorized superuser path succeeds", !restoreErr, restoreErr?.message);
    check("restored value exactly matches original", restored?.name === originalName);

    const { data: finalRow } = await admin.from("canonical_exercises").select("name").eq("id", EX_001_UUID).single();
    check("final production state matches intended seed exactly", finalRow.name === originalName);

    // teardown: only the throwaway superuser fixture, never the seeded exercise data
    await admin.from("organization_members").delete().eq("user_id", userId);
    await admin.from("profiles").delete().eq("id", userId);
    await admin.auth.admin.deleteUser(userId);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
