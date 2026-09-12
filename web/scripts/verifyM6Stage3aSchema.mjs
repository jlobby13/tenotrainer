// Milestone 6, Stage 3A — schema/RLS/provenance verification for the
// longitudinal-interpretation storage + heuristics/evidence catalog
// architecture. Pure backend/DB verification — no browser needed (Stage 3A
// adds no UI). Uses the anon key + a real signed-in session (not
// Playwright) to exercise RLS as an actual patient would see it, alongside
// the service-role client for setup/teardown and for the trusted-write
// path these tables are designed around.
//
// IMPORTANT: this script requires the two Stage 3A migrations
// (20260911000006_m6_stage3a_heuristics_evidence_catalog.sql and
// 20260911000007_m6_stage3a_longitudinal_interpretations.sql) to already be
// applied to the target Supabase project. It could not be run during the
// Stage 3A implementation pass itself because this session has no Supabase
// CLI access token / direct Postgres connection to apply them (see the
// Stage 3A report) — run this once the founder has applied the migrations,
// before Stage 3B begins building against this schema.
//
// Run from the web/ directory:
//   node scripts/verifyM6Stage3aSchema.mjs
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
const RULESET_V1 = "m6_longitudinal_v1";
const RULESET_V2_FIXTURE = "m6_longitudinal_v2_fixture"; // fixture only — not a real future version, just proves coexistence

function genUuid() {
  return crypto.randomUUID();
}

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

async function makeUser(label, role = "member") {
  const email = `m6-stage3a-verify-${label}-${Date.now()}@example.invalid`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const userId = data.user.id;
  await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: userId, role });
  return { userId, email };
}

async function anonClientSignedInAs(email) {
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return client;
}

async function cleanup({ interpretationIds, sessionIds, heuristicIds, evidenceIds, userIds }) {
  if (interpretationIds.length > 0) {
    await admin.from("m6_interpretation_reason_codes").delete().in("interpretation_id", interpretationIds);
    await admin.from("m6_interpretation_rehab_sessions").delete().in("interpretation_id", interpretationIds);
    await admin.from("m6_interpretation_morning_responses").delete().in("interpretation_id", interpretationIds);
    await admin.from("m6_interpretation_tolerance_evaluations").delete().in("interpretation_id", interpretationIds);
    await admin.from("m6_interpretation_prescription_versions").delete().in("interpretation_id", interpretationIds);
    await admin.from("m6_interpretation_heuristics").delete().in("interpretation_id", interpretationIds);
  }
  await admin.from("m6_longitudinal_interpretations").delete().in("id", interpretationIds);
  if (sessionIds.length > 0) {
    await admin.from("morning_responses").delete().in("rehab_session_id", sessionIds);
    await admin.from("tolerance_evaluations").delete().in("rehab_session_id", sessionIds);
  }
  await admin.from("rehab_sessions").delete().in("id", sessionIds);
  for (const userId of userIds) {
    await admin.from("prescription_versions").delete().eq("user_id", userId);
  }
  if (heuristicIds.length > 0) {
    await admin.from("m6_heuristic_evidence").delete().in("heuristic_id", heuristicIds);
  }
  await admin.from("m6_heuristics").delete().in("id", heuristicIds);
  await admin.from("m6_evidence_sources").delete().in("id", evidenceIds);
  for (const userId of userIds) {
    await admin.from("organization_members").delete().eq("user_id", userId);
    await admin.from("profiles").delete().eq("id", userId);
    await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
}

async function main() {
  const interpretationIds = [];
  const sessionIds = [];
  const heuristicIds = [];
  const evidenceIds = [];
  const userIds = [];

  try {
    const userA = await makeUser("a");
    const userB = await makeUser("b");
    const clinicianAssigned = await makeUser("clinician-assigned", "clinician_admin");
    const clinicianUnrelated = await makeUser("clinician-unrelated", "clinician_admin");
    userIds.push(userA.userId, userB.userId, clinicianAssigned.userId, clinicianUnrelated.userId);
    await admin.from("supervisor_patients").insert({ supervisor_id: clinicianAssigned.userId, patient_id: userA.userId, status: "active" });

    // --- Minimal raw-observation fixtures to link provenance against ---
    const { data: version } = await admin
      .from("prescription_versions")
      .insert({ user_id: userA.userId, stage: 1, irritability: "low", is_insertional: false, source: "onboarding" })
      .select()
      .single();

    const sessionId = genUuid();
    sessionIds.push(sessionId);
    await admin.from("rehab_sessions").insert({
      id: sessionId,
      user_id: userA.userId,
      prescription_instance_id: `${sessionId}:i`,
      patient_local_date: "2026-09-01",
      started_at: "2026-09-01T14:00:00Z",
      status: "response_complete",
      prescription_snapshot: [],
      peak_session_pain: 3,
      prescription_version_id: version.id,
    });
    const { data: morning } = await admin
      .from("morning_responses")
      .insert({ rehab_session_id: sessionId, user_id: userA.userId, next_morning_pain: 2, next_morning_stiffness: 2, stiffness_duration: "lt_5_min", submitted_at: new Date().toISOString() })
      .select()
      .single();
    const { data: tolerance } = await admin
      .from("tolerance_evaluations")
      .insert({
        rehab_session_id: sessionId,
        morning_response_id: morning.id,
        tolerance_classification: "well_tolerated",
        immediate_guidance: "maintain",
        patient_facing_label: "Well Tolerated",
        reason: "fixture",
        rule_version: "v1",
        inputs_snapshot: {},
      })
      .select()
      .single();

    // --- Heuristics + Evidence Catalog fixtures ---
    const { data: heuristic } = await admin
      .from("m6_heuristics")
      .insert({
        heuristic_key: `test_rolling_window_${Date.now()}`,
        name: "Test rolling window (fixture)",
        description: "Fixture heuristic for Stage 3A schema verification only.",
        version_introduced: RULESET_V1,
        status: "proposed",
      })
      .select()
      .single();
    heuristicIds.push(heuristic.id);

    const { data: evidence } = await admin
      .from("m6_evidence_sources")
      .insert({ title: "Fixture evidence source for Stage 3A verification", status: "active", does_not_establish: "Does not establish anything — fixture only." })
      .select()
      .single();
    evidenceIds.push(evidence.id);

    const { error: linkError } = await admin
      .from("m6_heuristic_evidence")
      .insert({ heuristic_id: heuristic.id, evidence_source_id: evidence.id, notes: "fixture link" });
    check("heuristic <-> evidence link inserts cleanly", !linkError, linkError?.message);

    const { data: evidenceForHeuristic } = await admin
      .from("m6_heuristic_evidence")
      .select("evidence_source_id")
      .eq("heuristic_id", heuristic.id);
    check("heuristic <-> evidence relationship reads back correctly", evidenceForHeuristic?.[0]?.evidence_source_id === evidence.id);

    // --- Interpretation v1 ---
    const { data: interp1, error: interp1Error } = await admin
      .from("m6_longitudinal_interpretations")
      .insert({
        user_id: userA.userId,
        domain: "symptoms_short_window",
        ruleset_version: RULESET_V1,
        window_definition: { kind: "rolling_5_plus_5" },
        window_start_date: "2026-08-25",
        window_end_date: "2026-09-01",
        result_state: "insufficient_data",
        result_detail: { observedCount: 1 },
      })
      .select()
      .single();
    check("interpretation row inserts and ruleset_version persists", !interp1Error && interp1?.ruleset_version === RULESET_V1, interp1Error?.message);
    if (interp1) interpretationIds.push(interp1.id);

    // Multiple reason codes on one interpretation
    const { error: reasonError } = await admin.from("m6_interpretation_reason_codes").insert([
      { interpretation_id: interp1.id, reason_code: "limited_coverage" },
      { interpretation_id: interp1.id, reason_code: "recent_prescription_change" },
    ]);
    check("multiple reason codes attach to one interpretation", !reasonError, reasonError?.message);
    const { data: reasonRows } = await admin.from("m6_interpretation_reason_codes").select("reason_code").eq("interpretation_id", interp1.id);
    check("both reason codes read back", (reasonRows ?? []).length === 2);

    // Provenance links across all four source types + heuristic used
    await admin.from("m6_interpretation_rehab_sessions").insert({ interpretation_id: interp1.id, rehab_session_id: sessionId });
    await admin.from("m6_interpretation_morning_responses").insert({ interpretation_id: interp1.id, morning_response_id: morning.id });
    await admin.from("m6_interpretation_tolerance_evaluations").insert({ interpretation_id: interp1.id, tolerance_evaluation_id: tolerance.id });
    await admin.from("m6_interpretation_prescription_versions").insert({ interpretation_id: interp1.id, prescription_version_id: version.id });
    await admin.from("m6_interpretation_heuristics").insert({ interpretation_id: interp1.id, heuristic_id: heuristic.id });

    const [sessRow, morningRow, tolRow, presRow, heurRow] = await Promise.all([
      admin.from("m6_interpretation_rehab_sessions").select("rehab_session_id").eq("interpretation_id", interp1.id).maybeSingle(),
      admin.from("m6_interpretation_morning_responses").select("morning_response_id").eq("interpretation_id", interp1.id).maybeSingle(),
      admin.from("m6_interpretation_tolerance_evaluations").select("tolerance_evaluation_id").eq("interpretation_id", interp1.id).maybeSingle(),
      admin.from("m6_interpretation_prescription_versions").select("prescription_version_id").eq("interpretation_id", interp1.id).maybeSingle(),
      admin.from("m6_interpretation_heuristics").select("heuristic_id").eq("interpretation_id", interp1.id).maybeSingle(),
    ]);
    check("provenance: rehab_session link survives/reads correctly", sessRow.data?.rehab_session_id === sessionId);
    check("provenance: morning_response link survives/reads correctly", morningRow.data?.morning_response_id === morning.id);
    check("provenance: tolerance_evaluation link survives/reads correctly", tolRow.data?.tolerance_evaluation_id === tolerance.id);
    check("provenance: prescription_version link survives/reads correctly", presRow.data?.prescription_version_id === version.id);
    check("provenance: heuristic-used link survives/reads correctly", heurRow.data?.heuristic_id === heuristic.id);

    // --- Interpretation v2 (new ruleset version) coexists; v1 untouched ---
    const { data: interp2, error: interp2Error } = await admin
      .from("m6_longitudinal_interpretations")
      .insert({
        user_id: userA.userId,
        domain: "symptoms_short_window",
        ruleset_version: RULESET_V2_FIXTURE,
        result_state: "stable",
        window_start_date: "2026-09-02",
        window_end_date: "2026-09-09",
      })
      .select()
      .single();
    check("a new-ruleset-version interpretation inserts cleanly alongside the old one", !interp2Error, interp2Error?.message);
    if (interp2) interpretationIds.push(interp2.id);

    const { data: allForDomain } = await admin
      .from("m6_longitudinal_interpretations")
      .select("id, ruleset_version, result_state")
      .eq("user_id", userA.userId)
      .eq("domain", "symptoms_short_window")
      .order("generated_at", { ascending: false });
    check("both interpretation versions coexist (2 rows for this user+domain)", (allForDomain ?? []).length === 2);

    const { data: reread1 } = await admin.from("m6_longitudinal_interpretations").select("ruleset_version, result_state").eq("id", interp1.id).single();
    check(
      "historical interpretation is not silently overwritten by the newer one",
      reread1?.ruleset_version === RULESET_V1 && reread1?.result_state === "insufficient_data"
    );

    // --- RLS: patient reads own data ---
    const clientA = await anonClientSignedInAs(userA.email);
    const { data: ownRead, error: ownReadError } = await clientA.from("m6_longitudinal_interpretations").select("id").eq("id", interp1.id);
    check("RLS: patient can read their own interpretation", !ownReadError && (ownRead ?? []).length === 1, ownReadError?.message);

    // --- RLS: patient cannot write ---
    const { error: writeError } = await clientA.from("m6_longitudinal_interpretations").insert({
      user_id: userA.userId,
      domain: "symptoms_short_window",
      ruleset_version: "patient-forged",
      result_state: "improving",
    });
    check("RLS: patient cannot INSERT an interpretation (no permissive policy + REVOKE)", Boolean(writeError));

    const { error: updateError } = await clientA.from("m6_longitudinal_interpretations").update({ result_state: "improving" }).eq("id", interp1.id);
    check("RLS: patient cannot UPDATE an interpretation", Boolean(updateError) || true); // Supabase returns no error + 0 rows affected for a denied UPDATE with no matching-after-check row; verify via re-read instead
    const { data: rereadAfterAttempt } = await admin.from("m6_longitudinal_interpretations").select("result_state").eq("id", interp1.id).single();
    check("RLS: patient's UPDATE attempt did not actually change the row", rereadAfterAttempt?.result_state === "insufficient_data");

    // --- RLS: a different patient (no supervisor_patients link) cannot read user A's data ---
    const clientB = await anonClientSignedInAs(userB.email);
    const { data: crossRead } = await clientB.from("m6_longitudinal_interpretations").select("id").eq("id", interp1.id);
    check("RLS: an unrelated patient cannot read another patient's interpretation", (crossRead ?? []).length === 0);

    // --- Heuristics/Evidence Catalog RLS: any org member can read ---
    const { data: catalogRead, error: catalogReadError } = await clientA.from("m6_heuristics").select("id").eq("id", heuristic.id);
    check("RLS: an org member (patient) can read the heuristics catalog", !catalogReadError && (catalogRead ?? []).length === 1, catalogReadError?.message);

    const { error: catalogWriteError } = await clientA.from("m6_heuristics").insert({
      heuristic_key: `forged_${Date.now()}`,
      name: "forged",
      description: "forged",
      version_introduced: "x",
    });
    check("RLS: a plain member (not clinician_admin) cannot write to the heuristics catalog", Boolean(catalogWriteError));

    const { error: evidenceWriteError } = await clientA.from("m6_evidence_sources").insert({ title: "forged evidence" });
    check("RLS: a plain member (not clinician_admin) cannot write to the evidence catalog", Boolean(evidenceWriteError));

    const { error: linkWriteError } = await clientA
      .from("m6_heuristic_evidence")
      .insert({ heuristic_id: heuristic.id, evidence_source_id: evidence.id });
    check("RLS: a plain member (not clinician_admin) cannot write heuristic<->evidence links", Boolean(linkWriteError));

    // --- RLS: clinician tenancy model (current: supervisor_patients, matches every other clinical table in M6) ---
    const clinicianAssignedClient = await anonClientSignedInAs(clinicianAssigned.email);
    const { data: clinicianRead, error: clinicianReadError } = await clinicianAssignedClient
      .from("m6_longitudinal_interpretations")
      .select("id")
      .eq("id", interp1.id);
    check(
      "RLS: an assigned clinician (supervisor_patients link) can read the patient's interpretation",
      !clinicianReadError && (clinicianRead ?? []).length === 1,
      clinicianReadError?.message
    );

    const { data: clinicianProvenanceRead, error: clinicianProvenanceError } = await clinicianAssignedClient
      .from("m6_interpretation_heuristics")
      .select("heuristic_id")
      .eq("interpretation_id", interp1.id);
    check(
      "RLS: an assigned clinician can read interpretation provenance (heuristics-used join)",
      !clinicianProvenanceError && (clinicianProvenanceRead ?? []).length === 1,
      clinicianProvenanceError?.message
    );

    const clinicianUnrelatedClient = await anonClientSignedInAs(clinicianUnrelated.email);
    const { data: clinicianCrossRead } = await clinicianUnrelatedClient
      .from("m6_longitudinal_interpretations")
      .select("id")
      .eq("id", interp1.id);
    check(
      "RLS: a clinician with no supervisor_patients link cannot read the patient's interpretation",
      (clinicianCrossRead ?? []).length === 0
    );

    // --- Historical-integrity guard (20260911000008): once a heuristic/evidence
    // source has actually been cited (heuristic is used in interp1's provenance
    // above; evidence is linked to it via m6_heuristic_evidence), a rewrite of
    // its clinically-material fields must be rejected, but harmless
    // metadata/pre-use edits must still work.
    const { error: materialHeuristicRewriteError } = await admin
      .from("m6_heuristics")
      .update({ description: "Materially different rule text (should be rejected)." })
      .eq("id", heuristic.id);
    check(
      "guard: rewriting description of a used heuristic is rejected",
      Boolean(materialHeuristicRewriteError),
      materialHeuristicRewriteError ? undefined : "expected an error but update succeeded"
    );

    const { error: metadataHeuristicEditError } = await admin
      .from("m6_heuristics")
      .update({ known_limitations: "Clarified limitation wording (harmless)." })
      .eq("id", heuristic.id);
    check("guard: editing a non-material field of a used heuristic still succeeds", !metadataHeuristicEditError, metadataHeuristicEditError?.message);

    const { data: heuristicAfterAttempt } = await admin.from("m6_heuristics").select("description").eq("id", heuristic.id).single();
    check(
      "guard: the used heuristic's description is unchanged after the rejected rewrite",
      heuristicAfterAttempt?.description === "Fixture heuristic for Stage 3A schema verification only."
    );

    const { error: materialEvidenceRewriteError } = await admin
      .from("m6_evidence_sources")
      .update({ supports: "A materially different claim (should be rejected)." })
      .eq("id", evidence.id);
    check(
      "guard: rewriting supports/does_not_establish of a cited evidence source is rejected",
      Boolean(materialEvidenceRewriteError),
      materialEvidenceRewriteError ? undefined : "expected an error but update succeeded"
    );

    const { error: metadataEvidenceEditError } = await admin
      .from("m6_evidence_sources")
      .update({ doi: "10.1000/corrected-doi" })
      .eq("id", evidence.id);
    check("guard: correcting DOI on a cited evidence source still succeeds (harmless metadata)", !metadataEvidenceEditError, metadataEvidenceEditError?.message);

    const { data: evidenceAfterAttempt } = await admin
      .from("m6_evidence_sources")
      .select("does_not_establish, doi")
      .eq("id", evidence.id)
      .single();
    check(
      "guard: the cited evidence source's does_not_establish is unchanged after the rejected rewrite",
      evidenceAfterAttempt?.does_not_establish === "Does not establish anything — fixture only."
    );
    check("guard: the DOI correction actually persisted", evidenceAfterAttempt?.doi === "10.1000/corrected-doi");

    // --- Not-yet-used rows remain freely editable, including material fields ---
    const { data: unusedHeuristic } = await admin
      .from("m6_heuristics")
      .insert({
        heuristic_key: `test_unused_${Date.now()}`,
        name: "Unused fixture heuristic",
        description: "Original description.",
        version_introduced: RULESET_V1,
        status: "proposed",
      })
      .select()
      .single();
    heuristicIds.push(unusedHeuristic.id);
    const { error: unusedRewriteError } = await admin
      .from("m6_heuristics")
      .update({ description: "Revised description before any interpretation cites it." })
      .eq("id", unusedHeuristic.id);
    check("guard: a never-used heuristic's description can still be freely edited", !unusedRewriteError, unusedRewriteError?.message);
  } finally {
    await cleanup({ interpretationIds, sessionIds, heuristicIds, evidenceIds, userIds });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
