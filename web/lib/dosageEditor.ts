// C5.4B — Exercise Dosage Authoring. Pure, deterministic domain logic only
// (no server-only import, no DB access) — safe to import from the client
// dosage editor AND from prescriptionDraftServer.ts (server-side, for
// authoritative pre-flight validation), matching the
// clinicianRoster.ts/canonicalExerciseLibrary.ts split convention already
// used elsewhere. This is the ONE validator — the API route/service layer
// calls the exact same function the editor uses for immediate feedback, so
// validation rules are never duplicated or allowed to drift (C5.4B §21).

import { formatSeconds } from "./canonicalExerciseLibrary";
import type { DosageInput, DosageMode, DosageType, LoadType, LoadUnit, LoadMode, AssistanceLevel, Side, DistanceUnit, DosageCapability, OptionalFieldCapability } from "./prescriptionDraftTypes";

export type DosageValidationError = { field: string; message: string };

// C5.4 Revision B — the five specialized dosage dimensions, exactly
// mirroring canonical_exercises.dosage_capabilities' approved vocabulary
// (Revision A). Order here IS the deterministic primary-dosage_type
// precedence used by deriveDosageType() below, and also the fixed left-to-
// right display order for capability-driven field visibility.
export const SPECIALIZED_CAPABILITIES: DosageCapability[] = ["hold", "contacts", "distance", "interval_time", "reps"];

// The fixed left-to-right DISPLAY order for capability-driven fields in the
// compact editor (Sets, then these, then Load, then Rest) — deliberately
// separate from SPECIALIZED_CAPABILITIES' derivation precedence above;
// display order favors the founder's exact worked examples (reps before
// hold), which is not the same ordering as "most clinically distinctive".
export const CAPABILITY_DISPLAY_ORDER: DosageCapability[] = ["reps", "hold", "contacts", "distance", "interval_time"];

export const CAPABILITY_LABELS: Record<DosageCapability, string> = {
  hold: "Hold",
  contacts: "Contacts",
  distance: "Distance",
  interval_time: "Time / Interval",
  reps: "Repetitions",
};

// Maps a capability to the DosageType it corresponds to for derivation
// purposes ("interval_time" capability <-> "time" dosage_type — the
// vocabularies differ in name only, never in meaning).
const CAPABILITY_TO_DOSAGE_TYPE: Record<DosageCapability, DosageType> = {
  reps: "repetition",
  hold: "hold",
  contacts: "contact",
  distance: "distance",
  interval_time: "time",
};
const DOSAGE_TYPE_TO_CAPABILITY: Record<DosageType, DosageCapability> = {
  repetition: "reps",
  hold: "hold",
  contact: "contacts",
  distance: "distance",
  time: "interval_time",
};

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

// C5.4 Revision B — whether a specialized dimension currently has ANY
// authored shape (a chosen mode, or for distance an assigned unit before a
// mode is even picked). Used both for capability-driven field visibility
// (a populated dimension is always shown, even if not a capability default —
// "existing saved dosage must continue opening correctly") and for
// deriveDosageType() below.
export function isCapabilityPopulated(draft: Pick<DosageDraft, "repsMode" | "holdDurationMode" | "contactsMode" | "distanceMode" | "distanceUnit" | "timeDurationMode" | "intervalWorkSeconds" | "intervalRecoverySeconds" | "intervalRounds">, capability: DosageCapability): boolean {
  switch (capability) {
    case "reps":
      return draft.repsMode != null;
    case "hold":
      return draft.holdDurationMode != null;
    case "contacts":
      return draft.contactsMode != null;
    case "distance":
      return draft.distanceMode != null || draft.distanceUnit != null;
    case "interval_time":
      return draft.timeDurationMode != null || draft.intervalWorkSeconds != null || draft.intervalRecoverySeconds != null || draft.intervalRounds != null;
  }
}

// C5.4 Revision B decision #23 — deterministic dosage_type derivation now
// that the clinician no longer chooses it:
//   1. Prefer the exercise's existing dosage_type IF that dimension remains
//      populated (preserves continuity — e.g. an isometric hold exercise
//      that already has reps added stays primarily "hold", never silently
//      flips just because reps also has a value).
//   2. Otherwise, the most-specialized POPULATED dimension wins, using a
//      fixed precedence (SPECIALIZED_CAPABILITIES order: hold > contacts >
//      distance > interval_time > reps) — reps is treated as the least
//      distinctive specialized signal since it is by far the most common
//      dimension in the library, so when combined with anything rarer the
//      rarer one is almost always the clinically primary intent.
//   3. If NO specialized dimension is populated at all (only universal
//      dimensions — sets/load/rest/tempo/RPE-RIR/ROM/assistance/side —
//      have values), 'repetition' is the safe backward-compatible default:
//      every dosage_type's "not populated" shape branches are symmetric for
//      this case, so no real ambiguity or schema blocker exists.
export function deriveDosageType(draft: DosageDraft, previousDosageType?: DosageType | null): DosageType {
  if (previousDosageType && isCapabilityPopulated(draft, DOSAGE_TYPE_TO_CAPABILITY[previousDosageType])) {
    return previousDosageType;
  }
  for (const capability of SPECIALIZED_CAPABILITIES) {
    if (isCapabilityPopulated(draft, capability)) return CAPABILITY_TO_DOSAGE_TYPE[capability];
  }
  return "repetition";
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
//
// C5.4 Revision A: each dimension (reps/hold/contacts/distance/time+
// interval/load) is validated independently, based on whether THAT
// dimension is populated — never gated by `type` (`dosageType`). `type`
// remains required (it is preserved as the primary-dimension / legacy-
// display hint, founder decision #3) but no longer suppresses validation of
// any OTHER populated dimension (decision #4/#15) — this mirrors the DB's
// own constraint redesign exactly (see the Revision A migration). The two
// type==="time"-specific messages below are kept for continuity with the
// existing C5.4B editor's single-type flow (choosing Time and entering
// nothing still gets the same specific, friendly message it always did);
// they do not gate anything for OTHER dimensions, which validate
// unconditionally whenever populated.
//
// C5.4 Revision B: the clinician no longer chooses a primary dosageType at
// all (see deriveDosageType()), so this no longer requires one or grants
// any dimension a "required because it's the selected type" status —
// EVERY dimension validates purely on whether it is itself populated.
// Capability means available/applicable, never required (decision #22): an
// exercise capable of both reps and hold may legitimately save hold-only.
// The only remaining "must have SOMETHING" rule is the generic
// at-least-one-dimension check at the bottom, which fires once, with one
// message, regardless of which dimensions the exercise happens to support.
export function validateDosageInput(input: DosageDraft): DosageValidationError[] {
  const errors: DosageValidationError[] = [];

  if (input.repsMode != null) {
    validateExactOrRange(errors, input.repsMode, input.repsExact, input.repsMin, input.repsMax, "reps", "repetition count");
  }
  if (input.holdDurationMode != null) {
    validateExactOrRange(errors, input.holdDurationMode, input.holdDurationExactSeconds, input.holdDurationMinSeconds, input.holdDurationMaxSeconds, "holdDuration", "hold duration");
  }
  if (input.contactsMode != null) {
    validateExactOrRange(errors, input.contactsMode, input.contactsExact, input.contactsMin, input.contactsMax, "contacts", "contact count");
  }
  if (input.distanceMode != null || input.distanceUnit != null) {
    if (!input.distanceUnit) errors.push({ field: "distanceUnit", message: "Select a distance unit." });
    if (input.distanceMode != null) {
      validateExactOrRange(errors, input.distanceMode, input.distanceExactValue, input.distanceMinValue, input.distanceMaxValue, "distance", "distance");
    }
  }
  if (input.timeDurationMode != null) {
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

  const loadType = input.loadType ?? "not_applicable";
  if (loadType === "external") {
    if (!input.loadUnit) errors.push({ field: "loadUnit", message: "Select a load unit." });
    // NULL loadMode is treated as "exact" for backward compatibility with
    // every dosage row written before Revision A (see the migration) — the
    // editor itself always writes an explicit mode going forward.
    const loadMode: LoadMode | null = input.loadMode ?? (input.loadValueExact != null ? "exact" : null);
    if (loadMode === "range") {
      if (!isPositive(input.loadValueMin) || !isPositive(input.loadValueMax)) {
        errors.push({ field: "loadValueRange", message: "Enter both a minimum and maximum load." });
      } else if (input.loadValueMin > input.loadValueMax) {
        errors.push({ field: "loadValueRange", message: "Minimum cannot exceed maximum." });
      }
    } else if (!isPositive(input.loadValueExact)) {
      errors.push({ field: "loadValueExact", message: "Enter a load value." });
    }
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

  // At least one meaningful dosage dimension (C5.4 Revision A decision #5)
  // — mirrors the DB's dosage_at_least_one_dimension constraint exactly.
  // Replaces the old per-type "sets required unless time" rule, which was
  // itself a dosage_type-coupled artifact of the exclusive model.
  const hasAnyDimension =
    input.sets != null ||
    input.repsMode != null ||
    input.holdDurationMode != null ||
    input.contactsMode != null ||
    input.distanceMode != null ||
    input.timeDurationMode != null ||
    input.intervalWorkSeconds != null ||
    input.intervalRecoverySeconds != null ||
    input.intervalRounds != null ||
    loadType !== "not_applicable";
  if (!hasAnyDimension) {
    errors.push({ field: "dosage", message: "Enter at least one dosage dimension (sets, reps, hold, contacts, time, interval, distance, or load)." });
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

// C5.4 Revision A — range-aware. A NULL loadMode with loadValueExact
// populated is treated as "exact" (matches every pre-Revision-A row, whose
// loadMode column is NULL — see the migration's shape constraint).
export function formatLoadLabel(input: {
  loadType?: LoadType;
  loadValueExact?: number | null;
  loadUnit?: LoadUnit | null;
  loadMode?: LoadMode | null;
  loadValueMin?: number | null;
  loadValueMax?: number | null;
}): string | null {
  switch (input.loadType) {
    case "external": {
      if (!input.loadUnit) return null;
      if (input.loadMode === "range" && input.loadValueMin != null && input.loadValueMax != null) {
        return `${trimNumber(input.loadValueMin)}–${trimNumber(input.loadValueMax)} ${input.loadUnit}`;
      }
      return input.loadValueExact != null ? `${trimNumber(input.loadValueExact)} ${input.loadUnit}` : null;
    }
    case "bodyweight":
      return "Bodyweight";
    case "assisted":
      return "Assisted";
    default:
      return null;
  }
}

// C5.4 Revision E — the collapsed card's saved prescription, as discrete
// items rather than one dense sentence, so the card can render scannable
// chips. `primary` items are the core dose (sets, specialized dimensions,
// load, rest); `modifier` items are the More-options values (tempo, RPE,
// RIR, ROM, assistance, side), which must stay visible after save rather
// than disappearing back behind More options. Only fields that actually
// carry a saved value produce an item — nothing is defaulted or zero-filled.
export type DosageSummaryItem = {
  key: string;
  kind: "primary" | "modifier";
  // `value` is the emphasized part; `suffix` is the muted unit/label that
  // follows it ("12" + "reps"), `prefix` a muted label before it ("RPE" + "7").
  value: string;
  prefix?: string;
  suffix?: string;
};

const ASSISTANCE_SUMMARY_LABELS: Record<AssistanceLevel, string> = {
  contact_guard: "Contact guard",
  minimal: "Minimal",
  moderate: "Moderate",
  maximum: "Maximum",
};

const SIDE_SUMMARY_LABELS: Record<Side, string> = {
  bilateral: "Bilateral",
  left: "Left side",
  right: "Right side",
  both_sides_separately: "Each side",
  not_applicable: "Side n/a",
};

export function buildDosageSummary(d: DosageDraft): DosageSummaryItem[] {
  const items: DosageSummaryItem[] = [];
  const primary = (key: string, value: string | null, suffix?: string) => {
    if (value) items.push({ key, kind: "primary", value, suffix });
  };

  if (d.sets != null) primary("sets", String(d.sets), d.sets === 1 ? "set" : "sets");
  primary("reps", formatExactOrRangeValue(d.repsMode, d.repsExact, d.repsMin, d.repsMax, trimNumber), "reps");
  primary("hold", formatExactOrRangeValue(d.holdDurationMode, d.holdDurationExactSeconds, d.holdDurationMinSeconds, d.holdDurationMaxSeconds, formatSeconds), "hold");
  primary("contacts", formatExactOrRangeValue(d.contactsMode, d.contactsExact, d.contactsMin, d.contactsMax, trimNumber), "contacts");
  const distance = formatExactOrRangeValue(d.distanceMode, d.distanceExactValue, d.distanceMinValue, d.distanceMaxValue, trimNumber);
  primary("distance", distance ? `${distance}${d.distanceUnit ? ` ${d.distanceUnit}` : ""}` : null);
  primary("duration", formatExactOrRangeValue(d.timeDurationMode, d.timeDurationExactSeconds, d.timeDurationMinSeconds, d.timeDurationMaxSeconds, formatSeconds));
  if (d.intervalWorkSeconds != null) primary("work", formatSeconds(d.intervalWorkSeconds), "work");
  if (d.intervalRecoverySeconds != null) primary("recovery", formatSeconds(d.intervalRecoverySeconds), "recovery");
  if (d.intervalRounds != null) primary("rounds", String(d.intervalRounds), d.intervalRounds === 1 ? "round" : "rounds");
  primary("load", formatLoadLabel(d));
  if (d.restSeconds != null) primary("rest", formatSeconds(d.restSeconds), "rest");

  const tempoParts: string[] = [];
  if (d.concentricDurationSeconds != null) tempoParts.push(`${formatSeconds(d.concentricDurationSeconds)} up`);
  if (d.repHoldDurationSeconds != null) tempoParts.push(`${formatSeconds(d.repHoldDurationSeconds)} hold`);
  if (d.eccentricDurationSeconds != null) tempoParts.push(`${formatSeconds(d.eccentricDurationSeconds)} down`);
  const tempoDescription = d.tempoDescription?.trim();
  if (tempoDescription) tempoParts.push(tempoDescription);
  if (tempoParts.length > 0) items.push({ key: "tempo", kind: "modifier", prefix: "Tempo", value: tempoParts.join(" · ") });
  if (d.rpe != null) items.push({ key: "rpe", kind: "modifier", prefix: "RPE", value: trimNumber(d.rpe) });
  if (d.rir != null) items.push({ key: "rir", kind: "modifier", prefix: "RIR", value: trimNumber(d.rir) });
  const rom = d.rom?.trim();
  if (rom) items.push({ key: "rom", kind: "modifier", prefix: "ROM", value: rom });
  if (d.assistanceLevel) items.push({ key: "assistance", kind: "modifier", value: ASSISTANCE_SUMMARY_LABELS[d.assistanceLevel], suffix: "assist" });
  if (d.side) items.push({ key: "side", kind: "modifier", value: SIDE_SUMMARY_LABELS[d.side] });

  return items;
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
    loadMode: (row.load_mode as LoadMode | null) ?? null,
    loadValueMin: (row.load_value_min as number | null) ?? null,
    loadValueMax: (row.load_value_max as number | null) ?? null,
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

// C5.4 Revision D — optional "More options" modifiers, mirroring
// canonical_exercises.optional_field_capabilities' approved vocabulary
// exactly (20261004000001). Order is the fixed display order.
export const OPTIONAL_FIELD_CAPABILITIES: OptionalFieldCapability[] = ["tempo", "rpe", "rir", "rom", "assistance", "side"];

// Whether a draft/saved dosage already carries a value for an optional
// field. Same notion of "populated" hasAdvancedDosageValues() uses.
export function isOptionalFieldPopulated(dosage: DosageDraft | DosageInput | null | undefined, field: OptionalFieldCapability): boolean {
  if (!dosage) return false;
  switch (field) {
    case "tempo":
      return (
        dosage.concentricDurationSeconds != null ||
        dosage.repHoldDurationSeconds != null ||
        dosage.eccentricDurationSeconds != null ||
        (dosage.tempoDescription != null && dosage.tempoDescription.trim().length > 0)
      );
    case "rpe":
      return dosage.rpe != null;
    case "rir":
      return dosage.rir != null;
    case "rom":
      return dosage.rom != null && dosage.rom.trim().length > 0;
    case "assistance":
      return dosage.assistanceLevel != null;
    case "side":
      return dosage.side != null;
  }
}

// C5.4 Revision D — which optional fields the editor renders. A field is
// shown when the canonical exercise lists it as applicable, OR the working
// draft carries a value, OR the last-saved dosage does. The saved-state
// check is what keeps a historical/off-capability control on screen while
// the clinician clears it, until that clear is actually saved — the same
// "never hide existing saved clinical truth" rule the specialized
// dimensions follow. `offCapability` marks the ones shown only because of
// existing data, so the editor can label them.
export function resolveOptionalFieldVisibility(
  applicable: OptionalFieldCapability[],
  draft: DosageDraft | null | undefined,
  savedDraft: DosageDraft | null | undefined
): { visible: OptionalFieldCapability[]; offCapability: OptionalFieldCapability[] } {
  const visible = OPTIONAL_FIELD_CAPABILITIES.filter(
    (field) => applicable.includes(field) || isOptionalFieldPopulated(draft, field) || isOptionalFieldPopulated(savedDraft, field)
  );
  return { visible, offCapability: visible.filter((field) => !applicable.includes(field)) };
}

// A brand-new, never-saved dosage draft — dosageType null (Revision B: no
// longer clinician-chosen at all; deriveDosageType() computes the real
// value at save time from whichever dimensions end up populated).
export function emptyDosageDraft(): DosageDraft {
  return { dosageType: null, loadType: "not_applicable" };
}

// C5.4 Revision B — the full field list mapDosageRowToInput reads, used to
// compare two drafts field-by-field for the working-state dirty check
// (BuilderShell). null/undefined are treated as equivalent so a
// freshly-initialized draft (fields undefined) compares equal to its own
// just-saved snapshot (fields null) with no special-casing at call sites.
const DOSAGE_DRAFT_COMPARE_FIELDS: (keyof DosageDraft)[] = [
  "dosageType",
  "sets",
  "repsMode",
  "repsExact",
  "repsMin",
  "repsMax",
  "contactsMode",
  "contactsExact",
  "contactsMin",
  "contactsMax",
  "holdDurationMode",
  "holdDurationExactSeconds",
  "holdDurationMinSeconds",
  "holdDurationMaxSeconds",
  "timeDurationMode",
  "timeDurationExactSeconds",
  "timeDurationMinSeconds",
  "timeDurationMaxSeconds",
  "intervalWorkSeconds",
  "intervalRecoverySeconds",
  "intervalRounds",
  "distanceMode",
  "distanceExactValue",
  "distanceMinValue",
  "distanceMaxValue",
  "distanceUnit",
  "concentricDurationSeconds",
  "repHoldDurationSeconds",
  "eccentricDurationSeconds",
  "tempoDescription",
  "restSeconds",
  "loadType",
  "loadValueExact",
  "loadUnit",
  "loadMode",
  "loadValueMin",
  "loadValueMax",
  "rpe",
  "rir",
  "rom",
  "assistanceLevel",
  "side",
];

export function dosageDraftsEqual(a: DosageDraft, b: DosageDraft): boolean {
  return DOSAGE_DRAFT_COMPARE_FIELDS.every((field) => (a[field] ?? null) === (b[field] ?? null));
}
