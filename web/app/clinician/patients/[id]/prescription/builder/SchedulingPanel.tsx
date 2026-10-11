"use client";

// C5.4C — Prescription-level scheduling/informational authoring. All four
// fields here (scheduling_mode, target_sessions_per_week, phase,
// performance_focus) have existed in the schema since C5.2/C5.3B but were
// never exposed by any UI until now — this component is pure authoring, no
// new data model.

import { PHASE_OPTIONS, FOCUS_OPTIONS } from "@/lib/prescriptionProgram";
import type { BuilderDraftWorkout, SchedulingMode, RehabPhase, PerformanceFocus } from "./types";

// C5.4D — phase/focus label lists now live in lib/prescriptionProgram.ts so
// the Review and published views use the exact same wording.

type Props = {
  schedulingMode: SchedulingMode | null;
  targetSessionsPerWeek: number | null;
  phase: RehabPhase | null;
  performanceFocuses: PerformanceFocus[];
  workouts: BuilderDraftWorkout[];
  isOwner: boolean;
  // C5.4 Performance Pass — true while a weekday assignment is still being
  // saved: a mode switch clears weekdays server-side, so it must not race an
  // in-flight weekday write.
  modeChangeLocked: boolean;
  onSchedulingModeChange: (mode: SchedulingMode) => void;
  onTargetSessionsChange: (n: number | null) => void;
  onPhaseChange: (phase: RehabPhase | null) => void;
  onPerformanceFocusToggle: (focus: PerformanceFocus) => void;
};

export function SchedulingPanel({
  schedulingMode,
  targetSessionsPerWeek,
  phase,
  performanceFocuses,
  workouts,
  isOwner,
  modeChangeLocked,
  onSchedulingModeChange,
  onTargetSessionsChange,
  onPhaseChange,
  onPerformanceFocusToggle,
}: Props) {
  const orderedLabels = workouts
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((w, i) => w.label || `Workout ${String.fromCharCode(65 + i)}`);

  return (
    <div className="bg-white rounded-xl shadow border border-gray-100 p-4 space-y-4" data-testid="scheduling-panel">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Scheduling</h2>

      <div className="grid sm:grid-cols-2 gap-2">
        <button
          type="button"
          disabled={!isOwner || modeChangeLocked}
          onClick={() => onSchedulingModeChange("sequence")}
          data-testid="scheduling-mode-sequence"
          className={`text-left rounded-lg border p-3 ${
            schedulingMode === "sequence" ? "border-brand-600 bg-brand-50" : "border-gray-200 hover:border-gray-300"
          } disabled:cursor-not-allowed`}
        >
          <div className="font-medium text-gray-900 text-sm">Sequence</div>
          <p className="text-xs text-gray-500 mt-0.5">Workouts repeat in order. A missed workout remains next until completed.</p>
        </button>
        <button
          type="button"
          disabled={!isOwner || modeChangeLocked}
          onClick={() => onSchedulingModeChange("calendar")}
          data-testid="scheduling-mode-calendar"
          className={`text-left rounded-lg border p-3 ${
            schedulingMode === "calendar" ? "border-brand-600 bg-brand-50" : "border-gray-200 hover:border-gray-300"
          } disabled:cursor-not-allowed`}
        >
          <div className="font-medium text-gray-900 text-sm">Calendar</div>
          <p className="text-xs text-gray-500 mt-0.5">Workouts are assigned to specific weekdays. Missing one day does not change the next scheduled weekday.</p>
        </button>
      </div>

      {schedulingMode === "sequence" && (
        <div className="space-y-2" data-testid="sequence-authoring">
          <label htmlFor="target-sessions" className="block text-sm font-medium text-gray-700">
            Target sessions per week
          </label>
          <select
            id="target-sessions"
            disabled={!isOwner}
            value={targetSessionsPerWeek ?? ""}
            onChange={(e) => onTargetSessionsChange(e.target.value === "" ? null : Number(e.target.value))}
            className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="" disabled>
              Choose…
            </option>
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>

          {orderedLabels.length > 0 && (
            <p className="text-sm text-gray-600" data-testid="sequence-order-display">
              <span className="text-xs text-gray-400 uppercase tracking-wide mr-2">Order</span>
              {orderedLabels.join(" → ")}
            </p>
          )}
        </div>
      )}

      <div className="space-y-2 pt-2 border-t border-gray-100">
        <label htmlFor="rehab-phase" className="block text-sm font-medium text-gray-700">
          Rehabilitation Phase (optional)
        </label>
        <select
          id="rehab-phase"
          disabled={!isOwner}
          value={phase ?? ""}
          onChange={(e) => onPhaseChange((e.target.value || null) as RehabPhase | null)}
          className="w-full sm:w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="">None</option>
          {PHASE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2 pt-2 border-t border-gray-100">
        <p className="text-sm font-medium text-gray-700">Performance Focus (optional)</p>
        <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1">
          {FOCUS_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                disabled={!isOwner}
                checked={performanceFocuses.includes(opt.value)}
                onChange={() => onPerformanceFocusToggle(opt.value)}
              />
              {opt.label}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
