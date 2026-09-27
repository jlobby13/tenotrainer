import "server-only";

// C5.4A — Prescription Builder Foundation & Canonical Library Browser.
// Server-only I/O for browsing canonical_exercises. Uses the service-role
// client and re-derives the exact visibility predicate that
// clinician_can_access_exercise() (20260917000001) enforces in Postgres —
// the same "service-role IS the authorization boundary, not a redundant
// layer on top of RLS" convention used throughout prescriptionDraftServer.ts
// and clinicianAuth.ts. This is a READ-ONLY module (plus the one trivial
// favorite toggle) — it never creates/updates/deletes canonical_exercises
// or exercise_reference_dosage (that remains C5.3D superuser-only).
//
// Fetches the FULL authorized+active set in one call; search/filter/facets
// happen client-side via lib/canonicalExerciseLibrary.ts's pure functions.
// Deliberately not paginated or server-filtered — 47 exercises today, and
// the C5.4A brief explicitly rules out building separate search
// infrastructure to justify a more elaborate query shape.

import { createServiceRoleClient } from "./supabase/server";

export type CanonicalExerciseRecord = {
  id: string;
  name: string;
  category: string | null;
  loadingProfile: string | null;
  unilateralBilateral: string | null;
  bodyPart: string[] | null;
  equipment: string[] | null;
  setupInstructions: string | null;
  executionCues: string[] | null;
  patientFacingExplanation: string | null;
  commonCompensations: string[] | null;
  contraindicationsOrCautions: string | null;
  isFavorite: boolean;
  referenceDosage: {
    dosageType: "repetition" | "hold" | "time" | "contact" | "distance";
    sets: number | null;
    repsMode: "exact" | "range" | null;
    repsExact: number | null;
    repsMin: number | null;
    repsMax: number | null;
    contactsMode: "exact" | "range" | null;
    contactsExact: number | null;
    contactsMin: number | null;
    contactsMax: number | null;
    holdDurationMode: "exact" | "range" | null;
    holdDurationExactSeconds: number | null;
    holdDurationMinSeconds: number | null;
    holdDurationMaxSeconds: number | null;
    timeDurationMode: "exact" | "range" | null;
    timeDurationExactSeconds: number | null;
    timeDurationMinSeconds: number | null;
    timeDurationMaxSeconds: number | null;
    intervalWorkSeconds: number | null;
    intervalRecoverySeconds: number | null;
    intervalRounds: number | null;
    distanceMode: "exact" | "range" | null;
    distanceExactValue: number | null;
    distanceMinValue: number | null;
    distanceMaxValue: number | null;
    distanceUnit: "m" | "km" | "ft" | "mi" | null;
    tempoDescription: string | null;
    restSeconds: number | null;
  } | null;
};

// Mirrors clinician_can_access_exercise(): global, OR own private, OR
// org_shared with an active clinician/clinician_admin/super_user
// membership in that organization. Today only 'global' rows exist (C5.3D
// restricted canonical_exercises INSERT to super_user, always global), but
// this is written against the full schema-level visibility model, not just
// today's data, per the C5.4A brief's "existing visibility model" framing.
export async function listCanonicalExercisesForClinician(clinicianId: string): Promise<CanonicalExerciseRecord[]> {
  const supabase = createServiceRoleClient();

  const { data: memberships } = await supabase
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", clinicianId)
    .in("role", ["clinician", "clinician_admin", "super_user"]);
  const orgIds = (memberships ?? []).map((m) => m.organization_id as string);

  const orParts = ["visibility.eq.global", `and(visibility.eq.private,owner_clinician_id.eq.${clinicianId})`];
  if (orgIds.length > 0) orParts.push(`and(visibility.eq.org_shared,organization_id.in.(${orgIds.join(",")}))`);

  const { data: exercises, error } = await supabase
    .from("canonical_exercises")
    .select(
      "id, name, category, loading_profile, unilateral_bilateral, body_part, equipment, setup_instructions, execution_cues, patient_facing_explanation, common_compensations, contraindications_or_cautions"
    )
    .eq("active", true)
    .or(orParts.join(","))
    .order("name", { ascending: true });
  if (error) throw new Error(`listCanonicalExercisesForClinician: ${error.message}`);
  const rows = exercises ?? [];
  if (rows.length === 0) return [];

  const exerciseIds = rows.map((r) => r.id as string);
  const [{ data: favorites }, { data: dosageRows }] = await Promise.all([
    supabase.from("clinician_exercise_favorites").select("canonical_exercise_id").eq("clinician_id", clinicianId).in("canonical_exercise_id", exerciseIds),
    supabase.from("exercise_reference_dosage").select("*").in("exercise_id", exerciseIds),
  ]);
  const favoriteIds = new Set((favorites ?? []).map((f) => f.canonical_exercise_id as string));
  const dosageByExerciseId = new Map((dosageRows ?? []).map((d) => [d.exercise_id as string, d]));

  return rows.map((r) => {
    const d = dosageByExerciseId.get(r.id as string);
    return {
      id: r.id as string,
      name: r.name as string,
      category: r.category as string | null,
      loadingProfile: r.loading_profile as string | null,
      unilateralBilateral: r.unilateral_bilateral as string | null,
      bodyPart: r.body_part as string[] | null,
      equipment: r.equipment as string[] | null,
      setupInstructions: r.setup_instructions as string | null,
      executionCues: r.execution_cues as string[] | null,
      patientFacingExplanation: r.patient_facing_explanation as string | null,
      commonCompensations: r.common_compensations as string[] | null,
      contraindicationsOrCautions: r.contraindications_or_cautions as string | null,
      isFavorite: favoriteIds.has(r.id as string),
      referenceDosage: d
        ? {
            dosageType: d.dosage_type,
            sets: d.sets,
            repsMode: d.reps_mode,
            repsExact: d.reps_exact,
            repsMin: d.reps_min,
            repsMax: d.reps_max,
            contactsMode: d.contacts_mode,
            contactsExact: d.contacts_exact,
            contactsMin: d.contacts_min,
            contactsMax: d.contacts_max,
            holdDurationMode: d.hold_duration_mode,
            holdDurationExactSeconds: d.hold_duration_exact_seconds,
            holdDurationMinSeconds: d.hold_duration_min_seconds,
            holdDurationMaxSeconds: d.hold_duration_max_seconds,
            timeDurationMode: d.time_duration_mode,
            timeDurationExactSeconds: d.time_duration_exact_seconds,
            timeDurationMinSeconds: d.time_duration_min_seconds,
            timeDurationMaxSeconds: d.time_duration_max_seconds,
            intervalWorkSeconds: d.interval_work_seconds,
            intervalRecoverySeconds: d.interval_recovery_seconds,
            intervalRounds: d.interval_rounds,
            distanceMode: d.distance_mode,
            distanceExactValue: d.distance_exact_value,
            distanceMinValue: d.distance_min_value,
            distanceMaxValue: d.distance_max_value,
            distanceUnit: d.distance_unit,
            tempoDescription: d.tempo_description,
            restSeconds: d.rest_seconds,
          }
        : null,
    };
  });
}

// Only reachable canonical_exercises rows may be favorited — same
// visibility check, re-derived server-side rather than trusted from a
// client-supplied flag. clinician_id is ALWAYS the server-derived caller
// identity (see clinicianAuth.ts's header on this convention) — a route
// must never accept it from the request body.
async function assertExerciseAccessible(clinicianId: string, exerciseId: string): Promise<void> {
  const supabase = createServiceRoleClient();
  const { data: exercise } = await supabase.from("canonical_exercises").select("id, visibility, owner_clinician_id, organization_id").eq("id", exerciseId).maybeSingle();
  if (!exercise) throw new Error("EXERCISE_UNAVAILABLE");
  if (exercise.visibility === "global") return;
  if (exercise.visibility === "private" && exercise.owner_clinician_id === clinicianId) return;
  if (exercise.visibility === "org_shared") {
    const { data: membership } = await supabase
      .from("organization_members")
      .select("id")
      .eq("organization_id", exercise.organization_id)
      .eq("user_id", clinicianId)
      .in("role", ["clinician", "clinician_admin", "super_user"])
      .maybeSingle();
    if (membership) return;
  }
  throw new Error("EXERCISE_UNAVAILABLE");
}

// For rendering ALREADY-ADDED draft exercises (builder right panel). No
// visibility/active filtering here — an exercise legitimately added to a
// draft must always be nameable when displaying that draft back, even if
// its canonical_exercises row later becomes inactive or its visibility
// changes; the visibility gate belongs on the ADD path
// (listCanonicalExercisesForClinician), not on reading back existing draft
// membership.
export async function getCanonicalExerciseNamesByIds(exerciseIds: string[]): Promise<Map<string, { name: string; loadingProfile: string | null }>> {
  if (exerciseIds.length === 0) return new Map();
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.from("canonical_exercises").select("id, name, loading_profile").in("id", exerciseIds);
  if (error) throw new Error(`getCanonicalExerciseNamesByIds: ${error.message}`);
  return new Map((data ?? []).map((r) => [r.id as string, { name: r.name as string, loadingProfile: r.loading_profile as string | null }]));
}

// Favorites are clinician-specific (C5.4A §10 — "Do not make favorites
// organization-wide"). RLS on clinician_exercise_favorites already enforces
// own-row-only for a direct authenticated write, but this module keeps the
// same service-role + explicit-ownership pattern as every other mutation in
// this feature area for consistency, rather than mixing two different
// authorization mechanisms within one feature.
export async function setExerciseFavorite(params: { clinicianId: string; exerciseId: string; favorite: boolean }): Promise<void> {
  await assertExerciseAccessible(params.clinicianId, params.exerciseId);
  const supabase = createServiceRoleClient();
  if (params.favorite) {
    const { error } = await supabase
      .from("clinician_exercise_favorites")
      .upsert({ clinician_id: params.clinicianId, canonical_exercise_id: params.exerciseId }, { onConflict: "clinician_id,canonical_exercise_id" });
    if (error) throw new Error(`setExerciseFavorite: ${error.message}`);
  } else {
    const { error } = await supabase
      .from("clinician_exercise_favorites")
      .delete()
      .eq("clinician_id", params.clinicianId)
      .eq("canonical_exercise_id", params.exerciseId);
    if (error) throw new Error(`setExerciseFavorite: ${error.message}`);
  }
}
