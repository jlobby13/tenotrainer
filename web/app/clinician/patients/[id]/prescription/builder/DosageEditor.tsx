"use client";

// C5.4B — Exercise Dosage Authoring editor. Opens inline within a draft row
// (BuilderShell/DraftPanel own the "only one open at a time" state — see
// BuilderShell's editingDosageExerciseId). Explicit Save/Cancel only, no
// autosave (§17-18). Local validation mirrors the server's authoritative
// validateDosageInput() exactly (same function, imported — never a second,
// possibly-inconsistent copy of the rules).

import { useMemo, useState } from "react";
import {
  validateDosageInput,
  formatLoadLabel,
  secondsToMinSec,
  minSecToSeconds,
  emptyDosageDraft,
  hasAdvancedDosageValues,
  type DosageDraft,
  type DosageValidationError,
} from "@/lib/dosageEditor";
import { formatReferenceDosageSummary, type ReferenceDosageLike } from "@/lib/canonicalExerciseLibrary";
import type { DosageInput, DosageType, DosageMode, LoadType, LoadUnit, AssistanceLevel, Side, DistanceUnit } from "@/lib/prescriptionDraftTypes";

type Props = {
  initialDosage: DosageInput | null;
  initialInstructions: string | null;
  referenceDosage: ReferenceDosageLike | null;
  onSave: (dosage: DosageInput, additionalInstructions: string | null) => Promise<{ ok: true } | { ok: false; message: string }>;
  onCancel: () => void;
};

const DOSAGE_TYPE_OPTIONS: { value: DosageType; label: string }[] = [
  { value: "repetition", label: "Repetition" },
  { value: "hold", label: "Hold" },
  { value: "contact", label: "Contact / Reactive" },
  { value: "time", label: "Time" },
  { value: "distance", label: "Distance" },
];

const ASSISTANCE_OPTIONS: { value: AssistanceLevel; label: string }[] = [
  { value: "contact_guard", label: "Contact Guard" },
  { value: "minimal", label: "Minimal" },
  { value: "moderate", label: "Moderate" },
  { value: "maximum", label: "Maximum" },
];

const SIDE_OPTIONS: { value: Side; label: string }[] = [
  { value: "bilateral", label: "Bilateral" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "both_sides_separately", label: "Both sides separately" },
  { value: "not_applicable", label: "Not applicable" },
];

const DISTANCE_UNITS: DistanceUnit[] = ["m", "km", "ft", "mi"];

function errorFor(errors: DosageValidationError[], ...fields: string[]): string | undefined {
  return errors.find((e) => fields.includes(e.field))?.message;
}

export function DosageEditor({ initialDosage, initialInstructions, referenceDosage, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState<DosageDraft>(initialDosage ?? emptyDosageDraft());
  const [instructions, setInstructions] = useState<string>(initialInstructions ?? "");
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Founder UX correction — computed ONCE from the INITIAL persisted state
  // (never re-evaluated on every keystroke, so manually collapsing it while
  // editing is never fought). Collapsing/expanding is presentation only —
  // the underlying `draft`/`instructions` state is untouched either way, so
  // no advanced value is ever lost by toggling this.
  const [moreOpen, setMoreOpen] = useState<boolean>(() => hasAdvancedDosageValues(initialDosage, initialInstructions));

  const errors = useMemo(() => validateDosageInput(draft), [draft]);

  function patch(fields: Partial<DosageDraft>) {
    setDraft((prev) => ({ ...prev, ...fields }));
  }

  // Switching type clears every OTHER type's quantity fields (reps/
  // contacts/hold/time-interval/distance) so none of them can survive as
  // stale, semantically-wrong values under the new type — this is the
  // client-side half of C5.4B §20's guarantee; updateDosage()'s full-row
  // upsert (never a partial patch) is the other half. Every SHARED optional
  // field (sets, load, rest, tempo, RPE/RIR, ROM, assistance, side,
  // patient instructions) is deliberately preserved — a clinician
  // switching Repetition -> Hold should not lose the rest interval or
  // tempo they already entered.
  function handleTypeChange(nextType: DosageType) {
    setDraft((prev) => ({
      ...prev,
      dosageType: nextType,
      repsMode: null,
      repsExact: null,
      repsMin: null,
      repsMax: null,
      contactsMode: null,
      contactsExact: null,
      contactsMin: null,
      contactsMax: null,
      holdDurationMode: null,
      holdDurationExactSeconds: null,
      holdDurationMinSeconds: null,
      holdDurationMaxSeconds: null,
      timeDurationMode: null,
      timeDurationExactSeconds: null,
      timeDurationMinSeconds: null,
      timeDurationMaxSeconds: null,
      intervalWorkSeconds: null,
      intervalRecoverySeconds: null,
      intervalRounds: null,
      distanceMode: null,
      distanceExactValue: null,
      distanceMinValue: null,
      distanceMaxValue: null,
      distanceUnit: null,
    }));
  }

  async function handleSave() {
    setShowErrors(true);
    setSaveError(null);
    if (errors.length > 0 || !draft.dosageType) return;
    setSaving(true);
    try {
      const result = await onSave(draft as DosageInput, instructions.trim().length > 0 ? instructions.trim() : null);
      if (!result.ok) setSaveError(result.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 border-t border-gray-100 pt-3 space-y-4" data-testid="dosage-editor">
      {referenceDosage && (
        <div className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2 text-xs text-gray-600 space-y-0.5">
          <div className="font-semibold text-gray-500 uppercase tracking-wide text-[10px]">Reference dosage</div>
          <p>{formatReferenceDosageSummary(referenceDosage)}</p>
          <p className="text-gray-400 italic">Informational only — does not populate this patient&apos;s prescription.</p>
        </div>
      )}

      <Field label="Dosage type" error={showErrors ? errorFor(errors, "dosageType") : undefined} htmlFor="dosage-type">
        <select
          id="dosage-type"
          value={draft.dosageType ?? ""}
          onChange={(e) => handleTypeChange(e.target.value as DosageType)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="" disabled>
            Select a dosage type…
          </option>
          {DOSAGE_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </Field>

      {draft.dosageType && draft.dosageType !== "time" && (
        <Field label="Sets" error={showErrors ? errorFor(errors, "sets") : undefined} htmlFor="dosage-sets">
          <input
            id="dosage-sets"
            type="number"
            min={1}
            step={1}
            value={draft.sets ?? ""}
            onChange={(e) => patch({ sets: e.target.value === "" ? null : Number(e.target.value) })}
            className="w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </Field>
      )}

      {draft.dosageType === "repetition" && (
        <ExactRangeIntGroup
          legend="Repetitions"
          unitLabel="reps"
          mode={draft.repsMode ?? null}
          exact={draft.repsExact ?? null}
          min={draft.repsMin ?? null}
          max={draft.repsMax ?? null}
          onChange={(patchFields) =>
            patch({
              repsMode: patchFields.mode,
              repsExact: patchFields.exact,
              repsMin: patchFields.min,
              repsMax: patchFields.max,
            })
          }
          error={showErrors ? errorFor(errors, "repsMode", "repsExact", "repsRange") : undefined}
        />
      )}

      {draft.dosageType === "contact" && (
        <ExactRangeIntGroup
          legend="Contacts"
          unitLabel="contacts"
          mode={draft.contactsMode ?? null}
          exact={draft.contactsExact ?? null}
          min={draft.contactsMin ?? null}
          max={draft.contactsMax ?? null}
          onChange={(patchFields) =>
            patch({
              contactsMode: patchFields.mode,
              contactsExact: patchFields.exact,
              contactsMin: patchFields.min,
              contactsMax: patchFields.max,
            })
          }
          error={showErrors ? errorFor(errors, "contactsMode", "contactsExact", "contactsRange") : undefined}
        />
      )}

      {draft.dosageType === "hold" && (
        <ExactRangeDurationGroup
          legend="Hold duration"
          mode={draft.holdDurationMode ?? null}
          exactSeconds={draft.holdDurationExactSeconds ?? null}
          minSeconds={draft.holdDurationMinSeconds ?? null}
          maxSeconds={draft.holdDurationMaxSeconds ?? null}
          onChange={(patchFields) =>
            patch({
              holdDurationMode: patchFields.mode,
              holdDurationExactSeconds: patchFields.exact,
              holdDurationMinSeconds: patchFields.min,
              holdDurationMaxSeconds: patchFields.max,
            })
          }
          error={showErrors ? errorFor(errors, "holdDurationMode", "holdDurationExact", "holdDurationRange") : undefined}
        />
      )}

      {draft.dosageType === "distance" && (
        <div className="space-y-2">
          <ExactRangeDecimalGroup
            legend="Distance"
            mode={draft.distanceMode ?? null}
            exact={draft.distanceExactValue ?? null}
            min={draft.distanceMinValue ?? null}
            max={draft.distanceMaxValue ?? null}
            onChange={(patchFields) =>
              patch({
                distanceMode: patchFields.mode,
                distanceExactValue: patchFields.exact,
                distanceMinValue: patchFields.min,
                distanceMaxValue: patchFields.max,
              })
            }
            error={showErrors ? errorFor(errors, "distanceMode", "distanceExact", "distanceRange") : undefined}
          />
          <Field label="Unit" error={showErrors ? errorFor(errors, "distanceUnit") : undefined} htmlFor="distance-unit">
            <select
              id="distance-unit"
              value={draft.distanceUnit ?? ""}
              onChange={(e) => patch({ distanceUnit: (e.target.value || null) as DistanceUnit | null })}
              className="w-28 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="" disabled>
                Select…
              </option>
              {DISTANCE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}

      {draft.dosageType === "time" && (
        <div className="space-y-3">
          <Field label="Total duration (optional)" error={showErrors ? errorFor(errors, "timeDurationMode", "timeDurationExact", "timeDurationRange") : undefined}>
            <ModeToggle
              value={draft.timeDurationMode ?? null}
              onChange={(mode) =>
                patch({
                  timeDurationMode: mode,
                  timeDurationExactSeconds: mode === "exact" ? draft.timeDurationExactSeconds : null,
                  timeDurationMinSeconds: mode === "range" ? draft.timeDurationMinSeconds : null,
                  timeDurationMaxSeconds: mode === "range" ? draft.timeDurationMaxSeconds : null,
                })
              }
              allowNone
            />
            {draft.timeDurationMode === "exact" && (
              <DurationInput label="Duration" seconds={draft.timeDurationExactSeconds ?? null} onChange={(s) => patch({ timeDurationExactSeconds: s })} hideLabel />
            )}
            {draft.timeDurationMode === "range" && (
              <div className="flex items-center gap-2">
                <DurationInput label="Min" seconds={draft.timeDurationMinSeconds ?? null} onChange={(s) => patch({ timeDurationMinSeconds: s })} />
                <span className="text-gray-400">–</span>
                <DurationInput label="Max" seconds={draft.timeDurationMaxSeconds ?? null} onChange={(s) => patch({ timeDurationMaxSeconds: s })} />
              </div>
            )}
          </Field>

          <Field label="Work interval (optional)" error={showErrors ? errorFor(errors, "intervalWorkSeconds") : undefined}>
            <DurationInput label="Work" seconds={draft.intervalWorkSeconds ?? null} onChange={(s) => patch({ intervalWorkSeconds: s })} hideLabel />
          </Field>
          <Field label="Recovery interval (optional)" error={showErrors ? errorFor(errors, "intervalRecoverySeconds") : undefined}>
            <DurationInput label="Recovery" seconds={draft.intervalRecoverySeconds ?? null} onChange={(s) => patch({ intervalRecoverySeconds: s })} hideLabel />
          </Field>
          <Field label="Rounds (optional)" error={showErrors ? errorFor(errors, "intervalRounds") : undefined} htmlFor="interval-rounds">
            <input
              id="interval-rounds"
              type="number"
              min={1}
              step={1}
              value={draft.intervalRounds ?? ""}
              onChange={(e) => patch({ intervalRounds: e.target.value === "" ? null : Number(e.target.value) })}
              className="w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </Field>
        </div>
      )}

      {draft.dosageType && (
        <>
          {/* Core authoring, always visible (founder UX correction §1/§3) */}
          <LoadFields draft={draft} onChange={patch} error={showErrors ? errorFor(errors, "loadValueExact", "loadUnit") : undefined} />

          <Field label="Rest (optional)">
            <DurationInput label="Rest" seconds={draft.restSeconds ?? null} onChange={(s) => patch({ restSeconds: s })} hideLabel />
          </Field>

          <div>
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              aria-expanded={moreOpen}
              aria-controls="dosage-more-options"
              className="flex items-center gap-1 text-sm font-medium text-brand-600 hover:text-brand-700"
            >
              <span aria-hidden="true">{moreOpen ? "▾" : "▸"}</span>
              More options
            </button>

            {moreOpen && (
              <div id="dosage-more-options" className="mt-3 pt-3 border-t border-gray-100 space-y-4">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-gray-700">Tempo (optional)</p>
                  <div className="flex flex-wrap gap-3">
                    <DurationInput label="Up / concentric" seconds={draft.concentricDurationSeconds ?? null} onChange={(s) => patch({ concentricDurationSeconds: s })} compact />
                    <DurationInput label="Hold" seconds={draft.repHoldDurationSeconds ?? null} onChange={(s) => patch({ repHoldDurationSeconds: s })} compact />
                    <DurationInput label="Lowering / eccentric" seconds={draft.eccentricDurationSeconds ?? null} onChange={(s) => patch({ eccentricDurationSeconds: s })} compact />
                  </div>
                  <Field label="Tempo description" htmlFor="tempo-description">
                    <input
                      id="tempo-description"
                      type="text"
                      placeholder="e.g. Fast but controlled"
                      value={draft.tempoDescription ?? ""}
                      onChange={(e) => patch({ tempoDescription: e.target.value || null })}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                  </Field>
                </div>

                <RpeRirFields draft={draft} onChange={patch} error={showErrors ? errorFor(errors, "rpeRir", "rpe", "rir") : undefined} />

                <Field label="ROM (optional)" htmlFor="dosage-rom">
                  <input
                    id="dosage-rom"
                    type="text"
                    placeholder="e.g. Full range, pain-free only"
                    value={draft.rom ?? ""}
                    onChange={(e) => patch({ rom: e.target.value || null })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </Field>

                <Field label="Assistance (optional)" htmlFor="dosage-assistance">
                  <select
                    id="dosage-assistance"
                    value={draft.assistanceLevel ?? ""}
                    onChange={(e) => patch({ assistanceLevel: (e.target.value || null) as AssistanceLevel | null })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  >
                    <option value="">None</option>
                    {ASSISTANCE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Side (optional)" htmlFor="dosage-side">
                  <select
                    id="dosage-side"
                    value={draft.side ?? ""}
                    onChange={(e) => patch({ side: (e.target.value || null) as Side | null })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  >
                    <option value="">None</option>
                    {SIDE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Patient-specific instructions (optional)" htmlFor="dosage-instructions">
                  <textarea
                    id="dosage-instructions"
                    rows={2}
                    placeholder="e.g. Use countertop support if needed."
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </Field>
              </div>
            )}
          </div>
        </>
      )}

      {saveError && <p className="text-sm text-red-600">{saveError}</p>}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          Save dosage
        </button>
        <button onClick={onCancel} disabled={saving} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
          Cancel
        </button>
      </div>
    </div>
  );
}

function Field({ label, htmlFor, error, children }: { label: string; htmlFor?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-700">
        {label}
      </label>
      {children}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

function ModeToggle({ value, onChange, allowNone }: { value: DosageMode | null; onChange: (mode: DosageMode | null) => void; allowNone?: boolean }) {
  return (
    <div role="group" aria-label="Exact or range" className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-sm">
      {allowNone && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className={value === null ? "px-3 py-1.5 bg-brand-600 text-white" : "px-3 py-1.5 bg-white text-gray-600 hover:bg-gray-50"}
        >
          None
        </button>
      )}
      <button
        type="button"
        onClick={() => onChange("exact")}
        className={value === "exact" ? "px-3 py-1.5 bg-brand-600 text-white" : "px-3 py-1.5 bg-white text-gray-600 hover:bg-gray-50"}
      >
        Exact
      </button>
      <button
        type="button"
        onClick={() => onChange("range")}
        className={value === "range" ? "px-3 py-1.5 bg-brand-600 text-white" : "px-3 py-1.5 bg-white text-gray-600 hover:bg-gray-50"}
      >
        Range
      </button>
    </div>
  );
}

function ExactRangeIntGroup({
  legend,
  unitLabel,
  mode,
  exact,
  min,
  max,
  onChange,
  error,
}: {
  legend: string;
  unitLabel: string;
  mode: DosageMode | null;
  exact: number | null;
  min: number | null;
  max: number | null;
  onChange: (v: { mode: DosageMode | null; exact: number | null; min: number | null; max: number | null }) => void;
  error?: string;
}) {
  return (
    <Field label={legend} error={error}>
      <div className="space-y-2">
        <ModeToggle value={mode} onChange={(m) => onChange({ mode: m, exact: m === "exact" ? exact : null, min: m === "range" ? min : null, max: m === "range" ? max : null })} />
        {mode === "exact" && (
          <input
            type="number"
            min={1}
            step={1}
            aria-label={`Exact ${unitLabel}`}
            value={exact ?? ""}
            onChange={(e) => onChange({ mode, exact: e.target.value === "" ? null : Number(e.target.value), min: null, max: null })}
            className="w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        )}
        {mode === "range" && (
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              step={1}
              aria-label={`Minimum ${unitLabel}`}
              value={min ?? ""}
              onChange={(e) => onChange({ mode, exact: null, min: e.target.value === "" ? null : Number(e.target.value), max })}
              className="w-20 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <span className="text-gray-400">–</span>
            <input
              type="number"
              min={1}
              step={1}
              aria-label={`Maximum ${unitLabel}`}
              value={max ?? ""}
              onChange={(e) => onChange({ mode, exact: null, min, max: e.target.value === "" ? null : Number(e.target.value) })}
              className="w-20 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        )}
      </div>
    </Field>
  );
}

function ExactRangeDecimalGroup({
  legend,
  mode,
  exact,
  min,
  max,
  onChange,
  error,
}: {
  legend: string;
  mode: DosageMode | null;
  exact: number | null;
  min: number | null;
  max: number | null;
  onChange: (v: { mode: DosageMode | null; exact: number | null; min: number | null; max: number | null }) => void;
  error?: string;
}) {
  return (
    <Field label={legend} error={error}>
      <div className="space-y-2">
        <ModeToggle value={mode} onChange={(m) => onChange({ mode: m, exact: m === "exact" ? exact : null, min: m === "range" ? min : null, max: m === "range" ? max : null })} />
        {mode === "exact" && (
          <input
            type="number"
            min={0}
            step="any"
            aria-label="Exact distance"
            value={exact ?? ""}
            onChange={(e) => onChange({ mode, exact: e.target.value === "" ? null : Number(e.target.value), min: null, max: null })}
            className="w-28 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        )}
        {mode === "range" && (
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              step="any"
              aria-label="Minimum distance"
              value={min ?? ""}
              onChange={(e) => onChange({ mode, exact: null, min: e.target.value === "" ? null : Number(e.target.value), max })}
              className="w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <span className="text-gray-400">–</span>
            <input
              type="number"
              min={0}
              step="any"
              aria-label="Maximum distance"
              value={max ?? ""}
              onChange={(e) => onChange({ mode, exact: null, min, max: e.target.value === "" ? null : Number(e.target.value) })}
              className="w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        )}
      </div>
    </Field>
  );
}

function ExactRangeDurationGroup({
  legend,
  mode,
  exactSeconds,
  minSeconds,
  maxSeconds,
  onChange,
  error,
}: {
  legend: string;
  mode: DosageMode | null;
  exactSeconds: number | null;
  minSeconds: number | null;
  maxSeconds: number | null;
  onChange: (v: { mode: DosageMode | null; exact: number | null; min: number | null; max: number | null }) => void;
  error?: string;
}) {
  return (
    <Field label={legend} error={error}>
      <div className="space-y-2">
        <ModeToggle
          value={mode}
          onChange={(m) => onChange({ mode: m, exact: m === "exact" ? exactSeconds : null, min: m === "range" ? minSeconds : null, max: m === "range" ? maxSeconds : null })}
        />
        {mode === "exact" && (
          <DurationInput label="Duration" seconds={exactSeconds} onChange={(s) => onChange({ mode, exact: s, min: null, max: null })} hideLabel />
        )}
        {mode === "range" && (
          <div className="flex items-center gap-2">
            <DurationInput label="Min" seconds={minSeconds} onChange={(s) => onChange({ mode, exact: null, min: s, max: maxSeconds })} />
            <span className="text-gray-400">–</span>
            <DurationInput label="Max" seconds={maxSeconds} onChange={(s) => onChange({ mode, exact: null, min: minSeconds, max: s })} />
          </div>
        )}
      </div>
    </Field>
  );
}

// Minutes + seconds pair, losslessly composed to/from total seconds
// (C5.4B §7) — the clinician never has to convert minutes to seconds
// mentally, and never has to enter an unlabeled raw seconds count either.
//
// `hideLabel` (founder UX correction): the enclosing Field already names
// this input via its own <label> (e.g. "Rest (optional)") in every
// single-purpose call site (Duration/Rest/Work/Recovery), so repeating that
// same word directly beneath the min/sec inputs was pure visual noise,
// worst on mobile. The label is NOT removed for accessibility — it stays on
// `aria-label` for every input regardless of `hideLabel` — and is kept
// VISIBLE for the two-input Min/Max pairs and the three side-by-side
// `compact` tempo fields, where it is the only thing distinguishing which
// field is which.
function DurationInput({
  label,
  seconds,
  onChange,
  compact,
  hideLabel,
}: {
  label: string;
  seconds: number | null;
  onChange: (seconds: number | null) => void;
  compact?: boolean;
  hideLabel?: boolean;
}) {
  const { min, sec } = secondsToMinSec(seconds);
  return (
    <div className={compact ? "flex flex-col gap-1" : "flex items-end gap-1.5"}>
      {compact && <span className="text-xs text-gray-500">{label}</span>}
      <div className="flex items-center gap-1">
        <input
          type="number"
          min={0}
          step={1}
          aria-label={`${label} minutes`}
          value={min ?? ""}
          onChange={(e) => onChange(minSecToSeconds(e.target.value === "" ? null : Number(e.target.value), sec))}
          className="w-14 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
        />
        <span className="text-xs text-gray-400">min</span>
        <input
          type="number"
          min={0}
          max={59}
          step={1}
          aria-label={`${label} seconds`}
          value={sec ?? ""}
          onChange={(e) => onChange(minSecToSeconds(min, e.target.value === "" ? null : Number(e.target.value)))}
          className="w-14 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
        />
        <span className="text-xs text-gray-400">sec</span>
      </div>
      {!compact && !hideLabel && <span className="text-xs text-gray-400 mb-1.5">{label}</span>}
    </div>
  );
}

function LoadFields({ draft, onChange, error }: { draft: DosageDraft; onChange: (fields: Partial<DosageDraft>) => void; error?: string }) {
  const loadType = draft.loadType ?? "not_applicable";
  return (
    <Field label="Load" error={error} htmlFor="dosage-load-type">
      <div className="space-y-2">
        <select
          id="dosage-load-type"
          value={loadType}
          onChange={(e) => {
            const next = e.target.value as LoadType;
            onChange(next === "external" ? { loadType: next } : { loadType: next, loadValueExact: null, loadUnit: null });
          }}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="not_applicable">Not applicable</option>
          <option value="bodyweight">Bodyweight</option>
          <option value="external">External Load</option>
          <option value="assisted">Assisted</option>
        </select>
        {loadType === "external" && (
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              step="any"
              aria-label="Load value"
              value={draft.loadValueExact ?? ""}
              onChange={(e) => onChange({ loadValueExact: e.target.value === "" ? null : Number(e.target.value) })}
              className="w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <select
              aria-label="Load unit"
              value={draft.loadUnit ?? ""}
              onChange={(e) => onChange({ loadUnit: (e.target.value || null) as LoadUnit | null })}
              className="w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="" disabled>
                Unit…
              </option>
              <option value="kg">kg</option>
              <option value="lb">lb</option>
            </select>
          </div>
        )}
        {formatLoadLabel(draft) && <p className="text-xs text-gray-400">Preview: {formatLoadLabel(draft)}</p>}
      </div>
    </Field>
  );
}

// RPE and RIR are mutually exclusive at the UI level (C5.4B §11) — choosing
// one clears the other; the DB schema itself does not forbid both, this
// rule exists only here and in validateDosageInput().
// Local `selected` state is deliberately DECOUPLED from "is a value
// present" — clicking "RPE" must reveal an EMPTY input for the clinician to
// fill in themselves (C5.4B §11 — "Do not invent defaults"), not silently
// write a starting number into draft.rpe.
function RpeRirFields({ draft, onChange, error }: { draft: DosageDraft; onChange: (fields: Partial<DosageDraft>) => void; error?: string }) {
  const [selected, setSelected] = useState<"none" | "rpe" | "rir">(draft.rpe != null ? "rpe" : draft.rir != null ? "rir" : "none");

  function select(next: "none" | "rpe" | "rir") {
    setSelected(next);
    onChange({ rpe: next === "rpe" ? draft.rpe : null, rir: next === "rir" ? draft.rir : null });
  }

  return (
    <Field label="RPE / RIR (optional)" error={error}>
      <div className="space-y-2">
        <div role="group" aria-label="RPE or RIR" className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-sm">
          <button type="button" onClick={() => select("none")} className={selected === "none" ? "px-3 py-1.5 bg-brand-600 text-white" : "px-3 py-1.5 bg-white text-gray-600 hover:bg-gray-50"}>
            None
          </button>
          <button type="button" onClick={() => select("rpe")} className={selected === "rpe" ? "px-3 py-1.5 bg-brand-600 text-white" : "px-3 py-1.5 bg-white text-gray-600 hover:bg-gray-50"}>
            RPE
          </button>
          <button type="button" onClick={() => select("rir")} className={selected === "rir" ? "px-3 py-1.5 bg-brand-600 text-white" : "px-3 py-1.5 bg-white text-gray-600 hover:bg-gray-50"}>
            RIR
          </button>
        </div>
        {selected === "rpe" && (
          <input
            type="number"
            min={0}
            max={10}
            step={0.5}
            aria-label="RPE value"
            value={draft.rpe ?? ""}
            onChange={(e) => onChange({ rpe: e.target.value === "" ? null : Number(e.target.value) })}
            className="w-20 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        )}
        {selected === "rir" && (
          <input
            type="number"
            min={0}
            max={10}
            step={1}
            aria-label="RIR value"
            value={draft.rir ?? ""}
            onChange={(e) => onChange({ rir: e.target.value === "" ? null : Number(e.target.value) })}
            className="w-20 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        )}
      </div>
    </Field>
  );
}
