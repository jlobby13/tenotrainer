import "server-only";

// C5.4D — loads a draft's or a published version's full program content into
// the one normalized ProgramSnapshot shape (lib/prescriptionProgram.ts), and
// computes the draft content fingerprint used for stale-review protection.
// No authorization here: callers (prescriptionDraftServer.ts, or a page that
// has already run requireClinicianAuth() + assertSupervises()) own that.

import { createHash } from "node:crypto";
import { createServiceRoleClient } from "./supabase/server";
import { getCanonicalExerciseNamesByIds } from "./canonicalExerciseLibraryServer";
import { mapDosageRowToInput } from "./dosageEditor";
import { sortFocuses, type ProgramSnapshot, type ProgramWorkout } from "./prescriptionProgram";
import type { ExerciseStatus, PerformanceFocus, RehabPhase, SchedulingMode } from "./prescriptionDraftTypes";

type Supabase = ReturnType<typeof createServiceRoleClient>;

export type ProgramOwner = { kind: "draft"; id: string } | { kind: "version"; id: string };

type RawExercise = {
  id: string;
  canonical_exercise_id: string;
  order_index: number;
  status: ExerciseStatus;
  additional_instructions: string | null;
  prescription_exercise_dosage: unknown;
};
type RawWorkout = {
  id: string;
  label: string | null;
  order_index: number;
  days_of_week: number[] | null;
  prescription_exercises: RawExercise[] | null;
};

// Workouts + exercises + saved dosage in ONE embedded read, plus the
// performance-focus rows in parallel. Exercise names are left empty — see
// attachExerciseNames().
export async function loadProgramContent(
  supabase: Supabase,
  owner: ProgramOwner,
  metadata: { phase: RehabPhase | null; scheduling_mode: SchedulingMode | null; target_sessions_per_week: number | null; recovery_days?: number | null }
): Promise<ProgramSnapshot> {
  const ownerColumn = owner.kind === "draft" ? "prescription_draft_id" : "prescription_version_id";
  const [workoutsResult, focusResult] = await Promise.all([
    supabase
      .from("prescription_workouts")
      .select("id, label, order_index, days_of_week, prescription_exercises(id, canonical_exercise_id, order_index, status, additional_instructions, prescription_exercise_dosage(*))")
      .eq(ownerColumn, owner.id)
      .order("order_index", { ascending: true }),
    owner.kind === "draft"
      ? supabase.from("prescription_draft_performance_focus").select("focus").eq("prescription_draft_id", owner.id)
      : supabase.from("prescription_version_performance_focus").select("focus").eq("prescription_version_id", owner.id),
  ]);
  if (workoutsResult.error || focusResult.error) throw new Error("loadProgramContent: read failed");

  const workouts: ProgramWorkout[] = ((workoutsResult.data ?? []) as unknown as RawWorkout[])
    .slice()
    .sort((a, b) => a.order_index - b.order_index)
    .map((w) => ({
      id: w.id,
      label: w.label ?? null,
      orderIndex: w.order_index,
      daysOfWeek: w.days_of_week ?? null,
      exercises: (w.prescription_exercises ?? [])
        .slice()
        .sort((a, b) => a.order_index - b.order_index)
        .map((e) => {
          const rawDosage = Array.isArray(e.prescription_exercise_dosage) ? e.prescription_exercise_dosage[0] : e.prescription_exercise_dosage;
          return {
            id: e.id,
            canonicalExerciseId: e.canonical_exercise_id,
            name: "",
            orderIndex: e.order_index,
            status: e.status,
            dosage: mapDosageRowToInput(rawDosage as Record<string, unknown> | null | undefined),
            instructions: e.additional_instructions ?? null,
          };
        }),
    }));

  return {
    phase: metadata.phase ?? null,
    schedulingMode: metadata.scheduling_mode ?? null,
    targetSessionsPerWeek: metadata.target_sessions_per_week ?? null,
    recoveryDays: metadata.recovery_days ?? null,
    performanceFocuses: sortFocuses(((focusResult.data ?? []) as { focus: PerformanceFocus }[]).map((f) => f.focus)),
    workouts,
  };
}

// Names are display-only. A published version keeps showing the name of an
// exercise that has since been archived (the lookup does not filter on
// active), so history stays readable.
export async function attachExerciseNames(program: ProgramSnapshot): Promise<ProgramSnapshot> {
  const ids = Array.from(new Set(program.workouts.flatMap((w) => w.exercises.map((e) => e.canonicalExerciseId))));
  const names = await getCanonicalExerciseNamesByIds(ids);
  return {
    ...program,
    workouts: program.workouts.map((w) => ({
      ...w,
      exercises: w.exercises.map((e) => ({ ...e, name: names.get(e.canonicalExerciseId)?.name ?? "Unknown exercise" })),
    })),
  };
}

// C5.4D §19 — the draft content the clinician reviewed, as a stable hash.
// Covers everything publication copies (metadata, focus, workouts, weekday
// assignment, exercise order/status/instructions, every saved dosage field)
// plus the draft identity that decides whether publication is allowed at
// all (status, editing clinician, stale base). Computed server-side from the
// database both when Review renders and again inside publishDraft(), so a
// change made anywhere after Review loaded — another tab, another device —
// is detected without trusting any client timestamp.
export function computeDraftFingerprint(
  draft: { status: string; editing_clinician_id: string; stale_base_prescription_version_id: string | null },
  program: ProgramSnapshot
): string {
  const canonical = {
    status: draft.status,
    editingClinicianId: draft.editing_clinician_id,
    staleBase: draft.stale_base_prescription_version_id,
    phase: program.phase,
    schedulingMode: program.schedulingMode,
    target: program.targetSessionsPerWeek,
    recovery: program.recoveryDays,
    focuses: program.performanceFocuses,
    workouts: program.workouts.map((w) => ({
      id: w.id,
      label: w.label,
      order: w.orderIndex,
      days: (w.daysOfWeek ?? []).slice().sort((a, b) => a - b),
      exercises: w.exercises.map((e) => ({
        id: e.id,
        canonical: e.canonicalExerciseId,
        order: e.orderIndex,
        status: e.status,
        instructions: e.instructions,
        // mapDosageRowToInput() emits a fixed key order, so this serializes
        // deterministically.
        dosage: e.dosage,
      })),
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// C5.6C — the token Review hands out is "<revision>:<content hash>". The
// revision (prescription_draft_content_revisions, bumped by every draft
// write) is re-checked by publish_prescription_draft while it holds the
// draft row FOR UPDATE, closing the gap between the hash check below and the
// copy. Review reads the revision BEFORE loading content, so any write it
// might have missed has already bumped the revision past the token's.
export function formatReviewFingerprint(revision: number, contentHash: string): string {
  return `${revision}:${contentHash}`;
}

export function parseReviewFingerprint(fingerprint: string): { revision: number | null; contentHash: string } {
  const match = fingerprint.match(/^(\d+):([0-9a-f]{64})$/);
  if (!match) return { revision: null, contentHash: fingerprint };
  return { revision: Number(match[1]), contentHash: match[2] };
}
