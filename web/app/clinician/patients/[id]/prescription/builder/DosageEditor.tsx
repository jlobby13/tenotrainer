"use client";

// C5.4 Revision B — Exercise Dosage Authoring editor. Rewritten from the
// C5.4B type-first vertical form into a compact, parameter-based inline
// editor: the clinician never chooses a "Dosage Type" — they see Sets plus
// the specialized dimensions this canonical exercise's curated capabilities
// make applicable (plus Load/Rest, always available), and dosage_type is
// derived deterministically at Save (deriveDosageType() in dosageEditor.ts).
//
// C5.4 Revision E — the "+ Add parameter" interaction is removed. Every
// dimension in the exercise's curated ALLOWED set (default ⊆ allowed) is
// now shown directly, so nothing that was previously reachable through Add
// parameter becomes unreachable; the capability metadata itself is
// unchanged. A dimension outside the allowed set still appears whenever it
// already carries data (historical/off-capability values are never hidden),
// labelled the same way Revision D labels off-capability optional fields.
//
// draft/instructions are now PROPS, not local useState — BuilderShell owns
// the actual working-state map (keyed by prescriptionExerciseId) so this
// component can safely unmount/remount (switching workouts, or simply not
// being the currently-expanded row) without losing anything the clinician
// typed. This component only owns one purely-presentational piece of local
// state: `moreOpen` (progressive disclosure) — it holds no authored VALUES,
// so a remount resetting it is not a data-loss concern. Whether validation
// errors are shown is owned by BuilderShell too, so a failed Save All can
// surface them on an editor that was never clicked directly.

import { useMemo, useState } from "react";
import {
  validateDosageInput,
  formatLoadLabel,
  secondsToMinSec,
  minSecToSeconds,
  hasAdvancedDosageValues,
  isCapabilityPopulated,
  resolveOptionalFieldVisibility,
  CAPABILITY_DISPLAY_ORDER,
  CAPABILITY_LABELS,
  type DosageDraft,
  type DosageValidationError,
} from "@/lib/dosageEditor";
import { formatReferenceDosageSummary, type ReferenceDosageLike } from "@/lib/canonicalExerciseLibrary";
import type { DosageMode, LoadType, LoadUnit, LoadMode, AssistanceLevel, Side, DistanceUnit, DosageCapability, OptionalFieldCapability } from "@/lib/prescriptionDraftTypes";

type Props = {
  draft: DosageDraft;
  instructions: string;
  savedDraft: DosageDraft;
  // C5.4 Revision B focused correction — DEFAULT is distinct from ALLOWED;
  // default is always a subset of allowed (DB-enforced). See the
  // 20261001000001 migration header. Since Revision E both are shown.
  defaultCapabilities: DosageCapability[];
  allowedCapabilities: DosageCapability[];
  // C5.4 Revision D — optional "More options" modifiers applicable to this
  // exercise (canonical_exercises.optional_field_capabilities). Separate
  // from the specialized dimensions above; never gates saved values.
  optionalFieldCapabilities: OptionalFieldCapability[];
  referenceDosage: ReferenceDosageLike | null;
  isDirty: boolean;
  saving: boolean;
  saveError: string | null;
  showErrors: boolean;
  onDraftChange: (patch: Partial<DosageDraft>) => void;
  onInstructionsChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
};

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

export function DosageEditor({
  draft,
  instructions,
  savedDraft,
  defaultCapabilities,
  allowedCapabilities,
  optionalFieldCapabilities,
  referenceDosage,
  isDirty,
  saving,
  saveError,
  showErrors,
  onDraftChange,
  onInstructionsChange,
  onSave,
  onCancel,
}: Props) {
  // Founder UX correction, unchanged from C5.4B — computed ONCE at mount
  // from whatever the draft/instructions were AT THAT MOMENT, never
  // re-evaluated on every keystroke, so collapsing it while editing is
  // never fought and a server refresh never forces it back open.
  const [moreOpen, setMoreOpen] = useState<boolean>(() => hasAdvancedDosageValues(savedDraft, savedDraft ? instructions : null));

  const errors = useMemo(() => validateDosageInput(draft), [draft]);

  function patch(fields: Partial<DosageDraft>) {
    onDraftChange(fields);
  }

  // A specialized dimension is VISIBLE if it is in this exercise's curated
  // DEFAULT or ALLOWED set (Revision E: no Add parameter step), OR the
  // working/saved dosage already carries data for it (so a historical or
  // otherwise off-ALLOWED-set row still opens with its value — the allowed
  // set never hides existing saved clinical truth). A dimension outside the
  // allowed set (e.g. Distance on an isometric calf hold) is otherwise
  // never offered.
  const isApplicableCapability = (cap: DosageCapability) => defaultCapabilities.includes(cap) || allowedCapabilities.includes(cap);
  const visibleCapabilities = CAPABILITY_DISPLAY_ORDER.filter(
    (cap) => isApplicableCapability(cap) || isCapabilityPopulated(draft, cap) || isCapabilityPopulated(savedDraft, cap)
  );

  // C5.4 Revision D — optional modifiers follow the same rule: offered when
  // applicable to this exercise, and also shown whenever the working or
  // saved dosage already carries a value (historical/off-capability data is
  // never hidden or silently dropped).
  const optionalFields = resolveOptionalFieldVisibility(optionalFieldCapabilities, draft, savedDraft);
  const showOptional = (field: OptionalFieldCapability) => optionalFields.visible.includes(field);
  const isOffCapability = (field: OptionalFieldCapability) => optionalFields.offCapability.includes(field);
  const hasGridFields = (["rpe", "rir", "rom", "assistance", "side"] as const).some(showOptional);


  return (
    <div className="mt-3 border-t border-gray-100 pt-3 space-y-3" data-testid="dosage-editor">
      {referenceDosage && (
        <div className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2 text-xs text-gray-600 space-y-0.5">
          <div className="font-semibold text-gray-500 uppercase tracking-wide text-[10px]">Reference dosage</div>
          <p>{formatReferenceDosageSummary(referenceDosage)}</p>
          <p className="text-gray-400 italic">Informational only — does not populate this patient&apos;s prescription.</p>
        </div>
      )}

      <div className="flex flex-wrap items-start gap-3" data-testid="dosage-compact-fields">
        <CompactField label="Sets">
          <input
            type="number"
            min={1}
            step={1}
            aria-label="Sets"
            data-testid="dosage-field-sets"
            value={draft.sets ?? ""}
            onChange={(e) => patch({ sets: e.target.value === "" ? null : Number(e.target.value) })}
            className="w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          />
        </CompactField>

        {visibleCapabilities.map((capability) => (
          <CapabilityCompactField
            key={capability}
            capability={capability}
            draft={draft}
            onChange={patch}
            offCapability={!isApplicableCapability(capability)}
            errors={errors}
            showErrors={showErrors}
          />
        ))}

        <div data-testid="dosage-field-load">
          <CompactLoadField draft={draft} onChange={patch} error={showErrors ? errorFor(errors, "loadValueExact", "loadValueRange", "loadUnit") : undefined} />
        </div>

        <div data-testid="dosage-field-rest">
          <CompactField label="Rest">
            <DurationInput label="Rest" seconds={draft.restSeconds ?? null} onChange={(s) => patch({ restSeconds: s })} hideLabel />
          </CompactField>
        </div>
      </div>

      {showErrors && errorFor(errors, "dosage") && <p className="text-xs text-red-600">{errorFor(errors, "dosage")}</p>}

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
          <div id="dosage-more-options" className="mt-3 pt-3 border-t border-gray-100 space-y-3" data-testid="dosage-more-options">
            {showOptional("tempo") && (
              <div className="flex flex-wrap items-end gap-3" data-testid="optional-field-tempo">
                <OptionalLabel label="Tempo" offCapability={isOffCapability("tempo")} className="basis-full" />
                <DurationInput label="Up / concentric" seconds={draft.concentricDurationSeconds ?? null} onChange={(s) => patch({ concentricDurationSeconds: s })} compact />
                <DurationInput label="Hold" seconds={draft.repHoldDurationSeconds ?? null} onChange={(s) => patch({ repHoldDurationSeconds: s })} compact />
                <DurationInput label="Lowering / eccentric" seconds={draft.eccentricDurationSeconds ?? null} onChange={(s) => patch({ eccentricDurationSeconds: s })} compact />
                <div className="flex flex-col gap-1 flex-1 min-w-[12rem]">
                  <label htmlFor="tempo-description" className="text-xs text-gray-500">
                    Tempo description
                  </label>
                  <input
                    id="tempo-description"
                    type="text"
                    placeholder="e.g. Fast but controlled"
                    value={draft.tempoDescription ?? ""}
                    onChange={(e) => patch({ tempoDescription: e.target.value || null })}
                    className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                  />
                </div>
              </div>
            )}

            {/* C5.4 Revision D — compact grid. auto-fill sizes columns from the
                editor's own width (4 across in the desktop draft panel, 2 at
                intermediate widths, 1 on a phone) rather than the viewport,
                and never squeezes a cell below a usable width. Not rendered
                at all when no grid field applies. */}
            {hasGridFields && (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-3 gap-y-2.5" data-testid="optional-field-grid">
                {(showOptional("rpe") || showOptional("rir")) && (
                  <RpeRirFields
                    draft={draft}
                    onChange={patch}
                    showRpe={showOptional("rpe")}
                    showRir={showOptional("rir")}
                    offCapability={(showOptional("rpe") && isOffCapability("rpe")) || (showOptional("rir") && isOffCapability("rir"))}
                    error={showErrors ? errorFor(errors, "rpeRir", "rpe", "rir") : undefined}
                  />
                )}

                {showOptional("rom") && (
                  <div className="flex flex-col gap-1 min-w-0" data-testid="optional-field-rom">
                    <OptionalLabel label="ROM" htmlFor="dosage-rom" offCapability={isOffCapability("rom")} />
                    <input
                      id="dosage-rom"
                      type="text"
                      placeholder="e.g. Pain-free range"
                      value={draft.rom ?? ""}
                      onChange={(e) => patch({ rom: e.target.value || null })}
                      className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                    />
                  </div>
                )}

                {showOptional("assistance") && (
                  <div className="flex flex-col gap-1 min-w-0" data-testid="optional-field-assistance">
                    <OptionalLabel label="Assistance" htmlFor="dosage-assistance" offCapability={isOffCapability("assistance")} />
                    <select
                      id="dosage-assistance"
                      value={draft.assistanceLevel ?? ""}
                      onChange={(e) => patch({ assistanceLevel: (e.target.value || null) as AssistanceLevel | null })}
                      className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                    >
                      <option value="">None</option>
                      {ASSISTANCE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {showOptional("side") && (
                  <div className="flex flex-col gap-1 min-w-0" data-testid="optional-field-side">
                    <OptionalLabel label="Side" htmlFor="dosage-side" offCapability={isOffCapability("side")} />
                    <select
                      id="dosage-side"
                      value={draft.side ?? ""}
                      onChange={(e) => patch({ side: (e.target.value || null) as Side | null })}
                      className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                    >
                      <option value="">None</option>
                      {SIDE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            {/* Always available for every exercise — full width, never a grid cell. */}
            <div className="flex flex-col gap-1" data-testid="optional-field-instructions">
              <label htmlFor="dosage-instructions" className="text-xs font-medium text-gray-500">
                Patient-specific instructions (optional)
              </label>
              <textarea
                id="dosage-instructions"
                rows={2}
                placeholder="e.g. Use countertop support if needed."
                value={instructions}
                onChange={(e) => onInstructionsChange(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
        )}
      </div>

      {saveError && (
        <p className="text-sm text-red-600" role="alert" data-testid="dosage-save-error">
          {saveError}
        </p>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={onSave}
          disabled={saving}
          data-testid="save-dosage"
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save dosage"}
        </button>
        <button onClick={onCancel} disabled={saving} data-testid="cancel-dosage" className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
          Cancel
        </button>
        {isDirty && (
          <span className="text-xs font-medium text-amber-700" data-testid="dosage-editor-unsaved">
            Unsaved changes
          </span>
        )}
      </div>
    </div>
  );
}

// A small labeled compact slot — NOT the old full-width `Field` block (which
// forces its own vertical line + full-width children); this is what lets
// Sets/Reps/Hold/Load/Rest actually sit on one flex-wrap row.
function CompactField({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-gray-500">{label}</span>
      {children}
      {error && <p className="text-xs text-red-600 max-w-[10rem]">{error}</p>}
    </div>
  );
}

// Compact exact/range toggle — two small buttons, no block label of its
// own (the enclosing CompactField already supplies one).
//
// C5.4 Revision B decision #22 — capability means available/applicable,
// never required: a clinician must be able to clear a capability-DEFAULT
// dimension's value back to "not populated" even though that dimension
// itself isn't removable from view. Re-clicking the already-active mode button clears it
// (onChange(null), which every call site already routes into nulling out
// that dimension's exact/min/max fields) — this is the "blank it out"
// affordance for a permanent field.
function CompactModeToggle({ value, onChange }: { value: DosageMode | null; onChange: (mode: DosageMode | null) => void }) {
  return (
    <div role="group" aria-label="Exact or range" className="inline-flex rounded-md border border-gray-300 overflow-hidden text-[11px]">
      <button
        type="button"
        onClick={() => onChange(value === "exact" ? null : "exact")}
        className={value === "exact" ? "px-1.5 py-0.5 bg-brand-600 text-white" : "px-1.5 py-0.5 bg-white text-gray-500 hover:bg-gray-50"}
      >
        Exact
      </button>
      <button
        type="button"
        onClick={() => onChange(value === "range" ? null : "range")}
        className={value === "range" ? "px-1.5 py-0.5 bg-brand-600 text-white" : "px-1.5 py-0.5 bg-white text-gray-500 hover:bg-gray-50"}
      >
        Range
      </button>
    </div>
  );
}

// A specialized dimension shown only because it already carries data (it is
// outside this exercise's curated allowed set) gets the same marker Revision
// D uses for off-capability optional fields.
function CapabilityLabel({ label, offCapability }: { label: string; offCapability: boolean }) {
  return (
    <span className="text-xs font-medium text-gray-500 flex flex-wrap items-center gap-x-1.5">
      {label}
      {offCapability && (
        <span className="text-[10px] font-normal text-amber-700" data-testid="capability-off-allowed" title="Not a standard parameter for this exercise — shown because a value is saved.">
          (saved value · not standard here)
        </span>
      )}
    </span>
  );
}

function CapabilityCompactField({
  capability,
  draft,
  onChange,
  offCapability,
  errors,
  showErrors,
}: {
  capability: DosageCapability;
  draft: DosageDraft;
  onChange: (fields: Partial<DosageDraft>) => void;
  offCapability: boolean;
  errors: DosageValidationError[];
  showErrors: boolean;
}) {
  const label = CAPABILITY_LABELS[capability];
  switch (capability) {
    case "reps":
      return (
        <div className="flex flex-col gap-1" data-testid="dosage-field-reps">
          <CapabilityLabel label={label} offCapability={offCapability} />
          <CompactExactRangeInt
            unitLabel="reps"
            mode={draft.repsMode ?? null}
            exact={draft.repsExact ?? null}
            min={draft.repsMin ?? null}
            max={draft.repsMax ?? null}
            onChange={(v) => onChange({ repsMode: v.mode, repsExact: v.exact, repsMin: v.min, repsMax: v.max })}
          />
          {showErrors && errorFor(errors, "repsMode", "repsExact", "repsRange") && <p className="text-xs text-red-600 max-w-[9rem]">{errorFor(errors, "repsMode", "repsExact", "repsRange")}</p>}
        </div>
      );
    case "hold":
      return (
        <div className="flex flex-col gap-1" data-testid="dosage-field-hold">
          <CapabilityLabel label={label} offCapability={offCapability} />
          <CompactExactRangeDuration
            label="Hold"
            mode={draft.holdDurationMode ?? null}
            exactSeconds={draft.holdDurationExactSeconds ?? null}
            minSeconds={draft.holdDurationMinSeconds ?? null}
            maxSeconds={draft.holdDurationMaxSeconds ?? null}
            onChange={(v) => onChange({ holdDurationMode: v.mode, holdDurationExactSeconds: v.exact, holdDurationMinSeconds: v.min, holdDurationMaxSeconds: v.max })}
          />
          {showErrors && errorFor(errors, "holdDurationMode", "holdDurationExact", "holdDurationRange") && (
            <p className="text-xs text-red-600 max-w-[9rem]">{errorFor(errors, "holdDurationMode", "holdDurationExact", "holdDurationRange")}</p>
          )}
        </div>
      );
    case "contacts":
      return (
        <div className="flex flex-col gap-1" data-testid="dosage-field-contacts">
          <CapabilityLabel label={label} offCapability={offCapability} />
          <CompactExactRangeInt
            unitLabel="contacts"
            mode={draft.contactsMode ?? null}
            exact={draft.contactsExact ?? null}
            min={draft.contactsMin ?? null}
            max={draft.contactsMax ?? null}
            onChange={(v) => onChange({ contactsMode: v.mode, contactsExact: v.exact, contactsMin: v.min, contactsMax: v.max })}
          />
          {showErrors && errorFor(errors, "contactsMode", "contactsExact", "contactsRange") && (
            <p className="text-xs text-red-600 max-w-[9rem]">{errorFor(errors, "contactsMode", "contactsExact", "contactsRange")}</p>
          )}
        </div>
      );
    case "distance":
      return (
        <div className="flex flex-col gap-1" data-testid="dosage-field-distance">
          <CapabilityLabel label={label} offCapability={offCapability} />
          <div className="flex items-center gap-1.5">
            <CompactExactRangeDecimal
              mode={draft.distanceMode ?? null}
              exact={draft.distanceExactValue ?? null}
              min={draft.distanceMinValue ?? null}
              max={draft.distanceMaxValue ?? null}
              onChange={(v) => onChange({ distanceMode: v.mode, distanceExactValue: v.exact, distanceMinValue: v.min, distanceMaxValue: v.max })}
            />
            <select
              aria-label="Distance unit"
              id="distance-unit"
              value={draft.distanceUnit ?? ""}
              onChange={(e) => onChange({ distanceUnit: (e.target.value || null) as DistanceUnit | null })}
              className="rounded-lg border border-gray-300 px-1.5 py-1.5 text-sm w-16"
            >
              <option value="" disabled>
                Unit…
              </option>
              {DISTANCE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
          {showErrors && errorFor(errors, "distanceMode", "distanceExact", "distanceRange", "distanceUnit") && (
            <p className="text-xs text-red-600 max-w-[11rem]">{errorFor(errors, "distanceMode", "distanceExact", "distanceRange", "distanceUnit")}</p>
          )}
        </div>
      );
    case "interval_time":
      return (
        <div className="flex flex-col gap-1 rounded-lg border border-gray-200 p-2" data-testid="dosage-field-interval-time">
          <CapabilityLabel label={label} offCapability={offCapability} />
          <div className="flex flex-wrap items-end gap-2">
            <CompactField label="Duration">
              <div className="flex items-center gap-1">
                <CompactModeToggle
                  value={draft.timeDurationMode ?? null}
                  onChange={(mode) =>
                    onChange({
                      timeDurationMode: mode,
                      timeDurationExactSeconds: mode === "exact" ? draft.timeDurationExactSeconds : null,
                      timeDurationMinSeconds: mode === "range" ? draft.timeDurationMinSeconds : null,
                      timeDurationMaxSeconds: mode === "range" ? draft.timeDurationMaxSeconds : null,
                    })
                  }
                />
                {draft.timeDurationMode === "exact" && (
                  <DurationInput label="Duration" seconds={draft.timeDurationExactSeconds ?? null} onChange={(s) => onChange({ timeDurationExactSeconds: s })} hideLabel />
                )}
                {draft.timeDurationMode === "range" && (
                  <div className="flex items-center gap-1">
                    <DurationInput label="Min duration" seconds={draft.timeDurationMinSeconds ?? null} onChange={(s) => onChange({ timeDurationMinSeconds: s })} compact />
                    <span className="text-gray-400">–</span>
                    <DurationInput label="Max duration" seconds={draft.timeDurationMaxSeconds ?? null} onChange={(s) => onChange({ timeDurationMaxSeconds: s })} compact />
                  </div>
                )}
              </div>
            </CompactField>
            <CompactField label="Work">
              <DurationInput label="Work" seconds={draft.intervalWorkSeconds ?? null} onChange={(s) => onChange({ intervalWorkSeconds: s })} hideLabel />
            </CompactField>
            <CompactField label="Recovery">
              <DurationInput label="Recovery" seconds={draft.intervalRecoverySeconds ?? null} onChange={(s) => onChange({ intervalRecoverySeconds: s })} hideLabel />
            </CompactField>
            <CompactField label="Rounds">
              <input
                type="number"
                min={1}
                step={1}
                aria-label="Rounds"
                value={draft.intervalRounds ?? ""}
                onChange={(e) => onChange({ intervalRounds: e.target.value === "" ? null : Number(e.target.value) })}
                className="w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
              />
            </CompactField>
          </div>
          {showErrors && errorFor(errors, "timeDurationMode", "timeDurationExact", "timeDurationRange", "intervalWorkSeconds", "intervalRecoverySeconds", "intervalRounds") && (
            <p className="text-xs text-red-600">{errorFor(errors, "timeDurationMode", "timeDurationExact", "timeDurationRange", "intervalWorkSeconds", "intervalRecoverySeconds", "intervalRounds")}</p>
          )}
        </div>
      );
  }
}

function CompactExactRangeInt({
  unitLabel,
  mode,
  exact,
  min,
  max,
  onChange,
}: {
  unitLabel: string;
  mode: DosageMode | null;
  exact: number | null;
  min: number | null;
  max: number | null;
  onChange: (v: { mode: DosageMode | null; exact: number | null; min: number | null; max: number | null }) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <CompactModeToggle value={mode} onChange={(m) => onChange({ mode: m, exact: m === "exact" ? exact : null, min: m === "range" ? min : null, max: m === "range" ? max : null })} />
      {mode === "exact" && (
        <input
          type="number"
          min={1}
          step={1}
          aria-label={`Exact ${unitLabel}`}
          value={exact ?? ""}
          onChange={(e) => onChange({ mode, exact: e.target.value === "" ? null : Number(e.target.value), min: null, max: null })}
          className="w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
        />
      )}
      {mode === "range" && (
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={1}
            step={1}
            aria-label={`Minimum ${unitLabel}`}
            value={min ?? ""}
            onChange={(e) => onChange({ mode, exact: null, min: e.target.value === "" ? null : Number(e.target.value), max })}
            className="w-14 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          />
          <span className="text-gray-400">–</span>
          <input
            type="number"
            min={1}
            step={1}
            aria-label={`Maximum ${unitLabel}`}
            value={max ?? ""}
            onChange={(e) => onChange({ mode, exact: null, min, max: e.target.value === "" ? null : Number(e.target.value) })}
            className="w-14 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>
      )}
    </div>
  );
}

function CompactExactRangeDecimal({
  mode,
  exact,
  min,
  max,
  onChange,
}: {
  mode: DosageMode | null;
  exact: number | null;
  min: number | null;
  max: number | null;
  onChange: (v: { mode: DosageMode | null; exact: number | null; min: number | null; max: number | null }) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <CompactModeToggle value={mode} onChange={(m) => onChange({ mode: m, exact: m === "exact" ? exact : null, min: m === "range" ? min : null, max: m === "range" ? max : null })} />
      {mode === "exact" && (
        <input
          type="number"
          min={0}
          step="any"
          aria-label="Exact distance"
          value={exact ?? ""}
          onChange={(e) => onChange({ mode, exact: e.target.value === "" ? null : Number(e.target.value), min: null, max: null })}
          className="w-20 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
        />
      )}
      {mode === "range" && (
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={0}
            step="any"
            aria-label="Minimum distance"
            value={min ?? ""}
            onChange={(e) => onChange({ mode, exact: null, min: e.target.value === "" ? null : Number(e.target.value), max })}
            className="w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          />
          <span className="text-gray-400">–</span>
          <input
            type="number"
            min={0}
            step="any"
            aria-label="Maximum distance"
            value={max ?? ""}
            onChange={(e) => onChange({ mode, exact: null, min, max: e.target.value === "" ? null : Number(e.target.value) })}
            className="w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>
      )}
    </div>
  );
}

function CompactExactRangeDuration({
  label,
  mode,
  exactSeconds,
  minSeconds,
  maxSeconds,
  onChange,
}: {
  label: string;
  mode: DosageMode | null;
  exactSeconds: number | null;
  minSeconds: number | null;
  maxSeconds: number | null;
  onChange: (v: { mode: DosageMode | null; exact: number | null; min: number | null; max: number | null }) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <CompactModeToggle
        value={mode}
        onChange={(m) => onChange({ mode: m, exact: m === "exact" ? exactSeconds : null, min: m === "range" ? minSeconds : null, max: m === "range" ? maxSeconds : null })}
      />
      {mode === "exact" && <DurationInput label={label} seconds={exactSeconds} onChange={(s) => onChange({ mode, exact: s, min: null, max: null })} hideLabel />}
      {mode === "range" && (
        <div className="flex items-center gap-1">
          <DurationInput label={`Min ${label}`} seconds={minSeconds} onChange={(s) => onChange({ mode, exact: null, min: s, max: maxSeconds })} compact />
          <span className="text-gray-400">–</span>
          <DurationInput label={`Max ${label}`} seconds={maxSeconds} onChange={(s) => onChange({ mode, exact: null, min: minSeconds, max: s })} compact />
        </div>
      )}
    </div>
  );
}

function CompactLoadField({ draft, onChange, error }: { draft: DosageDraft; onChange: (fields: Partial<DosageDraft>) => void; error?: string }) {
  const loadType = draft.loadType ?? "not_applicable";
  // NULL loadMode is treated as "exact" — matches the DB shape constraint
  // added in Revision A (backward compatible with every pre-Revision-A row).
  const loadMode: LoadMode = draft.loadMode ?? "exact";
  return (
    <CompactField label="Load" error={error}>
      <div className="flex flex-col gap-1.5">
        <select
          aria-label="Load type"
          value={loadType}
          onChange={(e) => {
            const next = e.target.value as LoadType;
            onChange(next === "external" ? { loadType: next } : { loadType: next, loadMode: null, loadValueExact: null, loadValueMin: null, loadValueMax: null, loadUnit: null });
          }}
          className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm w-32"
        >
          <option value="not_applicable">Not applicable</option>
          <option value="bodyweight">Bodyweight</option>
          <option value="external">External Load</option>
          <option value="assisted">Assisted</option>
        </select>
        {loadType === "external" && (
          <div className="flex items-center gap-1.5">
            <CompactModeToggle
              value={loadMode}
              // Load's "clear" path is the Load Type select ("Not
              // applicable"), not this toggle — re-clicking the active
              // mode here is a no-op rather than nulling loadMode, since
              // loadMode falls back to "exact" for display (matching the
              // DB's NULL-is-exact backward-compat rule) and would
              // otherwise look confusingly "already active" on first use.
              onChange={(m) => {
                if (m === null) return;
                onChange({
                  loadMode: m,
                  loadValueExact: m === "exact" ? draft.loadValueExact : null,
                  loadValueMin: m === "range" ? draft.loadValueMin : null,
                  loadValueMax: m === "range" ? draft.loadValueMax : null,
                });
              }}
            />
            {loadMode === "exact" && (
              <input
                type="number"
                min={0}
                step="any"
                aria-label="Load value"
                value={draft.loadValueExact ?? ""}
                onChange={(e) => onChange({ loadValueExact: e.target.value === "" ? null : Number(e.target.value) })}
                className="w-20 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
              />
            )}
            {loadMode === "range" && (
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  step="any"
                  aria-label="Minimum load"
                  value={draft.loadValueMin ?? ""}
                  onChange={(e) => onChange({ loadValueMin: e.target.value === "" ? null : Number(e.target.value) })}
                  className="w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                />
                <span className="text-gray-400">–</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  aria-label="Maximum load"
                  value={draft.loadValueMax ?? ""}
                  onChange={(e) => onChange({ loadValueMax: e.target.value === "" ? null : Number(e.target.value) })}
                  className="w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                />
              </div>
            )}
            <select
              aria-label="Load unit"
              value={draft.loadUnit ?? ""}
              onChange={(e) => onChange({ loadUnit: (e.target.value || null) as LoadUnit | null })}
              className="rounded-lg border border-gray-300 px-1.5 py-1.5 text-sm w-16"
            >
              <option value="" disabled>
                Unit…
              </option>
              <option value="kg">kg</option>
              <option value="lb">lb</option>
            </select>
          </div>
        )}
        {formatLoadLabel(draft) && <p className="text-[11px] text-gray-400">{formatLoadLabel(draft)}</p>}
      </div>
    </CompactField>
  );
}

// C5.4 Revision D — label for an optional "More options" field. A field
// shown only because the saved/working dosage already carries a value (not
// applicable to this exercise per canonical metadata) is marked, so the
// clinician can see it is preserved historical data rather than a
// standard modifier for this exercise.
function OptionalLabel({ label, htmlFor, offCapability, className }: { label: string; htmlFor?: string; offCapability: boolean; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={`text-xs font-medium text-gray-500 flex flex-wrap items-center gap-x-1.5 ${className ?? ""}`}>
      {label}
      {offCapability && (
        <span className="text-[10px] font-normal text-amber-700" data-testid="optional-field-off-capability" title="Not a standard option for this exercise — shown because a value is saved.">
          (saved value · not standard here)
        </span>
      )}
    </label>
  );
}

// RPE and RIR are mutually exclusive at the UI level (C5.4B §11) — choosing
// one clears the other; the DB schema itself does not forbid both, this
// rule exists only here and in validateDosageInput().
//
// C5.4 Revision D — each half is shown only when applicable (or already
// populated). With both, the None/RPE/RIR toggle is unchanged; with just
// one, a plain labelled input (blank = none) replaces the toggle.
function RpeRirFields({
  draft,
  onChange,
  showRpe,
  showRir,
  offCapability,
  error,
}: {
  draft: DosageDraft;
  onChange: (fields: Partial<DosageDraft>) => void;
  showRpe: boolean;
  showRir: boolean;
  offCapability: boolean;
  error?: string;
}) {
  const [selected, setSelected] = useState<"none" | "rpe" | "rir">(draft.rpe != null ? "rpe" : draft.rir != null ? "rir" : "none");

  function select(next: "none" | "rpe" | "rir") {
    setSelected(next);
    onChange({ rpe: next === "rpe" ? draft.rpe : null, rir: next === "rir" ? draft.rir : null });
  }

  const rpeInput = (
    <input
      type="number"
      min={0}
      max={10}
      step={0.5}
      aria-label="RPE value"
      value={draft.rpe ?? ""}
      onChange={(e) => onChange({ rpe: e.target.value === "" ? null : Number(e.target.value) })}
      className="w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
    />
  );
  const rirInput = (
    <input
      type="number"
      min={0}
      max={10}
      step={1}
      aria-label="RIR value"
      value={draft.rir ?? ""}
      onChange={(e) => onChange({ rir: e.target.value === "" ? null : Number(e.target.value) })}
      className="w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
    />
  );

  const toggleClass = (active: boolean) => (active ? "px-2 py-1 bg-brand-600 text-white" : "px-2 py-1 bg-white text-gray-600 hover:bg-gray-50");

  return (
    <div className="flex flex-col gap-1 min-w-0" data-testid="optional-field-rpe-rir">
      <OptionalLabel label={showRpe && showRir ? "RPE / RIR" : showRpe ? "RPE" : "RIR"} offCapability={offCapability} />
      {showRpe && showRir ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <div role="group" aria-label="RPE or RIR" className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-xs">
            <button type="button" onClick={() => select("none")} className={toggleClass(selected === "none")}>
              None
            </button>
            <button type="button" onClick={() => select("rpe")} className={toggleClass(selected === "rpe")}>
              RPE
            </button>
            <button type="button" onClick={() => select("rir")} className={toggleClass(selected === "rir")}>
              RIR
            </button>
          </div>
          {selected === "rpe" && rpeInput}
          {selected === "rir" && rirInput}
        </div>
      ) : showRpe ? (
        rpeInput
      ) : (
        rirInput
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

// C5.4 Revision B — DurationInput bug fix. Each sub-input (minutes,
// seconds) now owns its OWN local raw string state, seeded once from the
// incoming `seconds` prop. On every keystroke it commits a parsed value
// upward via onChange, but never re-derives its OWN displayed text from
// the round-tripped `seconds` prop that comes back down — that decompose/
// recompose-on-every-render was the root cause of the leading-zero/"030"
// bug (see the read-only audit). The prop IS still resynced, but only when
// it changes for a reason OTHER than this component's own last edit
// (Cancel restoring saved state, a fresh mount showing already-saved
// values, or a successful Save's server-confirmed value) — detected by
// comparing the incoming prop against what the CURRENT local text would
// itself parse to. This is React's documented "adjusting state when a prop
// changes" pattern (comparing against a bit of previous-render state),
// not an effect — so the resync happens before paint, with no flicker.
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
  const initial = secondsToMinSec(seconds);
  const [minText, setMinText] = useState<string>(initial.min != null ? String(initial.min) : "");
  const [secText, setSecText] = useState<string>(initial.sec != null ? String(initial.sec) : "");
  const [prevSeconds, setPrevSeconds] = useState<number | null>(seconds);

  const parsedTotal = minSecToSeconds(minText === "" ? null : Number(minText), secText === "" ? null : Number(secText));
  if (seconds !== prevSeconds) {
    setPrevSeconds(seconds);
    if (seconds !== parsedTotal) {
      const resynced = secondsToMinSec(seconds);
      setMinText(resynced.min != null ? String(resynced.min) : "");
      setSecText(resynced.sec != null ? String(resynced.sec) : "");
    }
  }

  function commit(nextMinText: string, nextSecText: string) {
    setMinText(nextMinText);
    setSecText(nextSecText);
    const min = nextMinText === "" ? null : Number(nextMinText);
    const sec = nextSecText === "" ? null : Number(nextSecText);
    onChange(minSecToSeconds(min, sec));
  }

  return (
    <div className={compact ? "flex flex-col gap-1" : "flex items-end gap-1.5"}>
      {compact && <span className="text-xs text-gray-500">{label}</span>}
      <div className="flex items-center gap-1">
        <input
          type="number"
          min={0}
          step={1}
          aria-label={`${label} minutes`}
          value={minText}
          onChange={(e) => commit(e.target.value, secText)}
          className="w-14 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
        />
        <span className="text-xs text-gray-400">min</span>
        <input
          type="number"
          min={0}
          max={59}
          step={1}
          aria-label={`${label} seconds`}
          value={secText}
          onChange={(e) => commit(minText, e.target.value)}
          className="w-14 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
        />
        <span className="text-xs text-gray-400">sec</span>
      </div>
      {!compact && !hideLabel && <span className="text-xs text-gray-400 mb-1.5">{label}</span>}
    </div>
  );
}
