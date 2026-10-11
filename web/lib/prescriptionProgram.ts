// C5.4D — Prescription Review → Validation → Publish. Pure, deterministic
// logic only (no server-only import, no I/O) — imported by the Review page,
// the read-only published view, AND the server publish path
// (prescriptionDraftServer.publishDraft), so what Review reports as blocking
// and what publication enforces come from one implementation and cannot
// drift (C5.4D §7).
//
// Two concerns live here:
//   1. A normalized ProgramSnapshot (one shape for a draft or a published
//      version) plus its human-readable dosage/schedule presentation.
//   2. Mapping every failing validate_prescription_draft rule onto located,
//      clinician-readable issues (buildReviewIssues). The RPC is the only
//      authority on whether a rule passes — this module never decides
//      publishability, it only explains which workout/exercise is
//      responsible.

import { formatLoadLabel, validateDosageInput } from "./dosageEditor";
import type {
  DosageInput,
  DosageMode,
  ExerciseStatus,
  PerformanceFocus,
  RehabPhase,
  SchedulingMode,
  AssistanceLevel,
  Side,
  ValidationRuleResult,
} from "./prescriptionDraftTypes";

// ---------------------------------------------------------------------------
// Snapshot shape
// ---------------------------------------------------------------------------

export type ProgramExercise = {
  id: string; // prescription_exercises.id
  canonicalExerciseId: string;
  // Empty until enriched with canonical names (the publish path never needs
  // them, so it never pays for the lookup).
  name: string;
  orderIndex: number;
  status: ExerciseStatus;
  // The SAVED patient dosage only — never exercise-library reference dosage.
  dosage: DosageInput | null;
  instructions: string | null;
};

export type ProgramWorkout = {
  id: string;
  label: string | null; // raw stored label (null = unnamed)
  orderIndex: number;
  daysOfWeek: number[] | null; // 0=Sunday..6=Saturday
  exercises: ProgramExercise[];
};

export type ProgramSnapshot = {
  phase: RehabPhase | null;
  schedulingMode: SchedulingMode | null;
  targetSessionsPerWeek: number | null;
  performanceFocuses: PerformanceFocus[];
  workouts: ProgramWorkout[]; // ordered by orderIndex, exercises likewise
};

// ---------------------------------------------------------------------------
// Labels (shared with the builder's SchedulingPanel so wording never drifts)
// ---------------------------------------------------------------------------

export const PHASE_OPTIONS: { value: RehabPhase; label: string }[] = [
  { value: "early", label: "Early" },
  { value: "middle", label: "Middle" },
  { value: "late", label: "Late" },
  { value: "return_to_activity", label: "Return to Sport / Activity" },
  { value: "maintenance", label: "Maintenance" },
];

export const FOCUS_OPTIONS: { value: PerformanceFocus; label: string }[] = [
  { value: "symptom_management_load_introduction", label: "Symptom Management / Load Introduction" },
  { value: "strength_development", label: "Strength Development" },
  { value: "energy_storage", label: "Energy Storage" },
  { value: "reactive_strength", label: "Reactive Strength" },
  { value: "explosive_strength", label: "Explosive Strength" },
  { value: "return_to_sport_prep", label: "Return-to-Sport / Activity Preparation" },
  { value: "maintenance", label: "Maintenance" },
];

export function phaseLabel(phase: RehabPhase): string {
  return PHASE_OPTIONS.find((o) => o.value === phase)?.label ?? phase;
}

export function focusLabel(focus: PerformanceFocus): string {
  return FOCUS_OPTIONS.find((o) => o.value === focus)?.label ?? focus;
}

// Fixed display order, so a focus set reads the same wherever it is shown.
export function sortFocuses(focuses: PerformanceFocus[]): PerformanceFocus[] {
  const rank = (f: PerformanceFocus) => FOCUS_OPTIONS.findIndex((o) => o.value === f);
  return focuses.slice().sort((a, b) => rank(a) - rank(b));
}

// Monday-first, matching the builder's weekday buttons (WorkoutTabs).
export const WEEKDAY_ORDER: { value: number; short: string; long: string }[] = [
  { value: 1, short: "Mon", long: "Monday" },
  { value: 2, short: "Tue", long: "Tuesday" },
  { value: 3, short: "Wed", long: "Wednesday" },
  { value: 4, short: "Thu", long: "Thursday" },
  { value: 5, short: "Fri", long: "Friday" },
  { value: 6, short: "Sat", long: "Saturday" },
  { value: 0, short: "Sun", long: "Sunday" },
];

export function workoutLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

// Same fallback the builder uses for an unnamed workout.
export function workoutDisplayLabel(workout: Pick<ProgramWorkout, "label">, index: number): string {
  return workout.label || `Workout ${workoutLetter(index)}`;
}

export function formatWeekdays(days: number[] | null): string[] {
  const set = new Set(days ?? []);
  return WEEKDAY_ORDER.filter((d) => set.has(d.value)).map((d) => d.short);
}

export function countExercises(program: ProgramSnapshot): number {
  return program.workouts.reduce((sum, w) => sum + w.exercises.length, 0);
}

// ---------------------------------------------------------------------------
// Dosage presentation. Every line comes from a field that actually carries a
// saved value — nothing is defaulted, zero-filled, or inferred. A
// "not_applicable" load is the storage default and is indistinguishable
// from "no load entered", so it is omitted rather than shown (the builder's
// collapsed summary follows the same rule via formatLoadLabel()).
// ---------------------------------------------------------------------------

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${trimNumber(totalSeconds)} sec`;
  const min = Math.floor(totalSeconds / 60);
  const sec = Math.round(totalSeconds % 60);
  return sec === 0 ? `${min} min` : `${min} min ${sec} sec`;
}

function formatDurationRange(min: number, max: number): string {
  if (min < 60 && max < 60) return `${trimNumber(min)}–${trimNumber(max)} sec`;
  if (min % 60 === 0 && max % 60 === 0) return `${min / 60}–${max / 60} min`;
  return `${formatDuration(min)}–${formatDuration(max)}`;
}

function exactOrRange(
  mode: DosageMode | null | undefined,
  exact: number | null | undefined,
  min: number | null | undefined,
  max: number | null | undefined,
  format: (n: number) => string,
  formatRange: (a: number, b: number) => string = (a, b) => `${format(a)}–${format(b)}`
): string | null {
  if (mode === "exact" && exact != null) return format(exact);
  if (mode === "range" && min != null && max != null) return formatRange(min, max);
  return null;
}

const ASSISTANCE_LABELS: Record<AssistanceLevel, string> = {
  contact_guard: "Contact guard assistance",
  minimal: "Minimal assistance",
  moderate: "Moderate assistance",
  maximum: "Maximum assistance",
};

const SIDE_LABELS: Record<Side, string> = {
  bilateral: "Bilateral",
  left: "Left side",
  right: "Right side",
  both_sides_separately: "Each side separately",
  not_applicable: "Side: N/A",
};

export type DosageDescription = {
  // The core volume line ("4 × 8", "3 × 20 contacts", "4 sets").
  headline: string | null;
  // Further prescribed quantities, interval structure, load, rest.
  details: string[];
  // Optional modifiers: tempo, RPE/RIR, ROM, assistance, side.
  modifiers: string[];
};

export function describeDosage(d: DosageInput): DosageDescription {
  const reps = exactOrRange(d.repsMode, d.repsExact, d.repsMin, d.repsMax, trimNumber);
  const quantities: { key: string; bare: string; withUnit: string }[] = [];
  if (reps) quantities.push({ key: "reps", bare: reps, withUnit: `${reps} reps` });
  const contacts = exactOrRange(d.contactsMode, d.contactsExact, d.contactsMin, d.contactsMax, trimNumber);
  if (contacts) quantities.push({ key: "contacts", bare: `${contacts} contacts`, withUnit: `${contacts} contacts` });
  const hold = exactOrRange(d.holdDurationMode, d.holdDurationExactSeconds, d.holdDurationMinSeconds, d.holdDurationMaxSeconds, formatDuration, formatDurationRange);
  if (hold) quantities.push({ key: "hold", bare: `${hold} hold`, withUnit: `${hold} hold` });
  const distance = exactOrRange(d.distanceMode, d.distanceExactValue, d.distanceMinValue, d.distanceMaxValue, trimNumber);
  if (distance) {
    const text = d.distanceUnit ? `${distance} ${d.distanceUnit}` : distance;
    quantities.push({ key: "distance", bare: text, withUnit: text });
  }
  const duration = exactOrRange(d.timeDurationMode, d.timeDurationExactSeconds, d.timeDurationMinSeconds, d.timeDurationMaxSeconds, formatDuration, formatDurationRange);
  if (duration) quantities.push({ key: "duration", bare: duration, withUnit: duration });

  const details: string[] = [];
  let headline: string | null = null;
  const [first, ...rest] = quantities;
  if (d.sets != null && first) headline = `${d.sets} × ${first.bare}`;
  else if (d.sets != null) headline = `${d.sets} ${d.sets === 1 ? "set" : "sets"}`;
  else if (first) headline = first.withUnit;
  for (const q of rest) details.push(q.withUnit);

  const interval: string[] = [];
  if (d.intervalWorkSeconds != null) interval.push(`${formatDuration(d.intervalWorkSeconds)} work`);
  if (d.intervalRecoverySeconds != null) interval.push(`${formatDuration(d.intervalRecoverySeconds)} recovery`);
  if (d.intervalRounds != null) interval.push(`${d.intervalRounds} ${d.intervalRounds === 1 ? "round" : "rounds"}`);
  if (interval.length > 0) {
    const text = interval.join(" / ");
    if (headline === null) headline = text;
    else details.push(text);
  }

  const load = formatLoadLabel(d);
  if (load) {
    if (headline === null) headline = load;
    else details.push(load);
  }
  if (d.restSeconds != null) details.push(`Rest ${formatDuration(d.restSeconds)}`);

  const modifiers: string[] = [];
  if (d.concentricDurationSeconds != null) modifiers.push(`${formatDuration(d.concentricDurationSeconds)} lifting`);
  if (d.repHoldDurationSeconds != null) modifiers.push(`${formatDuration(d.repHoldDurationSeconds)} pause`);
  if (d.eccentricDurationSeconds != null) modifiers.push(`${formatDuration(d.eccentricDurationSeconds)} lowering`);
  const tempoDescription = d.tempoDescription?.trim();
  if (tempoDescription) modifiers.push(`Tempo: ${tempoDescription}`);
  if (d.rpe != null) modifiers.push(`RPE ${trimNumber(d.rpe)}`);
  if (d.rir != null) modifiers.push(`RIR ${trimNumber(d.rir)}`);
  const rom = d.rom?.trim();
  if (rom) modifiers.push(`ROM: ${rom}`);
  if (d.assistanceLevel) modifiers.push(ASSISTANCE_LABELS[d.assistanceLevel]);
  if (d.side) modifiers.push(SIDE_LABELS[d.side]);

  return { headline, details, modifiers };
}

// ---------------------------------------------------------------------------
// Locators for C5.4D's two RPC rules (20261010000001):
//   - workouts_have_active_exercise
//   - active_exercise_dosage_valid — enforced in SQL by
//     prescription_dosage_validation_errors(), which mirrors
//     validateDosageInput() field code for field code (parity-tested by
//     scripts/verifyC5Stage4dAtomicPublish.mjs), so the TS validator below
//     names exactly the exercises the RPC rejects.
// ---------------------------------------------------------------------------

function activeExercises(workout: ProgramWorkout): ProgramExercise[] {
  return workout.exercises.filter((e) => e.status === "active");
}

function findWorkoutsWithoutActiveExercise(program: ProgramSnapshot): ProgramWorkout[] {
  return program.workouts.filter((w) => activeExercises(w).length === 0);
}

function findInvalidDosages(program: ProgramSnapshot): { workout: ProgramWorkout; exercise: ProgramExercise; message: string }[] {
  const found: { workout: ProgramWorkout; exercise: ProgramExercise; message: string }[] = [];
  for (const workout of program.workouts) {
    for (const exercise of activeExercises(workout)) {
      if (!exercise.dosage) continue; // missing dosage is the RPC's active_exercises_have_dosage rule
      const errors = validateDosageInput(exercise.dosage);
      if (errors.length > 0) found.push({ workout, exercise, message: errors[0].message });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Issue location — failing rule -> located, actionable issues.
// ---------------------------------------------------------------------------

export type ReviewIssueAction = { kind: "exercise" | "schedule" | "prescription" | "overview"; label: string; href: string };

export type ReviewIssue = {
  key: string;
  rule: string;
  workoutId?: string;
  workoutLabel?: string;
  exerciseId?: string;
  exerciseName?: string;
  message: string;
  action: ReviewIssueAction | null;
};

// Review-only representation of the RPC's stale-base check (C5.3: publish is
// refused when the patient's current version is no longer the one this draft
// was started against). Not a new invariant — surfaced early so Review never
// offers a publish the RPC is certain to reject.
export const DRAFT_BASE_CURRENT_RULE = "draft_base_current";

export function builderHref(patientId: string, target?: { workoutId?: string; exerciseId?: string; focus?: "schedule" | "weekdays" }): string {
  const base = `/clinician/patients/${patientId}/prescription/builder`;
  const params = new URLSearchParams();
  if (target?.workoutId) params.set("workout", target.workoutId);
  if (target?.exerciseId) params.set("exercise", target.exerciseId);
  if (target?.focus) params.set("focus", target.focus);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

export function buildReviewIssues(params: {
  patientId: string;
  rules: ValidationRuleResult[];
  program: ProgramSnapshot;
  // Only consulted when exercises_active_and_accessible fails.
  unavailableExerciseIds?: Set<string>;
}): ReviewIssue[] {
  const { patientId, program } = params;
  const failing = new Set(params.rules.filter((r) => !r.passed).map((r) => r.rule));
  const issues: ReviewIssue[] = [];
  const labelOf = (w: ProgramWorkout) => workoutDisplayLabel(w, program.workouts.indexOf(w));
  const editExercise = (w: ProgramWorkout, e: ProgramExercise): ReviewIssueAction => ({
    kind: "exercise",
    label: "Edit exercise",
    href: builderHref(patientId, { workoutId: w.id, exerciseId: e.id }),
  });
  const editSchedule = (workoutId?: string): ReviewIssueAction => ({
    kind: "schedule",
    label: "Edit schedule",
    href: builderHref(patientId, workoutId ? { workoutId, focus: "weekdays" } : { focus: "schedule" }),
  });
  const editPrescription = (workoutId?: string): ReviewIssueAction => ({
    kind: "prescription",
    label: "Edit prescription",
    href: builderHref(patientId, workoutId ? { workoutId } : undefined),
  });
  const exerciseLabel = (e: ProgramExercise) => e.name || "Exercise";

  for (const rule of params.rules) {
    if (rule.passed) continue;
    switch (rule.rule) {
      case DRAFT_BASE_CURRENT_RULE:
        issues.push({
          key: rule.rule,
          rule: rule.rule,
          message: "A newer prescription version was published after this draft was started, so this draft can no longer be published.",
          action: { kind: "overview", label: "Prescription overview", href: `/clinician/patients/${patientId}/prescription` },
        });
        break;
      case "has_workout":
        issues.push({ key: rule.rule, rule: rule.rule, message: "Add at least one workout.", action: editPrescription() });
        break;
      case "has_active_exercise":
        // Implied by the per-workout empty-workout issues when those exist.
        if (!failing.has("workouts_have_active_exercise") && !failing.has("has_workout")) {
          issues.push({ key: rule.rule, rule: rule.rule, message: "Add at least one exercise.", action: editPrescription() });
        }
        break;
      case "workouts_have_active_exercise": {
        const empty = findWorkoutsWithoutActiveExercise(program);
        if (empty.length === 0) issues.push({ key: rule.rule, rule: rule.rule, message: "Every workout needs at least one active exercise.", action: editPrescription() });
        for (const w of empty) {
          issues.push({
            key: `${rule.rule}:${w.id}`,
            rule: rule.rule,
            workoutId: w.id,
            workoutLabel: labelOf(w),
            message: w.exercises.length === 0 ? "This workout has no exercises." : "This workout has no active exercises.",
            action: editPrescription(w.id),
          });
        }
        break;
      }
      case "active_exercises_have_dosage": {
        let located = 0;
        for (const w of program.workouts) {
          for (const e of activeExercises(w)) {
            if (e.dosage) continue;
            located++;
            issues.push({
              key: `${rule.rule}:${e.id}`,
              rule: rule.rule,
              workoutId: w.id,
              workoutLabel: labelOf(w),
              exerciseId: e.id,
              exerciseName: exerciseLabel(e),
              message: "No dosage saved.",
              action: editExercise(w, e),
            });
          }
        }
        if (located === 0) issues.push({ key: rule.rule, rule: rule.rule, message: "Every active exercise needs a saved dosage.", action: editPrescription() });
        break;
      }
      case "active_exercise_dosage_valid": {
        const invalid = findInvalidDosages(program);
        if (invalid.length === 0) issues.push({ key: rule.rule, rule: rule.rule, message: "A saved dosage is invalid. Re-open and save each dosage in the builder.", action: editPrescription() });
        for (const { workout, exercise, message } of invalid) {
          issues.push({
            key: `${rule.rule}:${exercise.id}`,
            rule: rule.rule,
            workoutId: workout.id,
            workoutLabel: labelOf(workout),
            exerciseId: exercise.id,
            exerciseName: exerciseLabel(exercise),
            message: `Saved dosage is invalid: ${message}`,
            action: editExercise(workout, exercise),
          });
        }
        break;
      }
      case "scheduling_mode_present":
        issues.push({ key: rule.rule, rule: rule.rule, message: "Choose a scheduling mode (Sequence or Calendar).", action: editSchedule() });
        break;
      case "sequence_target_frequency_present":
        issues.push({ key: rule.rule, rule: rule.rule, message: "Set a target number of sessions per week for the Sequence schedule.", action: editSchedule() });
        break;
      case "calendar_target_frequency_absent":
        issues.push({
          key: rule.rule,
          rule: rule.rule,
          message: "Calendar schedules don't use a sessions-per-week target, but one is still saved. Re-select Calendar in the builder to clear it.",
          action: editSchedule(),
        });
        break;
      case "sequence_ordering_valid":
        issues.push({ key: rule.rule, rule: rule.rule, message: "Workout order is inconsistent. Reorder the workouts in the builder to repair it.", action: editPrescription() });
        break;
      case "calendar_days_present": {
        let located = 0;
        for (const w of program.workouts) {
          if ((w.daysOfWeek ?? []).length > 0) continue;
          located++;
          issues.push({ key: `${rule.rule}:${w.id}`, rule: rule.rule, workoutId: w.id, workoutLabel: labelOf(w), message: "No weekday assigned.", action: editSchedule(w.id) });
        }
        if (located === 0) issues.push({ key: rule.rule, rule: rule.rule, message: "Every workout needs at least one weekday.", action: editSchedule() });
        break;
      }
      case "calendar_weekdays_exclusive": {
        let located = 0;
        for (const day of WEEKDAY_ORDER) {
          const owners = program.workouts.filter((w) => (w.daysOfWeek ?? []).includes(day.value));
          if (owners.length < 2) continue;
          located++;
          issues.push({
            key: `${rule.rule}:${day.value}`,
            rule: rule.rule,
            workoutId: owners[0].id,
            message: `${day.long} is assigned to more than one workout (${owners.map(labelOf).join(", ")}).`,
            action: editSchedule(owners[0].id),
          });
        }
        if (located === 0) issues.push({ key: rule.rule, rule: rule.rule, message: "Each weekday may belong to only one workout.", action: editSchedule() });
        break;
      }
      case "exercises_active_and_accessible": {
        let located = 0;
        for (const w of program.workouts) {
          for (const e of w.exercises) {
            if (!params.unavailableExerciseIds?.has(e.canonicalExerciseId)) continue;
            located++;
            issues.push({
              key: `${rule.rule}:${e.id}`,
              rule: rule.rule,
              workoutId: w.id,
              workoutLabel: labelOf(w),
              exerciseId: e.id,
              exerciseName: exerciseLabel(e),
              message: "This exercise is no longer available in the exercise library. Remove or replace it.",
              action: editExercise(w, e),
            });
          }
        }
        if (located === 0) {
          issues.push({ key: rule.rule, rule: rule.rule, message: "One or more exercises are no longer available in the exercise library.", action: editPrescription() });
        }
        break;
      }
      case "has_prior_clinical_state":
        issues.push({
          key: rule.rule,
          rule: rule.rule,
          message: "This patient has no clinical stage record on file yet. A stage/irritability record is required before a prescription can be published.",
          action: null,
        });
        break;
      default:
        issues.push({ key: rule.rule, rule: rule.rule, message: rule.detail, action: editPrescription() });
    }
  }
  // Read in program order: prescription-level issues first, then by workout,
  // then by exercise position (stable within each group).
  const workoutRank = new Map(program.workouts.map((w, i) => [w.id, i]));
  const exerciseRank = new Map(program.workouts.flatMap((w) => w.exercises.map((e, i) => [e.id, i] as const)));
  const rank = (issue: ReviewIssue) => [
    issue.workoutId !== undefined ? (workoutRank.get(issue.workoutId) ?? -1) : -1,
    issue.exerciseId !== undefined ? (exerciseRank.get(issue.exerciseId) ?? -1) : -1,
  ];
  return issues
    .map((issue, index) => ({ issue, index, r: rank(issue) }))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.index - b.index)
    .map((x) => x.issue);
}
