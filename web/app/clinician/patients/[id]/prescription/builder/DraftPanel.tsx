"use client";

// C5.4A/B/C/RevisionB — Draft panel. Renders only the SELECTED workout's
// exercises (workout switching lives in WorkoutTabs, rendered by
// BuilderShell above this component) and a "Move to..." control per row so
// an exercise can be relocated to a different workout without losing its
// dosage/instructions/status (all preserved server-side by moveExercise()
// — see prescriptionDraftServer.ts).
//
// C5.4 Revision B — the dosage editor is no longer a single accordion: any
// number of rows can be expanded simultaneously (BuilderShell's
// expandedDosageIds), and each row's unsaved working state lives in
// BuilderShell's dosageWorkingState map, not in DosageEditor's own
// lifetime — see BuilderShell.tsx's header comment for why. The whole row
// (not just the dosage pill) is the expand/collapse affordance; every OTHER
// interactive control in the row (Move to..., drag handle, delete) stops
// propagation so interacting with them never toggles the editor.
//
// C5.4 Revision C, Parts 5-11 — drag-and-drop REPLACES the old visible
// up/down arrow buttons as the primary within-workout reorder interaction.
// The drag handle (not the row) is the only pointer/touch drag activator —
// PointerSensor/TouchSensor activation constraints below are exactly why
// dragging never fires from a tap inside dosage fields, "Move to...", or
// delete. Reordering is intentionally WITHIN the current workout only —
// dragging never crosses workouts; moving between workouts stays on the
// separate "Move to..." control (Part 13). The KeyboardSensor keeps
// reordering possible without a pointer (Part 8): Tab to the handle, Space
// to pick up, Arrow keys to move, Space to drop, Escape to cancel.
//
// Reordering never touches dosageWorkingState/expandedDosageIds — both are
// keyed by prescriptionExerciseId, which a reorder never changes, so
// dirty/unsaved dosage and every expanded editor survive a drag for free
// (Parts 9-10). handleReorderExercises in BuilderShell applies the new
// order optimistically for immediate drag feedback, then rolls back to the
// pre-drag order (never touching dosage state) and surfaces an error if the
// server rejects it (Part 11) — see that function's own comment.
//
// C5.4 Revision E — once dosage is saved, a row reads as a PRESCRIPTION:
// exercise name, then the saved values as prominent chips (core dose first,
// More-options modifiers after, instructions set apart below), then the
// loading-profile metadata. Opening the editor on a saved row is an explicit
// Edit action — clicking the card body no longer opens it. A row with no
// saved dosage still opens from the card (or its "Add dosage" button), and
// clicking the header of an OPEN editor still collapses it without
// discarding its working values (unchanged Revision B behaviour).

import { useId, useRef, useState } from "react";
import { DndContext, PointerSensor, TouchSensor, KeyboardSensor, useSensor, useSensors, closestCenter, type DragEndEvent, type KeyboardCoordinateGetter, type UniqueIdentifier } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { formatLoadingProfileLabel } from "@/lib/canonicalExerciseLibrary";
import { buildDosageSummary, emptyDosageDraft, dosageDraftsEqual, type DosageDraft } from "@/lib/dosageEditor";
import { DosageEditor } from "./DosageEditor";
import type { BuilderDraftWorkout, BuilderLibraryExercise } from "./types";

// C5.4 Revision B — an exercise's lifted, unsaved dosage-authoring state
// (BuilderShell owns the map this shape lives in; see that file's header).
export type DosageWorkingEntry = {
  draft: DosageDraft;
  instructions: string;
  savedDraft: DosageDraft;
  savedInstructions: string;
};

type Props = {
  selectedWorkout: BuilderDraftWorkout | null;
  otherWorkouts: BuilderDraftWorkout[];
  isOwner: boolean;
  onRemove: (exerciseId: string) => void;
  onReorderExercises: (workoutId: string, orderedExerciseIds: string[]) => void;
  onMoveToWorkout: (exerciseId: string, targetWorkoutId: string) => void;
  busy: boolean;
  exercisesById: Map<string, BuilderLibraryExercise>;
  expandedDosageIds: Record<string, boolean>;
  dosageWorkingState: Record<string, DosageWorkingEntry>;
  dosageSaving: Record<string, boolean>;
  dosageSaveError: Record<string, string | null>;
  dosageShowErrors: Record<string, boolean>;
  saveAllRunning: boolean;
  pendingRemoveExerciseId: string | null;
  onSetPendingRemoveExerciseId: (exerciseId: string | null) => void;
  onToggleDosageExpand: (exerciseId: string) => void;
  onDosageDraftChange: (exerciseId: string, patch: Partial<DosageDraft>) => void;
  onDosageInstructionsChange: (exerciseId: string, value: string) => void;
  onSaveDosage: (exerciseId: string) => void;
  onCancelDosage: (exerciseId: string) => void;
};

// C5.4 Closeout — keyboard reordering that works for rows of any height.
// dnd-kit's stock sortableKeyboardCoordinates moves the dragged row so its
// top/bottom EDGE lines up with the neighbouring row, then closestCenter
// decides the drop target by comparing CENTERS. When the dragged row has an
// expanded dosage editor (several times taller than its neighbours), its
// center after that move is still nearest its own slot, so the arrow key
// silently did nothing. This getter steps one position through the sortable
// order instead (Up/Down only — the list is vertical) and centers the
// dragged row on the target row, so closestCenter resolves to exactly that
// target regardless of either row's height.
//
// The stepped-to target is also remembered in `targetRef` and is what a
// keyboard drop commits (handleDragEnd). When a step needs the panel to
// scroll, the KeyboardSensor scrolls smoothly and dnd-kit's `over` only
// catches up once the scroll settles — stepping from `over` alone would
// lose arrow presses made during that window.
function makeSteppedKeyboardCoordinates(targetRef: { current: UniqueIdentifier | null }): KeyboardCoordinateGetter {
  return (event, { context: { active, over, collisionRect, droppableRects } }) => {
    const step = event.code === "ArrowDown" ? 1 : event.code === "ArrowUp" ? -1 : 0;
    if (step === 0) return undefined;
    event.preventDefault();
    if (!active || !collisionRect) return undefined;
    const items: UniqueIdentifier[] | undefined = active.data.current?.sortable?.items;
    if (!items) return undefined;
    const targetId = items[items.indexOf(targetRef.current ?? over?.id ?? active.id) + step];
    const targetRect = targetId === undefined ? undefined : droppableRects.get(targetId);
    if (targetId === undefined || !targetRect) return undefined;
    targetRef.current = targetId;
    return { x: collisionRect.left, y: targetRect.top + targetRect.height / 2 - collisionRect.height / 2 };
  };
}

function isDirty(entry: DosageWorkingEntry | undefined): boolean {
  if (!entry) return false;
  return entry.instructions !== entry.savedInstructions || !dosageDraftsEqual(entry.draft, entry.savedDraft);
}

export function DraftPanel({
  selectedWorkout,
  otherWorkouts,
  isOwner,
  onRemove,
  onReorderExercises,
  onMoveToWorkout,
  busy,
  exercisesById,
  expandedDosageIds,
  dosageWorkingState,
  dosageSaving,
  dosageSaveError,
  dosageShowErrors,
  saveAllRunning,
  pendingRemoveExerciseId,
  onSetPendingRemoveExerciseId,
  onToggleDosageExpand,
  onDosageDraftChange,
  onDosageInstructionsChange,
  onSaveDosage,
  onCancelDosage,
}: Props) {
  // activationConstraint distance/delay tuning is the whole reason a normal
  // click on the handle or a mobile scroll gesture never gets mistaken for a
  // drag (Part 7): pointer requires 8px of intentional movement first; touch
  // requires the finger to hold still for 200ms (a scroll starts moving
  // immediately and never reaches that window).
  // Set only while a keyboard drag has stepped (see makeSteppedKeyboardCoordinates).
  const keyboardTargetRef = useRef<UniqueIdentifier | null>(null);
  const [steppedKeyboardCoordinates] = useState(() => makeSteppedKeyboardCoordinates(keyboardTargetRef));
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: steppedKeyboardCoordinates })
  );
  // C5.4 Closeout — without an explicit id, DndContext numbers the
  // aria-describedby it puts on every drag handle ("DndDescribedBy-N") from a
  // module-level counter that never matches between the server render and
  // hydration, so React reported a hydration mismatch and kept the server's
  // id — leaving each handle described by an element that doesn't exist.
  // React's useId is stable across server and client.
  const dndContextId = useId();

  if (!selectedWorkout) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 text-center">
        <p className="text-sm text-gray-500">No workout selected yet.</p>
        <p className="text-xs text-gray-400 mt-1">Add a workout to begin building this prescription.</p>
      </div>
    );
  }

  const exercises = selectedWorkout.exercises;
  const workoutId = selectedWorkout.id;
  // C5.4 Performance Pass — while a Library add is still being saved, its
  // row has no server id yet, so reordering this workout waits until it
  // settles (normally well under a second).
  const hasPendingAdd = exercises.some((e) => e.pending);

  function resetKeyboardTarget() {
    keyboardTargetRef.current = null;
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    const overId = keyboardTargetRef.current ?? over?.id;
    resetKeyboardTarget();
    if (overId == null || active.id === overId) return;
    const oldIndex = exercises.findIndex((e) => e.id === active.id);
    const newIndex = exercises.findIndex((e) => e.id === overId);
    if (oldIndex === -1 || newIndex === -1) return;
    const newOrder = arrayMove(exercises, oldIndex, newIndex).map((e) => e.id);
    onReorderExercises(workoutId, newOrder);
  }

  return (
    <div className="space-y-2" data-testid="draft-exercise-list">
      {exercises.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 text-center">
          <p className="text-sm text-gray-500">No exercises in {selectedWorkout.label || "this workout"} yet.</p>
          <p className="text-xs text-gray-400 mt-1">Add exercises from the library to get started.</p>
        </div>
      ) : (
        <DndContext id={dndContextId} sensors={sensors} collisionDetection={closestCenter} onDragStart={resetKeyboardTarget} onDragCancel={resetKeyboardTarget} onDragEnd={handleDragEnd}>
          <SortableContext items={exercises.map((e) => e.id)} strategy={verticalListSortingStrategy}>
            {exercises.map((exercise, index) => {
              const entry = dosageWorkingState[exercise.id];
              const dirty = isDirty(entry);
              const isExpanded = !!expandedDosageIds[exercise.id];
              const meta = exercisesById.get(exercise.canonicalExerciseId);
              const defaultCapabilities = meta?.defaultDosageCapabilities ?? [];
              const allowedCapabilities = meta?.allowedDosageCapabilities ?? [];
              const optionalFieldCapabilities = meta?.optionalFieldCapabilities ?? [];
              const referenceDosage = meta?.referenceDosage ?? null;
              const savedSummaryDraft: DosageDraft = entry?.savedDraft ?? exercise.dosage ?? emptyDosageDraft();
              const savedInstructions = entry?.savedInstructions ?? exercise.additionalInstructions ?? "";
              // A just-saved exercise's savedDraft carries the server-confirmed
              // dosageType before the follow-up draft refresh lands, so the
              // card never flashes "Dosage needed" between the two.
              const hasSavedDosage = exercise.dosage !== null || entry?.savedDraft.dosageType != null;
              const saveFailed = !!dosageSaveError[exercise.id];
              // The card header toggles the editor only when that is not an
              // accidental way into editing a saved prescription: it opens a
              // never-dosed exercise, and collapses an already-open editor.
              const headerToggles = isOwner && !exercise.pending && (isExpanded || !hasSavedDosage);
              const loadingProfileLabel = formatLoadingProfileLabel(exercise.loadingProfile);

              return (
                <SortableExerciseRow key={exercise.id} exerciseId={exercise.id} disabled={!isOwner || busy || hasPendingAdd} highlightError={saveFailed}>
                  <div
                    className={headerToggles ? "flex items-start gap-2 cursor-pointer" : "flex items-start gap-2"}
                    onClick={() => headerToggles && onToggleDosageExpand(exercise.id)}
                    role={headerToggles ? "button" : undefined}
                    tabIndex={headerToggles ? 0 : undefined}
                    onKeyDown={(e) => {
                      if (headerToggles && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        onToggleDosageExpand(exercise.id);
                      }
                    }}
                    aria-expanded={isOwner ? isExpanded : undefined}
                    data-testid="draft-exercise-row-toggle"
                  >
                    <span className="shrink-0 mt-0.5 w-6 h-6 rounded-full bg-gray-100 text-gray-600 text-xs font-medium flex items-center justify-center">{index + 1}</span>

                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 min-h-7">
                        {headerToggles && (
                          <span aria-hidden="true" className="text-gray-300 text-xs">
                            {isExpanded ? "▾" : "▸"}
                          </span>
                        )}
                        <span className="font-semibold text-gray-900 min-w-0 break-words" data-testid="draft-exercise-name">
                          {exercise.exerciseName}
                        </span>
                        {exercise.pending && (
                          <span className="inline-flex items-center rounded-full bg-gray-100 text-gray-600 text-[10px] font-semibold px-1.5 py-0.5 uppercase tracking-wide" data-testid="pending-add-indicator">
                            Adding…
                          </span>
                        )}
                        {dirty && (
                          <span className="inline-flex items-center rounded-full bg-amber-100 text-amber-700 text-[10px] font-semibold px-1.5 py-0.5 uppercase tracking-wide" data-testid="unsaved-indicator">
                            Unsaved changes
                          </span>
                        )}
                      </div>
                    </div>

                    {isOwner && !exercise.pending && (
                      <div className="shrink-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        {!isExpanded && (
                          <button
                            type="button"
                            onClick={() => onToggleDosageExpand(exercise.id)}
                            aria-label={hasSavedDosage ? `Edit dosage for ${exercise.exerciseName}` : `Add dosage for ${exercise.exerciseName}`}
                            data-testid="edit-dosage"
                            className="inline-flex items-center gap-1 h-7 rounded border border-gray-200 px-2 text-xs font-medium text-brand-700 hover:bg-brand-50 hover:border-brand-200"
                          >
                            <PencilIcon />
                            {/* Icon-only on phones so the exercise name keeps the room. */}
                            <span className="hidden sm:inline">{hasSavedDosage ? "Edit" : "Add dosage"}</span>
                          </button>
                        )}
                        {otherWorkouts.length > 0 && (
                          <select
                            aria-label="Move to workout"
                            data-testid="move-to-workout"
                            value=""
                            disabled={busy}
                            onChange={(e) => {
                              if (e.target.value) onMoveToWorkout(exercise.id, e.target.value);
                            }}
                            className="h-7 text-xs rounded border border-gray-200 text-gray-500 px-1 max-w-[4.75rem] sm:max-w-[6.5rem] sm:px-1.5"
                          >
                            <option value="">Move to…</option>
                            {otherWorkouts.map((w, i) => (
                              <option key={w.id} value={w.id}>
                                {w.label || `Workout ${String.fromCharCode(65 + i)}`}
                              </option>
                            ))}
                          </select>
                        )}
                        <button
                          onClick={() => (dirty ? onSetPendingRemoveExerciseId(exercise.id) : onRemove(exercise.id))}
                          disabled={busy}
                          aria-label="Remove from draft"
                          className="w-7 h-7 rounded border border-gray-200 text-gray-500 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </div>

                  {!isExpanded && (
                    <div className="mt-2 pl-8">
                      {hasSavedDosage ? (
                        <SavedPrescription draft={savedSummaryDraft} instructions={savedInstructions} />
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-amber-50 text-amber-700 text-xs font-medium px-2 py-0.5" data-testid="dosage-summary">
                          Dosage needed
                        </span>
                      )}
                    </div>
                  )}
                  {saveFailed && !isExpanded && (
                    <p className="mt-1 pl-8 text-xs text-red-600" role="alert">
                      {dosageSaveError[exercise.id]}
                    </p>
                  )}
                  {loadingProfileLabel && <div className="mt-1.5 pl-8 text-xs text-gray-400">{loadingProfileLabel}</div>}

                  {pendingRemoveExerciseId === exercise.id && (
                    <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-800 space-y-2" data-testid="remove-exercise-confirm" onClick={(e) => e.stopPropagation()}>
                      <p>
                        <strong>{exercise.exerciseName}</strong> has unsaved dosage changes. Removing it will discard those changes along with the exercise. This does not affect the active
                        published prescription.
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            onRemove(exercise.id);
                            onSetPendingRemoveExerciseId(null);
                          }}
                          className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
                        >
                          Discard and Remove
                        </button>
                        <button
                          type="button"
                          onClick={() => onSetPendingRemoveExerciseId(null)}
                          className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                        >
                          Keep Exercise
                        </button>
                      </div>
                    </div>
                  )}

                  {isExpanded && isOwner && entry && (
                    <DosageEditor
                      draft={entry.draft}
                      instructions={entry.instructions}
                      savedDraft={entry.savedDraft}
                      defaultCapabilities={defaultCapabilities}
                      allowedCapabilities={allowedCapabilities}
                      optionalFieldCapabilities={optionalFieldCapabilities}
                      referenceDosage={referenceDosage}
                      isDirty={dirty}
                      saving={!!dosageSaving[exercise.id] || saveAllRunning}
                      saveError={dosageSaveError[exercise.id] ?? null}
                      showErrors={!!dosageShowErrors[exercise.id]}
                      onDraftChange={(patch) => onDosageDraftChange(exercise.id, patch)}
                      onInstructionsChange={(value) => onDosageInstructionsChange(exercise.id, value)}
                      onSave={() => onSaveDosage(exercise.id)}
                      onCancel={() => onCancelDosage(exercise.id)}
                    />
                  )}
                </SortableExerciseRow>
              );
            })}
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

// C5.4 Revision C, Part 6 — the drag handle (not the card) is the sole
// pointer/touch/keyboard drag activator: `listeners`/`attributes` are
// attached ONLY to the handle button below, never to the outer row, so
// dragging can never be triggered by (and never interferes with) opening
// dosage, entering fields, selecting text, "Move to...", delete, Edit,
// or "Save dosage" — all of those stay ordinary clicks inside
// the row. When disabled (view-only or busy), the handle renders inert with
// no listeners at all, matching Part: "view-only clinician cannot reorder."
function SortableExerciseRow({ exerciseId, disabled, highlightError, children }: { exerciseId: string; disabled: boolean; highlightError: boolean; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useSortable({ id: exerciseId, disabled });
  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` : undefined,
    opacity: isDragging ? 0.5 : undefined,
    zIndex: isDragging ? 10 : undefined,
    position: "relative",
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`bg-white rounded-lg border shadow-sm p-3 flex gap-2 ${highlightError ? "border-red-300 ring-1 ring-red-200" : "border-gray-100"}`}
      data-testid="draft-exercise-row"
      data-save-failed={highlightError ? "true" : undefined}
    >
      {!disabled && (
        // setActivatorNodeRef (distinct from the outer setNodeRef above) is
        // required whenever the drag activator is a separate handle rather
        // than the draggable node itself — dnd-kit's KeyboardSensor checks
        // that the keydown's event.target matches this exact node before
        // treating Space/Enter as a pickup, so keyboard reordering silently
        // no-ops without it even though pointer/touch dragging works fine.
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label="Drag to reorder exercise"
          data-testid="drag-handle"
          className="shrink-0 self-stretch w-5 flex items-center justify-center text-gray-300 hover:text-gray-500 cursor-grab active:cursor-grabbing touch-none"
        >
          ⠿
        </button>
      )}
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function PencilIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
      <path d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-.793.793-2.828-2.828.793-.793ZM11.379 5.793 3 14.172V17h2.828l8.38-8.379-2.83-2.828Z" />
    </svg>
  );
}

// C5.4 Revision E — the collapsed card's saved prescription. Core dose
// values (sets, reps/hold/contacts/distance/time, load, rest) are the
// emphasized chips; More-options modifiers follow as lighter chips so they
// stay visible after save; patient instructions sit apart below, clamped to
// two lines so a long note never buries the dose (full text on hover).
// Built from buildDosageSummary(), which emits only fields with a saved
// value — absent/null fields produce nothing, never a fabricated 0.
function SavedPrescription({ draft, instructions }: { draft: DosageDraft; instructions: string }) {
  const items = buildDosageSummary(draft);
  const primary = items.filter((i) => i.kind === "primary");
  const modifiers = items.filter((i) => i.kind === "modifier");
  const trimmedInstructions = instructions.trim();
  return (
    <div data-testid="dosage-summary" className="space-y-1.5">
      {items.length === 0 ? (
        <p className="text-sm text-gray-500">No dosage values entered.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5" aria-label="Prescribed dosage">
          {primary.map((item) => (
            <li
              key={item.key}
              data-testid={`summary-${item.key}`}
              className="inline-flex items-baseline gap-1 rounded-md bg-brand-50 border border-brand-100 px-2 py-0.5"
            >
              <span className="text-[15px] font-semibold text-gray-900 tabular-nums">{item.value}</span>
              {item.suffix && <span className="text-xs text-gray-600">{item.suffix}</span>}
            </li>
          ))}
          {modifiers.map((item) => (
            <li
              key={item.key}
              data-testid={`summary-${item.key}`}
              className="inline-flex items-baseline gap-1 rounded-md bg-white border border-gray-200 px-2 py-0.5 max-w-full"
            >
              {item.prefix && <span className="text-xs text-gray-500">{item.prefix}</span>}
              <span className="text-sm font-medium text-gray-800 truncate">{item.value}</span>
              {item.suffix && <span className="text-xs text-gray-500">{item.suffix}</span>}
            </li>
          ))}
        </ul>
      )}
      {trimmedInstructions && (
        <p className="border-l-2 border-gray-300 pl-2 text-xs text-gray-600 line-clamp-2" title={trimmedInstructions} data-testid="summary-instructions">
          <span className="font-medium text-gray-500">Instructions: </span>
          {trimmedInstructions}
        </p>
      )}
    </div>
  );
}
