"use client";

// C5.4C — Workout navigation (§9-13, §19). Replaces the C5.4A/B implicit
// single-workout model with real tabs. The selected workout controls what
// DraftPanel shows and where Library Add places a new exercise (both owned
// by BuilderShell, this component only picks the id).

import { useState } from "react";
import type { BuilderDraftWorkout, SchedulingMode } from "./types";

const WEEKDAY_LABELS: { value: number; label: string }[] = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

const MAX_WORKOUTS = 3;

type Props = {
  workouts: BuilderDraftWorkout[];
  selectedWorkoutId: string | null;
  isOwner: boolean;
  schedulingMode: SchedulingMode | null;
  busy: boolean;
  // C5.4 Revision B decision #16 — exercise ids with unsaved dosage
  // changes, so the populated-workout delete confirmation can additionally
  // warn when deleting would also discard in-progress dosage authoring.
  dirtyExerciseIds: Set<string>;
  // C5.4 Performance Pass — workouts whose weekday change is still being
  // persisted (the buttons themselves already show the new state).
  savingWeekdayWorkoutIds: Set<string>;
  onSelect: (workoutId: string) => void;
  onAdd: () => void;
  onRename: (workoutId: string, label: string) => void;
  onReorder: (workoutId: string, direction: "left" | "right") => void;
  onDelete: (workoutId: string) => void;
  onWeekdayToggle: (workoutId: string, day: number) => void;
};

export function WorkoutTabs({
  workouts,
  selectedWorkoutId,
  isOwner,
  schedulingMode,
  busy,
  dirtyExerciseIds,
  savingWeekdayWorkoutIds,
  onSelect,
  onAdd,
  onRename,
  onReorder,
  onDelete,
  onWeekdayToggle,
}: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const ordered = workouts.slice().sort((a, b) => a.orderIndex - b.orderIndex);
  const selected = ordered.find((w) => w.id === selectedWorkoutId) ?? null;
  const selectedIndex = selected ? ordered.findIndex((w) => w.id === selected.id) : -1;

  // Cross-workout weekday ownership — a day maps to at most one workout
  // (C5.4C §6). Used to render every OTHER workout's owned days as
  // disabled/unavailable rather than silently letting the clinician steal
  // them (server independently rejects a conflicting payload regardless).
  const dayOwner = new Map<number, string>();
  for (const w of ordered) for (const d of w.daysOfWeek ?? []) dayOwner.set(d, w.id);

  function startRename(w: BuilderDraftWorkout) {
    setRenamingId(w.id);
    setRenameValue(w.label ?? "");
  }
  function commitRename() {
    if (renamingId && renameValue.trim().length > 0) onRename(renamingId, renameValue.trim());
    setRenamingId(null);
  }

  const pendingDeleteWorkout = ordered.find((w) => w.id === pendingDeleteId) ?? null;

  return (
    <div className="space-y-3" data-testid="workout-tabs">
      <div className="flex flex-wrap items-center gap-1.5">
        {ordered.map((w, i) => {
          const label = w.label || `Workout ${String.fromCharCode(65 + i)}`;
          const isSelected = w.id === selectedWorkoutId;
          return (
            <div key={w.id} className="flex items-center">
              {renamingId === w.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  className="w-28 rounded-lg border border-brand-400 px-2 py-1.5 text-sm"
                  aria-label="Workout name"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => onSelect(w.id)}
                  onDoubleClick={() => isOwner && startRename(w)}
                  data-testid="workout-tab"
                  data-workout-label={label}
                  aria-current={isSelected ? "true" : undefined}
                  className={`rounded-t-lg px-3 py-2 text-sm font-medium border-b-2 ${
                    isSelected ? "border-brand-600 text-brand-700 bg-white" : "border-transparent text-gray-500 hover:text-gray-700"
                  }`}
                >
                  {label}
                </button>
              )}
              {isOwner && isSelected && renamingId !== w.id && (
                <button type="button" onClick={() => startRename(w)} aria-label="Rename workout" className="ml-1 text-gray-300 hover:text-gray-500 text-xs">
                  ✎
                </button>
              )}
            </div>
          );
        })}

        {isOwner && ordered.length < MAX_WORKOUTS && (
          <button type="button" onClick={onAdd} disabled={busy} className="text-sm font-medium text-brand-600 hover:text-brand-700 px-2 py-2">
            + Add Workout
          </button>
        )}
      </div>

      {isOwner && selected && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <button
            type="button"
            onClick={() => onReorder(selected.id, "left")}
            disabled={busy || selectedIndex <= 0}
            aria-label="Move workout left"
            className="w-7 h-7 rounded border border-gray-200 text-gray-500 hover:text-brand-600 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ←
          </button>
          <button
            type="button"
            onClick={() => onReorder(selected.id, "right")}
            disabled={busy || selectedIndex === -1 || selectedIndex >= ordered.length - 1}
            aria-label="Move workout right"
            className="w-7 h-7 rounded border border-gray-200 text-gray-500 hover:text-brand-600 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            →
          </button>
          <button
            type="button"
            onClick={() => setPendingDeleteId(selected.id)}
            disabled={busy}
            aria-label="Delete workout"
            className="ml-auto text-red-500 hover:text-red-700 disabled:opacity-30"
          >
            Delete workout
          </button>
        </div>
      )}

      {pendingDeleteWorkout && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm space-y-2" data-testid="delete-workout-confirm">
          {pendingDeleteWorkout.exercises.length > 0 ? (
            <p className="text-red-800">
              <strong>{pendingDeleteWorkout.label || "This workout"}</strong> contains {pendingDeleteWorkout.exercises.length} exercise
              {pendingDeleteWorkout.exercises.length === 1 ? "" : "s"}. Deleting it will remove{" "}
              {pendingDeleteWorkout.exercises.length === 1 ? "that exercise" : "those exercises"} and their dosage from this DRAFT. The active published
              prescription is not affected. Consider moving exercises to another workout first if you want to keep them.
              {pendingDeleteWorkout.exercises.some((e) => dirtyExerciseIds.has(e.id)) && (
                <span data-testid="delete-workout-unsaved-warning"> This workout also has unsaved dosage edits that will be discarded.</span>
              )}
            </p>
          ) : (
            <p className="text-red-800">Delete {pendingDeleteWorkout.label || "this empty workout"}?</p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                onDelete(pendingDeleteWorkout.id);
                setPendingDeleteId(null);
              }}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
            >
              Delete Workout
            </button>
            <button type="button" onClick={() => setPendingDeleteId(null)} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
              Cancel
            </button>
          </div>
        </div>
      )}

      {schedulingMode === "calendar" && selected && (
        <div className="flex flex-wrap gap-1.5" data-testid="weekday-assignment">
          {WEEKDAY_LABELS.map(({ value, label }) => {
            const ownerId = dayOwner.get(value);
            const ownedBySelected = ownerId === selected.id;
            const ownedByOther = !!ownerId && !ownedBySelected;
            return (
              <button
                key={value}
                type="button"
                disabled={!isOwner || busy || ownedByOther}
                onClick={() => onWeekdayToggle(selected.id, value)}
                title={ownedByOther ? "Already assigned to another workout — unassign it there first" : undefined}
                data-testid="weekday-button"
                data-day={value}
                className={`w-12 h-9 rounded-lg border text-xs font-medium ${
                  ownedBySelected
                    ? "bg-brand-600 border-brand-600 text-white"
                    : ownedByOther
                      ? "bg-gray-100 border-gray-200 text-gray-300 cursor-not-allowed"
                      : "bg-white border-gray-300 text-gray-600 hover:border-gray-400"
                }`}
              >
                {label}
              </button>
            );
          })}
          {savingWeekdayWorkoutIds.has(selected.id) && (
            <span className="self-center text-xs text-gray-500" role="status" data-testid="weekday-save-status">
              Saving…
            </span>
          )}
        </div>
      )}
    </div>
  );
}
