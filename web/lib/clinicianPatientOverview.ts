// C2 — Patient Clinical Overview. Pure, deterministic domain logic only (no
// server-only import, no DB access) — mirrors the clinicianRoster.ts /
// clinicianServer.ts split of "pure decision logic" from "server-only DB
// wiring" (see clinicianPatientOverviewServer.ts for the latter).
//
// LOCKED founder decisions this module encodes:
//   - Prescribed-vs-actual set fidelity: completed / skipped / not_reached
//     are three distinct states — never averaged, summed, flattened, or
//     coerced into one another (Section 8 of the C2 brief).
//   - Difficulty/peak-pain/morning-response display: UNKNOWN != ZERO
//     throughout — an unanswered field is "Not yet recorded"/"Unknown",
//     never a fabricated favorable default.
//   - Single-session tolerance is displayed from the EXISTING persisted
//     tolerance_evaluations row verbatim — this module never recomputes or
//     reinterprets a classification/guidance, only formats already-decided
//     values for clinician display.
//   - Acute safety history is factual/process-only: reported symptoms,
//     reassessment/release facts. Internal level (3/4/5) is carried in the
//     data shape for provenance but this module provides no function that
//     surfaces it as primary clinician-facing text — see
//     clinicianPatientOverviewServer.ts's header for why.

import type { PrescriptionSnapshotExercise, ExerciseOutcome, Difficulty } from "./rehabSessionTypes";
import type { ToleranceClassification, ImmediateGuidance, StiffnessDuration } from "./morningResponseTypes";
import type { Irritability } from "./prescriptionVersionTypes";
import type { ExternalLoadCategory, ExternalLoadTiming, LoadObservationProvenance } from "./sessionLoadObservations";
import type { ReleasePath } from "./acuteSafetyTypes";
import { repsOrHoldLabel } from "./exerciseDisplay";
import { EXTERNAL_LOAD_CATEGORY_LABELS, EXTERNAL_LOAD_TIMING_LABELS } from "./sessionLoadObservations";

// ---------------------------------------------------------------------------
// Prescribed vs Actual — set-level join. A C2-specific pure helper (not an
// extraction of capacityExposure.ts/progressServer.ts's own inline set-join
// logic): those two live in Capacity/Progress modules with their own gating
// (successful-exposure classification, prescription-version comparison)
// that C2 must not import or depend on ("Protect M6" — see the C2 audit's
// query-architecture recommendation). The JOIN SHAPE mirrors both existing
// implementations intentionally (same three-state fidelity, same
// non-numeric-dosage fallback via repsOrHoldLabel), verified by parity
// tests, not by sharing code with either.
// ---------------------------------------------------------------------------

export type SetOutcomeOutcome = "completed" | "skipped";

export type RawSetOutcomeRow = {
  exercise_id: string;
  set_index: number;
  outcome: SetOutcomeOutcome;
  prescribed_reps: number | null;
  prescribed_load: number | null;
  actual_reps: number | null;
  actual_load: number | null;
  was_edited: boolean;
};

export type PrescribedVsActualSet = {
  setIndex: number;
  // "not_reached": no set_outcomes row exists for this prescribed set index
  // (the session ended, or was terminated, before reaching it) — distinct
  // from "skipped" (the patient explicitly skipped a set they DID reach).
  outcome: SetOutcomeOutcome | "not_reached";
  // Numeric prescribed amount (reps or hold-seconds) when the set_outcomes
  // row already recorded one as a plain number. Always null for "not_reached".
  prescribedAmount: number | null;
  prescribedLoad: number | null;
  // Fallback text (e.g. "45s hold", "8-12") for a non-numeric-representable
  // dosage, read straight from THIS session's own prescription_snapshot —
  // set only when prescribedAmount is null AND the exercise's dosage is
  // itself non-numeric (never fabricated when the dosage is simply unset).
  prescribedDisplay: string | null;
  // Both null for "skipped" and "not_reached" — never coerced to 0.
  actualAmount: number | null;
  actualLoad: number | null;
  wasEdited: boolean;
};

export type PrescribedVsActualExercise = {
  exId: string;
  name: string;
  category: string;
  loadingProfile: string | null;
  orderIndex: number;
  sets: PrescribedVsActualSet[];
};

// Ordered by prescription_snapshot's own order_index (never re-sorted by
// name or performance). Within each exercise, sets are ordered 1..N where N
// is the larger of the exercise's own prescribed set count (dosage.sets,
// when a plain number) and the highest set_index actually recorded — so a
// recorded set is never silently dropped even if it exceeds the nominal
// prescribed count, and a genuinely never-reached set is never omitted.
export function buildPrescribedVsActual(
  prescriptionSnapshot: PrescriptionSnapshotExercise[],
  setOutcomes: RawSetOutcomeRow[]
): PrescribedVsActualExercise[] {
  const rowsByExercise = new Map<string, RawSetOutcomeRow[]>();
  for (const row of setOutcomes) {
    const list = rowsByExercise.get(row.exercise_id) ?? [];
    list.push(row);
    rowsByExercise.set(row.exercise_id, list);
  }

  return [...prescriptionSnapshot]
    .sort((a, b) => a.order_index - b.order_index)
    .map((ex): PrescribedVsActualExercise => {
      const rows = rowsByExercise.get(ex.ex_id) ?? [];
      const rowByIndex = new Map(rows.map((r) => [r.set_index, r]));
      const dosage = ex.dosage ?? {};
      const nominalSetCount = typeof dosage.sets === "number" ? dosage.sets : 0;
      const highestRecordedIndex = rows.reduce((max, r) => Math.max(max, r.set_index), 0);
      const setCount = Math.max(nominalSetCount, highestRecordedIndex);

      const sets: PrescribedVsActualSet[] = [];
      for (let setIndex = 1; setIndex <= setCount; setIndex++) {
        const row = rowByIndex.get(setIndex);
        if (!row) {
          sets.push({
            setIndex,
            outcome: "not_reached",
            prescribedAmount: null,
            prescribedLoad: null,
            prescribedDisplay: repsOrHoldLabel(dosage),
            actualAmount: null,
            actualLoad: null,
            wasEdited: false,
          });
          continue;
        }
        sets.push({
          setIndex,
          outcome: row.outcome,
          prescribedAmount: row.prescribed_reps,
          prescribedLoad: row.prescribed_load,
          prescribedDisplay: row.prescribed_reps == null ? repsOrHoldLabel(dosage) : null,
          actualAmount: row.outcome === "completed" ? row.actual_reps : null,
          actualLoad: row.outcome === "completed" ? row.actual_load : null,
          wasEdited: row.was_edited,
        });
      }

      return { exId: ex.ex_id, name: ex.name, category: ex.category, loadingProfile: ex.loading_profile, orderIndex: ex.order_index, sets };
    });
}

// ---------------------------------------------------------------------------
// Display formatting — every function below formats an already-known value;
// none of them decide or recompute anything clinical.
// ---------------------------------------------------------------------------

export function formatExerciseOutcomeLabel(outcome: ExerciseOutcome): string {
  switch (outcome) {
    case "completed":
      return "Completed";
    case "ended_early":
      return "Ended early";
    case "acute_terminated":
      return "Acute terminated";
  }
}

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: "Easy",
  moderate: "Moderate",
  hard: "Hard",
  too_hard: "Too Hard",
};

export function formatDifficultyLabel(difficulty: Difficulty | null): string {
  return difficulty === null ? "Not yet recorded" : DIFFICULTY_LABELS[difficulty];
}

// Explicit 0 is valid data ("no pain") and must render as "0/10" — only a
// true NULL (unanswered) renders as "Not yet recorded". Applies identically
// to peak session pain and next-morning pain (same 0-10 scale, same
// UNKNOWN != ZERO rule).
export function formatPainLabel(pain: number | null): string {
  return pain === null ? "Not yet recorded" : `${pain}/10`;
}

const STIFFNESS_DURATION_LABELS: Record<Exclude<StiffnessDuration, "not_applicable">, string> = {
  lt_5_min: "Less than 5 minutes",
  min_5_15: "5-15 minutes",
  min_15_30: "15-30 minutes",
  gt_30_min: "More than 30 minutes",
};

// stiffness===0 -> duration is N/A (a real, meaningful "not applicable",
// distinct from unknown). stiffness>0 with a null (or, defensively, an
// inconsistent "not_applicable") duration -> "Unknown", never inferred.
// stiffness itself unanswered -> "Not yet recorded" (matches formatPainLabel).
export function formatStiffnessDurationLabel(stiffness: number | null, duration: StiffnessDuration | null): string {
  if (stiffness === null) return "Not yet recorded";
  if (stiffness === 0) return "N/A";
  if (duration === null || duration === "not_applicable") return "Unknown";
  return STIFFNESS_DURATION_LABELS[duration];
}

export function formatIrritabilityLabel(irritability: Irritability): string {
  return irritability.charAt(0).toUpperCase() + irritability.slice(1);
}

export function formatInsertionalLabel(isInsertional: boolean): string {
  return isInsertional ? "Insertional" : "Non-insertional";
}

// Enum-to-readable-string mapping only (not a reinterpretation) — the
// underlying decision (which guidance tier) is already locked and persisted
// on the tolerance_evaluations row; this only names it for display, exactly
// as tolerance_classification already has a persisted patient_facing_label
// this module reuses verbatim rather than remapping.
const IMMEDIATE_GUIDANCE_LABELS: Record<ImmediateGuidance, string> = {
  maintain: "Maintain",
  maintain_cautiously: "Maintain cautiously",
  reduce_modify: "Reduce or modify",
  clinical_review: "Clinical review",
};

export function formatImmediateGuidanceLabel(guidance: ImmediateGuidance): string {
  return IMMEDIATE_GUIDANCE_LABELS[guidance];
}

export function formatExternalLoadCategoryLabel(category: ExternalLoadCategory): string {
  return category === "none" ? "None reported" : EXTERNAL_LOAD_CATEGORY_LABELS[category];
}

export function formatExternalLoadTimingLabel(timing: ExternalLoadTiming | null): string | null {
  return timing === null ? null : EXTERNAL_LOAD_TIMING_LABELS[timing];
}

export function formatLoadObservationProvenanceLabel(capturedDuring: LoadObservationProvenance): string {
  return capturedDuring === "m3_session_response" ? "Reported at session" : "Reported next morning";
}

// Concise collapsed-card summary for a session's morning-response state.
// Four distinct cases, per the founder's locked wording:
//   - submitted: concise factual values (never implies unanswered = symptom-free)
//   - due / pending: the same due/pending badge wording as C1B's roster
//   - not yet due (a row exists, unsubmitted, with a known future eligibility):
//     restrained wording, never labeled "due"
//   - no morning_responses row at all yet (session hasn't reached that step
//     of its own response flow): "Not yet recorded", never a due/pending badge
export type MorningResponseSummaryInput = {
  morningResponse: { submittedAt: string | null; nextMorningPain: number | null; nextMorningStiffness: number | null } | null;
  morningResponseStatus: "due" | "pending" | null;
};

// Same numeric-amount-plus-unit convention already used by repsOrHoldLabel's
// own numeric branch ("45 reps") and its sibling non-numeric string form
// ("45s hold") — a small, self-contained rule kept local to this module
// rather than importing M6 Stage 3C's derivePerformanceUnit (capacityConstruct.ts):
// that module has no tolerance/success gating and would likely be safe to
// share, but this rule is a single ternary, and keeping C2 fully
// self-contained here means a future M6 change can never unexpectedly alter
// this display — see this file's own header on "Protect M6".
function formatAmountWithUnit(amount: number, loadingProfile: string | null): string {
  return loadingProfile === "isometric" ? `${amount}s hold` : `${amount} reps`;
}

export function formatSetPrescribedLabel(set: PrescribedVsActualSet, loadingProfile: string | null): string {
  const amountText = set.prescribedAmount !== null ? formatAmountWithUnit(set.prescribedAmount, loadingProfile) : set.prescribedDisplay;
  if (amountText === null) return "—";
  return set.prescribedLoad !== null ? `${amountText} · ${set.prescribedLoad} kg` : amountText;
}

export function formatSetActualLabel(set: PrescribedVsActualSet, loadingProfile: string | null): string {
  if (set.outcome === "skipped") return "Skipped";
  if (set.outcome === "not_reached") return "Not reached";
  const amountText = set.actualAmount !== null ? formatAmountWithUnit(set.actualAmount, loadingProfile) : "—";
  return set.actualLoad !== null ? `${amountText} · ${set.actualLoad} kg` : amountText;
}

export function summarizeMorningResponse(input: MorningResponseSummaryInput): string {
  if (input.morningResponse && input.morningResponse.submittedAt !== null) {
    return `Pain ${formatPainLabel(input.morningResponse.nextMorningPain)} · Stiffness ${formatPainLabel(input.morningResponse.nextMorningStiffness)}`;
  }
  if (input.morningResponseStatus === "due") return "Morning response due";
  if (input.morningResponseStatus === "pending") return "Morning response pending";
  if (input.morningResponse) return "Morning response not yet due";
  return "Not yet recorded";
}

const RELEASE_PATH_LABELS: Record<ReleasePath, string> = {
  self_resolved_no_evaluation: "Self-resolved (no professional evaluation)",
  professional_clearance: "Released after professional clearance",
  professional_clearance_with_prescription: "Released after professional clearance and an updated prescription",
};

export function formatReleasePathLabel(releasePath: ReleasePath): string {
  return RELEASE_PATH_LABELS[releasePath];
}

// Client-safe re-export so callers of this module never need to know
// ToleranceClassification/ImmediateGuidance live in morningResponseTypes.ts.
export type { ToleranceClassification, ImmediateGuidance };
