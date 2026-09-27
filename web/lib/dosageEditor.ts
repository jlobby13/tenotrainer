// C5.4B — Exercise Dosage Authoring. Pure, deterministic domain logic only
// (no server-only import, no DB access) — safe to import from the client
// dosage editor AND from prescriptionDraftServer.ts (server-side, for
// authoritative pre-flight validation), matching the
// clinicianRoster.ts/canonicalExerciseLibrary.ts split convention already
// used elsewhere. This is the ONE validator — the API route/service layer
// calls the exact same function the editor uses for immediate feedback, so
// validation rules are never duplicated or allowed to drift (C5.4B §21).

import { formatSeconds } from "./canonicalExerciseLibrary";
import type { DosageInput, DosageMode, DosageType, LoadType, LoadUnit, AssistanceLevel, Side, DistanceUnit } from "./prescriptionDraftTypes";

export type DosageValidationError = { field: string; message: string };

// The editor's LOCAL working state before a type has been chosen — a plain
// DosageInput cannot express "no type selected yet" (dosageType is
// required there), and C5.4B §3 requires the clinician to explicitly choose
// a type rather than one being pre-selected. Any fully-loaded persisted
// DosageInput is automatically also a valid DosageDraft (DosageType is
// narrower than DosageType | null), so mapDosageRowToInput's return value
// can be assigned straight into editor state with no cast.
export type DosageDraft = Omit<DosageInput, "dosageType"> & { dosageType: DosageType | null };

function isPositive(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

// Mirrors the exact/range CHECK constraints already enforced by every one
// of prescription_exercise_dosage's four exact/range quantities
// (reps/contacts/hold/time) plus C5.3F's distance addition — this
// duplicates the SHAPE of those constraints for friendly pre-flight
// messaging, it does not replace them (the DB remains authoritative; see
// updateDosage()).
function validateExactOrRange(
  errors: DosageValidationError[],
  mode: DosageMode | null | undefined,
  exact: number | null | undefined,
  min: number | null | undefined,
  max: number | null | undefined,
  field: string,
  label: string
): void {
  if (mode === "exact") {
    if (!isPositive(exact)) errors.push({ field: `${field}Exact`, message: `Enter an exact ${label}.` });
  } else if (mode === "range") {
    if (!isPositive(min) || !isPositive(max)) {
      errors.push({ field: `${field}Range`, message: `Enter both a minimum and maximum ${label}.` });
    } else if (min > max) {
      errors.push({ field: `${field}Range`, message: "Minimum cannot exceed maximum." });
    }
  } else {
    errors.push({ field: `${field}Mode`, message: `Choose exact or range for ${label}.` });
  }
}

// Authoritative-enough to reject before ever reaching the DB, but never the
// ONLY line of defense — the DB's own CHECK constraints are unchanged and
// remain the true authority (see prescriptionDraftServer.ts's updateDosage
// header). RPE/RIR mutual exclusion is the one rule that exists ONLY here
// (C5.4B §11) — the DB schema itself permits both simultaneously.
export function validateDosageInput(input: DosageDraft): DosageValidationError[] {
  const errors: DosageValidationError[] = [];
  const type = input.dosageType;
  if (!type) {
    errors.push({ field: "dosageType", message: "Select a dosage type." });
    return errors;
  }

  if (type !== "time" && !isPositive(input.sets)) {
    errors.push({ field: "sets", message: "Sets is required." });
  }

  if (type === "repetition") {
    validateExactOrRange(errors, input.repsMode, input.repsExact, input.repsMin, input.repsMax, "reps", "repetition count");
  } else if (type === "hold") {
    validateExactOrRange(errors, input.holdDurationMode, input.holdDurationExactSeconds, input.holdDurationMinSeconds, input.holdDurationMaxSeconds, "holdDuration", "hold duration");
  } else if (type === "contact") {
    validateExactOrRange(errors, input.contactsMode, input.contactsExact, input.contactsMin, input.contactsMax, "contacts", "contact count");
  } else if (type === "distance") {
    if (!input.distanceUnit) errors.push({ field: "distanceUnit", message: "Select a distance unit." });
    validateExactOrRange(errors, input.distanceMode, input.distanceExactValue, input.distanceMinValue, input.distanceMaxValue, "distance", "distance");
  } else if (type === "time") {
    const hasDuration = !!input.timeDurationMode;
    const hasInterval = input.intervalWorkSeconds != null || input.intervalRecoverySeconds != null || input.intervalRounds != null;
    if (!hasDuration && !hasInterval) {
      errors.push({ field: "timeDurationMode", message: "Enter a total duration or an interval pattern." });
    }
    if (hasDuration) {
      validateExactOrRange(errors, input.timeDurationMode, input.timeDurationExactSeconds, input.timeDurationMinSeconds, input.timeDurationMaxSeconds, "timeDuration", "duration");
    }
    if (input.intervalWorkSeconds != null && !isPositive(input.intervalWorkSeconds)) {
      errors.push({ field: "intervalWorkSeconds", message: "Work interval must be greater than zero." });
    }
    if (input.intervalRecoverySeconds != null && !isPositive(input.intervalRecoverySeconds)) {
      errors.push({ field: "intervalRecoverySeconds", message: "Recovery interval must be greater than zero." });
    }
    if (input.intervalRounds != null && !(input.intervalRounds > 0)) {
      errors.push({ field: "intervalRounds", message: "Rounds must be greater than zero." });
    }
  }

  const loadType = input.loadType ?? "not_applicable";
  if (loadType === "external") {
    if (!isPositive(input.loadValueExact)) errors.push({ field: "loadValueExact", message: "Enter a load value." });
    if (!input.loadUnit) errors.push({ field: "loadUnit", message: "Select a load unit." });
  }

  if (input.rpe != null && input.rir != null) {
    errors.push({ field: "rpeRir", message: "Choose either RPE or RIR, not both." });
  }
  if (input.rpe != null && (input.rpe < 0 || input.rpe > 10)) {
    errors.push({ field: "rpe", message: "RPE must be between 0 and 10." });
  }
  if (input.rir != null && (input.rir < 0 || input.rir > 10)) {
    errors.push({ field: "rir", message: "RIR must be between 0 and 10." });
  }
  if (input.restSeconds != null && input.restSeconds < 0) {
    errors.push({ field: "restSeconds", message: "Rest cannot be negative." });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Lossless minutes/seconds <-> total-seconds conversion (C5.4B §7 — "Do not
// require clinicians to manually convert minutes to seconds mentally").
// ---------------------------------------------------------------------------
export function secondsToMinSec(totalSeconds: number | null | undefined): { min: number | null; sec: number | null } {
  if (totalSeconds == null) return { min: null, sec: null };
  return { min: Math.floor(totalSeconds / 60), sec: Math.round(totalSeconds % 60) };
}

export function minSecToSeconds(min: number | null, sec: number | null): number | null {
  if (min == null && sec == null) return null;
  return (min ?? 0) * 60 + (sec ?? 0);
}

// ---------------------------------------------------------------------------
// Concise, display-only prescribed-dose summary (C5.4B §17). Derived
// entirely from structured fields every time it is rendered — NEVER
// persisted as its own column, so it can never drift from the structured
// truth it summarizes.
// ---------------------------------------------------------------------------
function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function formatExactOrRangeValue(
  mode: DosageMode | null | undefined,
  exact: number | null | undefined,
  min: number | null | undefined,
  max: number | null | undefined,
  formatter: (n: number) => string
): string | null {
  if (mode === "exact" && exact != null) return formatter(exact);
  if (mode === "range" && min != null && max != null) return `${formatter(min)}–${formatter(max)}`;
  return null;
}

export function formatLoadLabel(input: { loadType?: LoadType; loadValueExact?: number | null; loadUnit?: LoadUnit | null }): string | null {
  switch (input.loadType) {
    case "external":
      return input.loadValueExact != null && input.loadUnit ? `${trimNumber(input.loadValueExact)} ${input.loadUnit}` : null;
    case "bodyweight":
      return "Bodyweight";
    case "assisted":
      return "Assisted";
    default:
      return null;
  }
}

export function formatDosageSummary(d: DosageDraft): string {
  const parts: string[] = [];
  const setsPrefix = d.sets != null ? `${d.sets} × ` : "";

  switch (d.dosageType) {
    case "repetition": {
      const reps = formatExactOrRangeValue(d.repsMode, d.repsExact, d.repsMin, d.repsMax, (n) => `${n}`);
      if (reps) parts.push(`${setsPrefix}${reps}`);
      break;
    }
    case "hold": {
      const hold = formatExactOrRangeValue(d.holdDurationMode, d.holdDurationExactSeconds, d.holdDurationMinSeconds, d.holdDurationMaxSeconds, formatSeconds);
      if (hold) parts.push(`${setsPrefix}${hold} hold`);
      break;
    }
    case "contact": {
      const contacts = formatExactOrRangeValue(d.contactsMode, d.contactsExact, d.contactsMin, d.contactsMax, (n) => `${n}`);
      if (contacts) parts.push(`${setsPrefix}${contacts} contacts`);
      break;
    }
    case "distance": {
      const dist = formatExactOrRangeValue(d.distanceMode, d.distanceExactValue, d.distanceMinValue, d.distanceMaxValue, trimNumber);
      if (dist) parts.push(`${setsPrefix}${dist}${d.distanceUnit ? ` ${d.distanceUnit}` : ""}`);
      break;
    }
    case "time": {
      const duration = formatExactOrRangeValue(d.timeDurationMode, d.timeDurationExactSeconds, d.timeDurationMinSeconds, d.timeDurationMaxSeconds, formatSeconds);
      const intervalPieces: string[] = [];
      if (d.intervalWorkSeconds != null) intervalPieces.push(`${formatSeconds(d.intervalWorkSeconds)} work`);
      if (d.intervalRecoverySeconds != null) intervalPieces.push(`${formatSeconds(d.intervalRecoverySeconds)} recovery`);
      let intervalStr = intervalPieces.length > 0 ? intervalPieces.join(" / ") : null;
      if (intervalStr && d.intervalRounds != null) intervalStr += ` × ${d.intervalRounds} rounds`;
      if (duration && intervalStr) parts.push(`${duration} (${intervalStr})`);
      else if (duration) parts.push(duration);
      else if (intervalStr) parts.push(intervalStr);
      break;
    }
  }

  const loadLabel = formatLoadLabel(d);
  if (loadLabel) parts.push(loadLabel);
  if (d.restSeconds != null) parts.push(`${formatSeconds(d.restSeconds)} rest`);

  return parts.length > 0 ? parts.join(" · ") : "Dosage needed";
}

// ---------------------------------------------------------------------------
// Raw DB row (snake_case, as returned inside getDraft()'s nested
// prescription_exercise_dosage select) -> DosageInput (camelCase). Used both
// server-side (builder page's initial render) and client-side (BuilderShell's
// refreshDraft) so the two enrichment paths can never drift apart.
// ---------------------------------------------------------------------------
export function mapDosageRowToInput(row: Record<string, unknown> | null | undefined): DosageInput | null {
  if (!row) return null;
  return {
    dosageType: row.dosage_type as DosageType,
    sets: (row.sets as number | null) ?? null,
    repsMode: (row.reps_mode as DosageMode | null) ?? null,
    repsExact: (row.reps_exact as number | null) ?? null,
    repsMin: (row.reps_min as number | null) ?? null,
    repsMax: (row.reps_max as number | null) ?? null,
    contactsMode: (row.contacts_mode as DosageMode | null) ?? null,
    contactsExact: (row.contacts_exact as number | null) ?? null,
    contactsMin: (row.contacts_min as number | null) ?? null,
    contactsMax: (row.contacts_max as number | null) ?? null,
    holdDurationMode: (row.hold_duration_mode as DosageMode | null) ?? null,
    holdDurationExactSeconds: (row.hold_duration_exact_seconds as number | null) ?? null,
    holdDurationMinSeconds: (row.hold_duration_min_seconds as number | null) ?? null,
    holdDurationMaxSeconds: (row.hold_duration_max_seconds as number | null) ?? null,
    timeDurationMode: (row.time_duration_mode as DosageMode | null) ?? null,
    timeDurationExactSeconds: (row.time_duration_exact_seconds as number | null) ?? null,
    timeDurationMinSeconds: (row.time_duration_min_seconds as number | null) ?? null,
    timeDurationMaxSeconds: (row.time_duration_max_seconds as number | null) ?? null,
    intervalWorkSeconds: (row.interval_work_seconds as number | null) ?? null,
    intervalRecoverySeconds: (row.interval_recovery_seconds as number | null) ?? null,
    intervalRounds: (row.interval_rounds as number | null) ?? null,
    distanceMode: (row.distance_mode as DosageMode | null) ?? null,
    distanceExactValue: (row.distance_exact_value as number | null) ?? null,
    distanceMinValue: (row.distance_min_value as number | null) ?? null,
    distanceMaxValue: (row.distance_max_value as number | null) ?? null,
    distanceUnit: (row.distance_unit as DistanceUnit | null) ?? null,
    concentricDurationSeconds: (row.concentric_duration_seconds as number | null) ?? null,
    repHoldDurationSeconds: (row.rep_hold_duration_seconds as number | null) ?? null,
    eccentricDurationSeconds: (row.eccentric_duration_seconds as number | null) ?? null,
    tempoDescription: (row.tempo_description as string | null) ?? null,
    restSeconds: (row.rest_seconds as number | null) ?? null,
    loadType: (row.load_type as LoadType) ?? "not_applicable",
    loadValueExact: (row.load_value_exact as number | null) ?? null,
    loadUnit: (row.load_unit as LoadUnit | null) ?? null,
    rpe: (row.rpe as number | null) ?? null,
    rir: (row.rir as number | null) ?? null,
    rom: (row.rom as string | null) ?? null,
    assistanceLevel: (row.assistance_level as AssistanceLevel | null) ?? null,
    side: (row.side as Side | null) ?? null,
  };
}

// C5.4B founder UX correction — "More options" progressive disclosure.
// Determines whether the collapsible advanced section should START
// expanded: true the moment ANY advanced field (structured tempo, tempo
// description, RPE, RIR, ROM, assistance, side, or patient-specific
// instructions) already carries a persisted value, so a clinician can never
// open an existing prescription and unknowingly miss advanced content
// because the section defaulted closed. A brand-new dosage with none of
// these values starts collapsed. This is evaluated ONCE at editor-open time
// (component mount) — it never forces the section back open after that,
// so a clinician who deliberately collapses it while editing is not
// fought by the UI.
export function hasAdvancedDosageValues(dosage: DosageDraft | DosageInput | null, instructions: string | null): boolean {
  if (instructions != null && instructions.trim().length > 0) return true;
  if (!dosage) return false;
  return (
    dosage.concentricDurationSeconds != null ||
    dosage.repHoldDurationSeconds != null ||
    dosage.eccentricDurationSeconds != null ||
    (dosage.tempoDescription != null && dosage.tempoDescription.trim().length > 0) ||
    dosage.rpe != null ||
    dosage.rir != null ||
    (dosage.rom != null && dosage.rom.trim().length > 0) ||
    dosage.assistanceLevel != null ||
    dosage.side != null
  );
}

// A brand-new, never-saved dosage draft for the editor's initial local
// state — dosageType deliberately null so the clinician must explicitly
// choose one (C5.4B §3 — never auto-selected from reference dosage or
// anything else).
export function emptyDosageDraft(): DosageDraft {
  return { dosageType: null, loadType: "not_applicable" };
}
