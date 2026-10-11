"use client";

// C5.4A/B/C/RevisionB — The one client component in the clinician surface
// (see PatientNav.tsx's header) — deliberately scoped to this route only.
// Owns all interactive state; every mutation goes through EXISTING (or, for
// C5.4C's move-exercise, newly added but equally thin) C5.3-style API
// routes — never a direct client write — then re-fetches the draft from
// GET /api/clinician/prescription-drafts/[draftId] to pick up the
// authoritative server state (including any server-side mode-switch
// cleanup — see updateDraftMetadata()'s header).
//
// C5.4 Revision B — dosage authoring's UNSAVED WORKING STATE is lifted here
// (dosageWorkingState, keyed by prescriptionExerciseId), not owned by
// DosageEditor's own component lifetime. This is the direct fix for the
// pre-Revision-B data-loss bug: DraftPanel only ever renders the CURRENTLY
// SELECTED workout's exercises, so a DosageEditor instance genuinely
// unmounts every time the clinician switches workouts (or, previously,
// every time a DIFFERENT exercise's editor opened, since only one could be
// open at a time). Local useState inside DosageEditor could not survive
// that unmount. Because the working-state map lives here instead, it is
// completely unaffected by which workout is selected, which editors are
// expanded, or an exercise being moved between workouts (the map is keyed
// by exercise id, not by workout) — only explicit exercise/workout DELETION
// removes an entry (see handleRemove/handleDeleteWorkout below).
//
// C5.4 Revision E — a successful dosage save now collapses that exercise's
// editor back to its saved-prescription card, and "Save all dosing" persists
// every dirty exercise in the draft in one action. Both go through the same
// saveDosageEntry() path (shared validator → existing PUT dosage + PATCH
// instructions routes), so there is still exactly one dosage-save model.
//
// C5.4 Performance Pass — profiling showed every hot interaction (weekday
// toggle, Add, Phase, Performance Focus, Save dosage) waited for its write
// AND a full-draft re-read (16-18 sequential Supabase round trips, ~1.3s)
// before anything changed on screen, and the global `busy` lock serialized
// rapid clicks behind that whole cycle. Those interactions now update local
// state immediately and reconcile against the WRITE's own response instead
// of re-reading the draft:
//   - field-level edits (weekdays, phase, target, focus) go through
//     syncLatest(): one request in flight per field, always sending the
//     newest local value, rolled back to the last server-confirmed value
//     (with an error) on failure;
//   - Add inserts a clearly-pending row, replaced by the persisted row on
//     success or removed (with an error) on failure;
//   - Save dosage patches the exercise from the server-confirmed dosage.
// Optimistic values are also registered as OVERLAYS (overlaysRef) so a
// full refreshDraft() triggered by some other action — whose read may have
// started before this write landed — can never visually undo them. The
// database stays the only source of clinical truth: overlays only ever hold
// a value that is in flight or that the server has already confirmed.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { filterLibraryExercises, computeLibraryFacets, EMPTY_LIBRARY_FILTERS, type LibraryFilters } from "@/lib/canonicalExerciseLibrary";
import { mapDosageRowToInput, emptyDosageDraft, dosageDraftsEqual, deriveDosageType, validateDosageInput, type DosageDraft } from "@/lib/dosageEditor";
import type { DosageInput } from "@/lib/prescriptionDraftTypes";
import { LibraryPanel } from "./LibraryPanel";
import { DraftPanel, type DosageWorkingEntry } from "./DraftPanel";
import { WorkoutTabs } from "./WorkoutTabs";
import { SchedulingPanel } from "./SchedulingPanel";
import type { BuilderDraftWorkout, BuilderDraftExercise, BuilderLibraryExercise, SchedulingMode, RehabPhase, PerformanceFocus } from "./types";

type RawApiExercise = {
  id: string;
  canonical_exercise_id: string;
  order_index: number;
  status: "active" | "paused";
  additional_instructions: string | null;
  prescription_exercise_dosage: unknown;
};
type RawApiWorkout = {
  id: string;
  label: string | null;
  order_index: number;
  days_of_week: number[] | null;
  prescription_exercises: RawApiExercise[] | null;
};
type RawApiDraft = { scheduling_mode: SchedulingMode | null; phase: RehabPhase | null; target_sessions_per_week: number | null };

type Props = {
  patientId: string;
  draftId: string;
  isOwner: boolean;
  editingClinicianName: string;
  initialWorkouts: BuilderDraftWorkout[];
  initialExercises: Omit<BuilderLibraryExercise, "hasReferenceDosage">[];
  initialSchedulingMode: SchedulingMode | null;
  initialPhase: RehabPhase | null;
  initialTargetSessionsPerWeek: number | null;
  initialPerformanceFocuses: PerformanceFocus[];
  // C5.4D — where a Review issue's "Edit …" link wants the builder opened.
  initialFocus?: { workoutId: string | null; exerciseId: string | null; section: "schedule" | "weekdays" | null };
};

const WORKOUT_MAX = 3;

function mapRawExercise(ex: RawApiExercise, exercisesById: Map<string, BuilderLibraryExercise>) {
  const rawDosage = Array.isArray(ex.prescription_exercise_dosage) ? ex.prescription_exercise_dosage[0] : ex.prescription_exercise_dosage;
  const dosage: DosageInput | null = mapDosageRowToInput(rawDosage as Record<string, unknown> | null | undefined);
  const meta = exercisesById.get(ex.canonical_exercise_id);
  return {
    id: ex.id,
    canonicalExerciseId: ex.canonical_exercise_id,
    orderIndex: ex.order_index,
    status: ex.status,
    exerciseName: meta?.name ?? "Unknown exercise",
    loadingProfile: meta?.loadingProfile ?? null,
    dosageConfigured: dosage !== null,
    dosage,
    additionalInstructions: ex.additional_instructions ?? null,
  };
}

function mapRawWorkout(w: RawApiWorkout, exercisesById: Map<string, BuilderLibraryExercise>): BuilderDraftWorkout {
  return {
    id: w.id,
    label: w.label ?? null,
    orderIndex: w.order_index,
    daysOfWeek: w.days_of_week ?? null,
    exercises: (w.prescription_exercises ?? [])
      .slice()
      .sort((a, b) => a.order_index - b.order_index)
      .map((ex) => mapRawExercise(ex, exercisesById)),
  };
}

function withDerived(e: Omit<BuilderLibraryExercise, "hasReferenceDosage">): BuilderLibraryExercise {
  return { ...e, hasReferenceDosage: e.referenceDosage !== null };
}

function nextWorkoutLabel(existingCount: number): string {
  return `Workout ${String.fromCharCode(65 + existingCount)}`;
}

// The slice of builder state refreshDraft() sets from the server, which
// optimistic overlays may adjust before it is applied.
type FreshDraftState = {
  workouts: BuilderDraftWorkout[];
  phase: RehabPhase | null;
  targetSessionsPerWeek: number | null;
  performanceFocuses: PerformanceFocus[];
};
type Overlay = { epoch: number; pending: boolean; apply: (s: FreshDraftState) => FreshDraftState };

const PENDING_ID_PREFIX = "pending:";
const SAVE_ALL_CONCURRENCY = 4;

function withWorkoutDays(workouts: BuilderDraftWorkout[], workoutId: string, days: number[] | null): BuilderDraftWorkout[] {
  return workouts.map((w) => (w.id === workoutId ? { ...w, daysOfWeek: days } : w));
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isWorkingEntryDirty(entry: DosageWorkingEntry): boolean {
  return !dosageDraftsEqual(entry.draft, entry.savedDraft) || entry.instructions !== entry.savedInstructions;
}

export function BuilderShell({
  patientId,
  draftId,
  isOwner,
  editingClinicianName,
  initialWorkouts,
  initialExercises,
  initialSchedulingMode,
  initialPhase,
  initialTargetSessionsPerWeek,
  initialPerformanceFocuses,
  initialFocus,
}: Props) {
  // C5.4D — resolve the Review deep-link against the draft actually loaded.
  // Unknown ids are simply ignored. Opening an exercise's dosage editor here
  // goes through the same working-state initialization ensureWorkingEntry()
  // performs (from the SAVED dosage), so no data is created or changed.
  const focusTarget = useMemo(() => {
    const workout = initialWorkouts.find((w) => w.id === initialFocus?.workoutId) ?? null;
    const exercise = workout?.exercises.find((e) => e.id === initialFocus?.exerciseId) ?? null;
    return { workout, exercise, section: initialFocus?.section ?? null };
    // Initial render only: a deep link is consumed once, never re-applied.
  }, []);
  const [workouts, setWorkouts] = useState<BuilderDraftWorkout[]>(initialWorkouts);
  const [selectedWorkoutId, setSelectedWorkoutId] = useState<string | null>(
    focusTarget.workout?.id ?? initialWorkouts.slice().sort((a, b) => a.orderIndex - b.orderIndex)[0]?.id ?? null
  );
  const [schedulingMode, setSchedulingMode] = useState<SchedulingMode | null>(initialSchedulingMode);
  const [phase, setPhase] = useState<RehabPhase | null>(initialPhase);
  const [targetSessionsPerWeek, setTargetSessionsPerWeek] = useState<number | null>(initialTargetSessionsPerWeek);
  const [performanceFocuses, setPerformanceFocuses] = useState<PerformanceFocus[]>(initialPerformanceFocuses);
  // Kept in sync with performanceFocuses on every render, but also updated
  // SYNCHRONOUSLY inside handlePerformanceFocusToggle itself — a plain
  // closure over the `performanceFocuses` state variable would compute a
  // stale `next` set if the clinician clicks two checkboxes in quick
  // succession (a very plausible multi-select interaction), before the
  // first toggle's PATCH+refresh round trip has updated state. Reading/
  // writing this ref instead means each click always builds on the
  // truly-latest intended set, never a stale one.
  const performanceFocusesRef = useRef(performanceFocuses);
  performanceFocusesRef.current = performanceFocuses;
  // Guards against a stale refreshDraft() response clobbering newer state.
  // This isn't only an out-of-order-network-response problem: a Phase
  // change's refresh can still be AWAITING ITS FETCH when a Performance
  // Focus toggle fires immediately after — the toggle's own optimistic
  // update (and the ref it's read from) can be overwritten by the Phase
  // change's slower, earlier-initiated refresh resolving afterward, even
  // though that refresh's own seq is otherwise unremarkable (nothing
  // newer had called refreshDraft() itself yet at that point). So every
  // handler that performs an optimistic local mutation also bumps this
  // counter synchronously, at the moment it fires — not just refreshDraft
  // — which immediately invalidates any older in-flight refresh the
  // instant a newer action begins, before that action's own round trip
  // even starts. Only the response to the MOST RECENTLY INITIATED
  // refreshDraft() OR mutation is ever applied.
  const refreshSeqRef = useRef(0);
  const invalidatePendingRefreshes = () => {
    refreshSeqRef.current++;
  };
  const [exercises, setExercises] = useState<BuilderLibraryExercise[]>(() => initialExercises.map(withDerived));
  const [filters, setFilters] = useState<LibraryFilters>(EMPTY_LIBRARY_FILTERS);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"library" | "draft">(focusTarget.workout || focusTarget.section ? "draft" : "library");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // C5.4 Revision B — multi-open dosage editors (decision #8): a plain
  // presence map, not a single id. Independent of dosageWorkingState below
  // so collapsing/expanding never touches the working values themselves.
  const [expandedDosageIds, setExpandedDosageIds] = useState<Record<string, boolean>>(() =>
    isOwner && focusTarget.exercise ? { [focusTarget.exercise.id]: true } : {}
  );
  // The lifted working-state map itself (decision #10). See this file's
  // header comment for why it must live here rather than in DosageEditor.
  const [dosageWorkingState, setDosageWorkingState] = useState<Record<string, DosageWorkingEntry>>(() => {
    const ex = isOwner ? focusTarget.exercise : null;
    if (!ex) return {};
    const savedDraft: DosageDraft = ex.dosage ?? emptyDosageDraft();
    const savedInstructions = ex.additionalInstructions ?? "";
    return { [ex.id]: { draft: savedDraft, instructions: savedInstructions, savedDraft, savedInstructions } };
  });
  const [dosageSaving, setDosageSaving] = useState<Record<string, boolean>>({});
  const [dosageSaveError, setDosageSaveError] = useState<Record<string, string | null>>({});
  // Whether an editor shows its inline validation messages — set by the
  // first save attempt (individual OR Save All), cleared by Cancel/success.
  const [dosageShowErrors, setDosageShowErrors] = useState<Record<string, boolean>>({});
  // Synchronous guards against duplicate/concurrent submissions: state
  // updates land a render later, so a fast double-click (or Save All racing
  // an individual Save) could otherwise start two saves for one exercise.
  const savingIdsRef = useRef(new Set<string>());
  const saveAllInFlightRef = useRef(false);
  const [saveAllRunning, setSaveAllRunning] = useState(false);
  const [saveAllResult, setSaveAllResult] = useState<{ saved: number; failed: { id: string; name: string; workoutLabel: string }[] } | null>(null);
  // Always-current view of the working-state map for async save code, which
  // must read each entry as it is at the moment that exercise's save starts.
  const dosageWorkingStateRef = useRef(dosageWorkingState);
  dosageWorkingStateRef.current = dosageWorkingState;
  const workoutsRef = useRef(workouts);
  workoutsRef.current = workouts;

  // ---- C5.4 Performance Pass: optimistic overlays + per-field sync ----
  // epochRef increases on every overlay change. refreshDraft() records it
  // when its read STARTS; an overlay newer than that (or still pending) is
  // re-applied to the fetched data, an older settled one is dropped (the
  // fetched data already reflects it).
  const overlaysRef = useRef(new Map<string, Overlay>());
  const epochRef = useRef(0);
  const setOverlay = (key: string, apply: Overlay["apply"], pending: boolean) => {
    overlaysRef.current.set(key, { epoch: ++epochRef.current, pending, apply });
  };
  // Keys with a request in flight — drives "Saving…" feedback.
  const [syncingKeys, setSyncingKeys] = useState<Set<string>>(() => new Set());
  const syncsRef = useRef(new Map<string, { desired: unknown; confirmed: unknown }>());
  // Pending Library adds, keyed `${workoutId}:${canonicalExerciseId}` — a
  // synchronous duplicate guard (state updates land a render later).
  const pendingAddKeysRef = useRef(new Set<string>());
  const pendingAddSeqRef = useRef(0);
  const savingWeekdayWorkoutIds = useMemo(
    () => new Set([...syncingKeys].filter((k) => k.startsWith("weekdays:")).map((k) => k.slice("weekdays:".length))),
    [syncingKeys]
  );
  const [pendingRemoveExerciseId, setPendingRemoveExerciseId] = useState<string | null>(null);

  const viewOnlyMessage =
    editingClinicianName === "Another clinician"
      ? "This prescription is currently being edited by another clinician. You can view the draft, but only the editing clinician can make changes."
      : `This prescription is currently being edited by ${editingClinicianName}. You can view the draft, but only the editing clinician can make changes.`;

  const orderedWorkouts = useMemo(() => workouts.slice().sort((a, b) => a.orderIndex - b.orderIndex), [workouts]);
  const selectedWorkout = orderedWorkouts.find((w) => w.id === selectedWorkoutId) ?? orderedWorkouts[0] ?? null;
  const otherWorkouts = orderedWorkouts.filter((w) => w.id !== selectedWorkout?.id);

  const exercisesById = useMemo(() => new Map(exercises.map((e) => [e.id, e])), [exercises]);
  const filtered = useMemo(() => filterLibraryExercises(exercises, filters), [exercises, filters]);
  const facets = useMemo(() => computeLibraryFacets(exercises), [exercises]);
  const totalDraftExercises = workouts.reduce((sum, w) => sum + w.exercises.length, 0);

  // Duplicate-prevention counts scoped to the CURRENTLY SELECTED workout
  // only (C5.4A correction, now genuinely multi-workout) — the same
  // canonical exercise remains addable to a DIFFERENT workout (C5.4C §15).
  const draftCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of selectedWorkout?.exercises ?? []) counts.set(e.canonicalExerciseId, (counts.get(e.canonicalExerciseId) ?? 0) + 1);
    return counts;
  }, [selectedWorkout]);

  const findExercise = useCallback(
    (exerciseId: string) => {
      for (const w of workouts) {
        const ex = w.exercises.find((e) => e.id === exerciseId);
        if (ex) return ex;
      }
      return null;
    },
    [workouts]
  );
  const findWorkoutLabel = (exerciseId: string) => {
    const idx = orderedWorkouts.findIndex((w) => w.exercises.some((e) => e.id === exerciseId));
    if (idx === -1) return "";
    return orderedWorkouts[idx].label || nextWorkoutLabel(idx);
  };

  // A Set purely for O(1) "does this exercise have unsaved dosage changes"
  // lookups (delete-confirmation copy — decisions #15/#16). Recomputed from
  // the working-state map, never a second source of truth.
  const dirtyExerciseIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, entry] of Object.entries(dosageWorkingState)) {
      if (isWorkingEntryDirty(entry)) ids.add(id);
    }
    return ids;
  }, [dosageWorkingState]);

  // C5.4D — bring the deep-linked exercise / schedule control into view once.
  useEffect(() => {
    const selector = focusTarget.exercise
      ? `[data-exercise-id="${focusTarget.exercise.id}"]`
      : focusTarget.section === "weekdays"
        ? '[data-testid="weekday-assignment"]'
        : focusTarget.section === "schedule"
          ? '[data-testid="scheduling-panel"]'
          : focusTarget.workout
            ? '[data-testid="workout-tabs"]'
            : null;
    if (selector) document.querySelector(selector)?.scrollIntoView({ block: "center" });
  }, [focusTarget]);

  const refreshDraft = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const startEpoch = epochRef.current;
    // no-store: this is a mutable resource refetched right after a mutation
    // — without this, the browser's own HTTP cache has been observed to
    // serve a stale response for an identical GET URL within the same
    // session, masking a just-completed rename/reorder/mode-switch.
    const res = await fetch(`/api/clinician/prescription-drafts/${draftId}`, { cache: "no-store" });
    if (!res.ok) throw new Error("Could not refresh the draft");
    const data: { draft: RawApiDraft; workouts: RawApiWorkout[]; performanceFocuses: PerformanceFocus[] } = await res.json();
    // Discard this result if a NEWER refreshDraft() OR mutation has been
    // initiated since this one started — see refreshSeqRef's declaration.
    if (seq !== refreshSeqRef.current) return;
    let fresh: FreshDraftState = {
      workouts: (data.workouts ?? []).map((w) => mapRawWorkout(w, exercisesById)).sort((a, b) => a.orderIndex - b.orderIndex),
      phase: data.draft.phase ?? null,
      targetSessionsPerWeek: data.draft.target_sessions_per_week ?? null,
      performanceFocuses: data.performanceFocuses ?? [],
    };
    for (const [key, overlay] of overlaysRef.current) {
      if (overlay.pending || overlay.epoch > startEpoch) fresh = overlay.apply(fresh);
      else overlaysRef.current.delete(key);
    }
    const enriched = fresh.workouts;
    setWorkouts(enriched);
    setSchedulingMode(data.draft.scheduling_mode ?? null);
    setPhase(fresh.phase);
    setTargetSessionsPerWeek(fresh.targetSessionsPerWeek);
    performanceFocusesRef.current = fresh.performanceFocuses;
    setPerformanceFocuses(fresh.performanceFocuses);
    setSelectedWorkoutId((cur) => (cur && enriched.some((w) => w.id === cur) ? cur : (enriched[0]?.id ?? null)));

    // C5.4 Revision B decision #10/#14 — reconcile the working-state map
    // against the freshly-fetched authoritative content WITHOUT ever
    // clobbering a dirty exercise's unsaved values. Only known (already
    // expanded-at-least-once) exercises are touched; an exercise never
    // opened this session has no entry yet (lazy init on first expand).
    const freshById = new Map(enriched.flatMap((w) => w.exercises).map((ex) => [ex.id, ex]));
    setDosageWorkingState((prev) => {
      let changed = false;
      const next: typeof prev = { ...prev };
      for (const [exerciseId, entry] of Object.entries(prev)) {
        const fresh = freshById.get(exerciseId);
        if (!fresh) continue; // exercise no longer exists (deleted elsewhere) — cleanup handled by the delete handlers themselves
        const freshDraft: DosageDraft = fresh.dosage ?? emptyDosageDraft();
        const freshInstructions = fresh.additionalInstructions ?? "";
        const dirty = isWorkingEntryDirty(entry);
        const updated: DosageWorkingEntry = dirty
          ? { ...entry, savedDraft: freshDraft, savedInstructions: freshInstructions }
          : { ...entry, draft: freshDraft, instructions: freshInstructions, savedDraft: freshDraft, savedInstructions: freshInstructions };
        next[exerciseId] = updated;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [draftId, exercisesById]);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function patchDraftMetadata(body: Record<string, unknown>, { refresh = true }: { refresh?: boolean } = {}) {
    const res = await fetch(`/api/clinician/prescription-drafts/${draftId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("Could not save scheduling changes");
    if (refresh) await refreshDraft();
  }

  // Applies `desired` locally right away and persists it with at most ONE
  // request in flight per key: clicks made while a request is in flight
  // just update `desired`, and the newest value is sent when the current
  // request returns — so rapid toggles can never land out of order and
  // persist a stale value. On failure the field rolls back to the last
  // value the server confirmed and the clinician is told; it never looks
  // saved when it is not.
  function syncLatest<T>(opts: {
    key: string;
    desired: T;
    confirmedNow: T;
    applyLocal: (value: T) => void;
    applyFresh: (s: FreshDraftState, value: T) => FreshDraftState;
    send: (value: T) => Promise<T>;
    errorMessage: string;
  }) {
    const { key, desired, applyLocal, applyFresh, send, errorMessage } = opts;
    applyLocal(desired);
    setOverlay(key, (s) => applyFresh(s, desired), true);
    const existing = syncsRef.current.get(key);
    if (existing) {
      existing.desired = desired;
      return;
    }
    const entry = { desired: desired as unknown, confirmed: opts.confirmedNow as unknown };
    syncsRef.current.set(key, entry);
    setSyncingKeys((prev) => new Set(prev).add(key));
    void (async () => {
      try {
        for (;;) {
          const sending = entry.desired as T;
          const saved = await send(sending);
          entry.confirmed = saved;
          if (sameValue(entry.desired, sending)) {
            syncsRef.current.delete(key);
            applyLocal(saved);
            setOverlay(key, (s) => applyFresh(s, saved), false);
            break;
          }
        }
      } catch {
        syncsRef.current.delete(key);
        const confirmed = entry.confirmed as T;
        applyLocal(confirmed);
        setOverlay(key, (s) => applyFresh(s, confirmed), false);
        setActionError(errorMessage);
      } finally {
        setSyncingKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    })();
  }

  // Adding an exercise ONLY establishes draft membership + order — never
  // invents dosage, never copies reference dosage. Targets the CURRENTLY
  // SELECTED workout (C5.4C §15); creates the first workout ("Workout A")
  // lazily if the draft has none yet.
  //
  // C5.4 Performance Pass — when the workout already exists (the normal
  // case) the exercise appears immediately as a clearly PENDING row (not
  // editable, movable, removable or draggable) built from the canonical
  // exercise we already have locally; the POST's returned id then turns it
  // into the persisted row with no full-draft re-read. On failure the
  // pending row is removed and the clinician is told — nothing ghost is
  // left behind. order_index is max+1 (not exercises.length) because
  // Move/remove leave gaps and UNIQUE(workout, order_index) must hold even
  // for back-to-back adds.
  const handleAdd = (canonicalExerciseId: string) => {
    if (!isOwner) return;
    if ((draftCounts.get(canonicalExerciseId) ?? 0) > 0) return;
    const workout = selectedWorkout ? workoutsRef.current.find((w) => w.id === selectedWorkout.id) : undefined;
    if (!workout) {
      invalidatePendingRefreshes();
      void withBusy(async () => {
        const res = await fetch(`/api/clinician/prescription-drafts/${draftId}/workouts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderIndex: 0, label: nextWorkoutLabel(0) }),
        });
        if (!res.ok) throw new Error("Could not create the initial workout");
        const body: { workoutId: string } = await res.json();
        setSelectedWorkoutId(body.workoutId);
        const addRes = await fetch(`/api/clinician/prescription-workouts/${body.workoutId}/exercises`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ canonicalExerciseId, orderIndex: 0 }),
        });
        if (!addRes.ok) throw new Error("Could not add exercise to draft");
        await refreshDraft();
      });
      return;
    }
    const guardKey = `${workout.id}:${canonicalExerciseId}`;
    if (pendingAddKeysRef.current.has(guardKey) || workout.exercises.some((e) => e.canonicalExerciseId === canonicalExerciseId)) return;
    pendingAddKeysRef.current.add(guardKey);
    setActionError(null);

    const meta = exercisesById.get(canonicalExerciseId);
    const exerciseName = meta?.name ?? "Unknown exercise";
    const orderIndex = workout.exercises.reduce((max, e) => Math.max(max, e.orderIndex), -1) + 1;
    // A page-local counter, not crypto.randomUUID(): that API only exists in
    // secure contexts, and the builder is also opened over plain-http LAN
    // addresses during device testing.
    const tempId = `${PENDING_ID_PREFIX}${++pendingAddSeqRef.current}`;
    const pendingRow: BuilderDraftExercise = {
      id: tempId,
      canonicalExerciseId,
      orderIndex,
      status: "active",
      exerciseName,
      loadingProfile: meta?.loadingProfile ?? null,
      dosageConfigured: false,
      dosage: null,
      additionalInstructions: null,
      pending: true,
    };
    // Adds `row` to the workout unless that canonical exercise is already
    // there (e.g. a refresh already brought back the persisted row).
    const ensureRow = (ws: BuilderDraftWorkout[], row: BuilderDraftExercise) =>
      ws.map((w) => (w.id === workout.id && !w.exercises.some((e) => e.canonicalExerciseId === canonicalExerciseId) ? { ...w, exercises: [...w.exercises, row] } : w));
    const removeTemp = (ws: BuilderDraftWorkout[]) => ws.map((w) => (w.id === workout.id ? { ...w, exercises: w.exercises.filter((e) => e.id !== tempId) } : w));
    const overlayKey = `add:${tempId}`;

    setWorkouts((prev) => ensureRow(prev, pendingRow));
    setOverlay(overlayKey, (st) => ({ ...st, workouts: ensureRow(st.workouts, pendingRow) }), true);

    void (async () => {
      let reachedServer = false;
      try {
        const addRes = await fetch(`/api/clinician/prescription-workouts/${workout.id}/exercises`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ canonicalExerciseId, orderIndex }),
        });
        reachedServer = true;
        if (!addRes.ok) throw new Error("rejected");
        const { exerciseId }: { exerciseId: string } = await addRes.json();
        const persisted: BuilderDraftExercise = { ...pendingRow, id: exerciseId, pending: false };
        const settle = (ws: BuilderDraftWorkout[]) => ensureRow(removeTemp(ws), persisted);
        setWorkouts((prev) => settle(prev));
        setOverlay(overlayKey, (st) => ({ ...st, workouts: settle(st.workouts) }), false);
      } catch {
        overlaysRef.current.delete(overlayKey);
        setWorkouts((prev) => removeTemp(prev));
        if (reachedServer) {
          setActionError(`Could not add ${exerciseName} to the draft. It was not saved — please try again.`);
        } else {
          // A network failure is ambiguous (the insert may have committed):
          // re-read the authoritative draft rather than guess.
          setActionError(`Could not confirm ${exerciseName} was added. The draft has been reloaded to show what was saved.`);
          void refreshDraft().catch(() => {});
        }
      } finally {
        pendingAddKeysRef.current.delete(guardKey);
      }
    })();
  };

  // C5.4 Revision B decision #15 — removing an exercise with unsaved dosage
  // changes requires an explicit warning (owned by DraftPanel's per-row
  // confirm UI, gated on dirtyExerciseIds); a clean exercise still removes
  // immediately, unchanged from C5.4A/B. Either way, once the delete
  // actually succeeds, its working-state/expanded-state entries are always
  // discarded here — no orphan client state survives a deleted exercise.
  const handleRemove = (exerciseId: string) => {
    if (!isOwner) return;
    invalidatePendingRefreshes();
    void withBusy(async () => {
      const res = await fetch(`/api/clinician/prescription-exercises/${exerciseId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not remove exercise");
      setDosageWorkingState((prev) => {
        if (!(exerciseId in prev)) return prev;
        const next = { ...prev };
        delete next[exerciseId];
        return next;
      });
      setExpandedDosageIds((prev) => {
        if (!(exerciseId in prev)) return prev;
        const next = { ...prev };
        delete next[exerciseId];
        return next;
      });
      await refreshDraft();
    });
  };

  // C5.4 Revision C, Part 5/11 — drag-and-drop replaces the old up/down
  // buttons. dnd-kit hands us the FULL new order for the dragged exercise's
  // workout (computed via arrayMove in DraftPanel), not just a swap pair.
  // Applied OPTIMISTICALLY (setWorkouts before the request) so the dropped
  // card doesn't visually snap back while the request is in flight — but
  // only ever the exercises ARRAY ORDER of one workout changes here; nothing
  // keyed by exerciseId (dosageWorkingState, expandedDosageIds) is touched,
  // which is exactly why a drag can never disturb unsaved dosage or which
  // editors are open (Parts 9-10), with no reconciliation needed. If the
  // server rejects the reorder, we roll back to the exact pre-drag snapshot
  // — never a silent lie about what was actually saved — and surface the
  // error via the normal actionError path (Part 11).
  const handleReorderExercises = (workoutId: string, orderedExerciseIds: string[]) => {
    if (!isOwner) return;
    const workout = workouts.find((w) => w.id === workoutId);
    if (!workout) return;
    const previousExercises = workout.exercises;
    const byId = new Map(previousExercises.map((e) => [e.id, e]));
    const reordered = orderedExerciseIds.map((id) => byId.get(id)).filter((e): e is (typeof previousExercises)[number] => !!e);
    if (reordered.length !== previousExercises.length) return; // stale/incomplete id list — refuse rather than silently drop an exercise
    // A pending (not yet persisted) Add has no server id to reorder by;
    // DraftPanel disables dragging while one exists, this is the backstop.
    if (orderedExerciseIds.some((id) => id.startsWith(PENDING_ID_PREFIX))) return;
    invalidatePendingRefreshes();
    setWorkouts((prev) => prev.map((w) => (w.id === workoutId ? { ...w, exercises: reordered } : w)));
    void withBusy(async () => {
      try {
        const res = await fetch(`/api/clinician/prescription-workouts/${workoutId}/exercises/reorder`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderedExerciseIds }),
        });
        if (!res.ok) throw new Error("Could not save the new exercise order. The previous order has been restored.");
        await refreshDraft();
      } catch (e) {
        setWorkouts((prev) => prev.map((w) => (w.id === workoutId ? { ...w, exercises: previousExercises } : w)));
        throw e;
      }
    });
  };

  // C5.4C §14 — move an exercise to a different workout. Server rejects a
  // same-canonical-exercise collision in the target (EXERCISE_UNAVAILABLE);
  // surfaced here as a plain readable message, never a silent merge.
  // C5.4 Revision B decision #13 — deliberately NO working-state/expanded-
  // state changes here: both maps are keyed by prescriptionExerciseId,
  // which the move never changes, so unsaved dosage survives a move for
  // free. The move succeeds/fails independently of whether dosage has ever
  // been saved for this exercise.
  const handleMoveToWorkout = (exerciseId: string, targetWorkoutId: string) => {
    if (!isOwner) return;
    invalidatePendingRefreshes();
    void withBusy(async () => {
      const res = await fetch(`/api/clinician/prescription-exercises/${exerciseId}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetWorkoutId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(body.error === "EXERCISE_UNAVAILABLE" ? "That exercise already exists in the target workout." : "Could not move exercise.");
      }
      await refreshDraft();
    });
  };

  // C5.4C §10 — up to the UI cap of 3; appends at the end; default label
  // follows the A/B/C sequence based on current count.
  const handleAddWorkout = () => {
    if (!isOwner || orderedWorkouts.length >= WORKOUT_MAX) return;
    invalidatePendingRefreshes();
    void withBusy(async () => {
      const res = await fetch(`/api/clinician/prescription-drafts/${draftId}/workouts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIndex: orderedWorkouts.length, label: nextWorkoutLabel(orderedWorkouts.length) }),
      });
      if (!res.ok) throw new Error("Could not add workout");
      const body: { workoutId: string } = await res.json();
      await refreshDraft();
      setSelectedWorkoutId(body.workoutId);
    });
  };

  const handleRenameWorkout = (workoutId: string, label: string) => {
    if (!isOwner) return;
    invalidatePendingRefreshes();
    void withBusy(async () => {
      const res = await fetch(`/api/clinician/prescription-workouts/${workoutId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) throw new Error("Could not rename workout");
      await refreshDraft();
    });
  };

  const handleReorderWorkout = (workoutId: string, direction: "left" | "right") => {
    if (!isOwner) return;
    const idx = orderedWorkouts.findIndex((w) => w.id === workoutId);
    const swapWith = direction === "left" ? idx - 1 : idx + 1;
    if (idx === -1 || swapWith < 0 || swapWith >= orderedWorkouts.length) return;
    const orderedIds = orderedWorkouts.map((w) => w.id);
    [orderedIds[idx], orderedIds[swapWith]] = [orderedIds[swapWith], orderedIds[idx]];
    invalidatePendingRefreshes();
    void withBusy(async () => {
      const res = await fetch(`/api/clinician/prescription-drafts/${draftId}/workouts/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedWorkoutIds: orderedIds }),
      });
      if (!res.ok) throw new Error("Could not reorder workouts");
      await refreshDraft();
    });
  };

  // C5.4C §13 — WorkoutTabs owns the confirmation UX; by the time this is
  // called the clinician has already explicitly confirmed (including, per
  // C5.4 Revision B decision #16, having been warned if any exercise inside
  // carried unsaved dosage changes). The DB cascade (exercises + dosage) is
  // real and intentional here, never silent. Every deleted exercise's
  // working-state/expanded-state entries are discarded — no orphan client
  // state survives a deleted workout.
  const handleDeleteWorkout = (workoutId: string) => {
    if (!isOwner) return;
    const workout = workouts.find((w) => w.id === workoutId);
    const removedExerciseIds = workout?.exercises.map((e) => e.id) ?? [];
    invalidatePendingRefreshes();
    void withBusy(async () => {
      const res = await fetch(`/api/clinician/prescription-workouts/${workoutId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not delete workout");
      if (removedExerciseIds.length > 0) {
        setDosageWorkingState((prev) => {
          const next = { ...prev };
          for (const id of removedExerciseIds) delete next[id];
          return next;
        });
        setExpandedDosageIds((prev) => {
          const next = { ...prev };
          for (const id of removedExerciseIds) delete next[id];
          return next;
        });
      }
      await refreshDraft();
    });
  };

  // C5.4C §19 — weekday toggle for the given workout. Client-side already
  // disables days owned by another workout (WorkoutTabs), this only ever
  // fires for a day the selected workout can legitimately claim; the server
  // still rejects a day claimed elsewhere at mutation time (updateWorkout)
  // and validate_prescription_draft remains the publish-time authority.
  //
  // C5.4 Performance Pass — the day flips immediately; persistence runs
  // through syncLatest() (latest-wins per workout, rollback + error on
  // failure) and reconciles against the PATCH's returned row, with no
  // full-draft re-read and no global busy lock, so Mon/Wed/Fri can be
  // clicked in quick succession.
  const handleWeekdayToggle = (workoutId: string, day: number) => {
    if (!isOwner) return;
    const workout = workoutsRef.current.find((w) => w.id === workoutId);
    if (!workout) return;
    const current = workout.daysOfWeek ?? [];
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort((a, b) => a - b);
    setActionError(null);
    syncLatest<number[] | null>({
      key: `weekdays:${workoutId}`,
      desired: next,
      confirmedNow: workout.daysOfWeek ?? null,
      applyLocal: (days) => setWorkouts((prev) => withWorkoutDays(prev, workoutId, days)),
      applyFresh: (st, days) => ({ ...st, workouts: withWorkoutDays(st.workouts, workoutId, days) }),
      send: async (days) => {
        const res = await fetch(`/api/clinician/prescription-workouts/${workoutId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ daysOfWeek: days }),
        });
        if (!res.ok) throw new Error("weekday save failed");
        const body: { workout: { daysOfWeek: number[] | null } } = await res.json();
        return body.workout.daysOfWeek;
      },
      errorMessage: "Could not save the weekday assignment. It has been restored to the last saved days — please try again.",
    });
  };

  // Scheduling/informational metadata — all via the existing draft PATCH
  // route; server-side mode-switch cleanup (clearing days_of_week or
  // target_sessions_per_week) happens authoritatively inside
  // updateDraftMetadata(), never here.
  //
  // C5.4 Performance Pass — the mode switch shows immediately but still
  // re-reads the draft afterwards, because the server-side cleanup it
  // triggers is only knowable from the server; on failure it reverts.
  const handleSchedulingModeChange = (mode: SchedulingMode) => {
    if (!isOwner || [...syncsRef.current.keys()].some((k) => k.startsWith("weekdays:"))) return;
    const previous = schedulingMode;
    invalidatePendingRefreshes();
    setSchedulingMode(mode);
    void withBusy(async () => {
      try {
        await patchDraftMetadata({ schedulingMode: mode });
      } catch (e) {
        setSchedulingMode(previous);
        throw e;
      }
    });
  };
  // Phase, target sessions/week and Performance Focus write only their own
  // field (no server-side derived changes), so they reconcile from the
  // PATCH's success alone — no full-draft re-read.
  const metadataSender =
    <T,>(field: string) =>
    async (value: T): Promise<T> => {
      await patchDraftMetadata({ [field]: value }, { refresh: false });
      return value;
    };
  const handleTargetSessionsChange = (n: number | null) => {
    if (!isOwner) return;
    setActionError(null);
    syncLatest<number | null>({
      key: "targetSessionsPerWeek",
      desired: n,
      confirmedNow: targetSessionsPerWeek,
      applyLocal: setTargetSessionsPerWeek,
      applyFresh: (st, v) => ({ ...st, targetSessionsPerWeek: v }),
      send: metadataSender<number | null>("targetSessionsPerWeek"),
      errorMessage: "Could not save the target sessions per week. It has been restored to the last saved value.",
    });
  };
  const handlePhaseChange = (nextPhase: RehabPhase | null) => {
    if (!isOwner) return;
    setActionError(null);
    syncLatest<RehabPhase | null>({
      key: "phase",
      desired: nextPhase,
      confirmedNow: phase,
      applyLocal: setPhase,
      applyFresh: (st, v) => ({ ...st, phase: v }),
      send: metadataSender<RehabPhase | null>("phase"),
      errorMessage: "Could not save the phase. It has been restored to the last saved value.",
    });
  };
  const handlePerformanceFocusToggle = (focus: PerformanceFocus) => {
    if (!isOwner) return;
    const current = performanceFocusesRef.current;
    const next = current.includes(focus) ? current.filter((f) => f !== focus) : [...current, focus];
    setActionError(null);
    syncLatest<PerformanceFocus[]>({
      key: "performanceFocuses",
      desired: next,
      confirmedNow: current,
      applyLocal: (v) => {
        performanceFocusesRef.current = v;
        setPerformanceFocuses(v);
      },
      applyFresh: (st, v) => ({ ...st, performanceFocuses: v }),
      send: metadataSender<PerformanceFocus[]>("performanceFocuses"),
      errorMessage: "Could not save the Performance Focus selection. It has been restored to the last saved selection.",
    });
  };

  const handleToggleFavorite = (exerciseId: string, next: boolean) => {
    setExercises((prev) => prev.map((e) => (e.id === exerciseId ? { ...e, isFavorite: next } : e)));
    void (async () => {
      const res = await fetch(`/api/clinician/library/exercises/${exerciseId}/favorite`, { method: next ? "POST" : "DELETE" });
      if (!res.ok) setExercises((prev) => prev.map((e) => (e.id === exerciseId ? { ...e, isFavorite: !next } : e)));
    })();
  };

  // ---------------------------------------------------------------------
  // C5.4 Revision B — dosage authoring. Multi-open (decision #8) + lifted
  // working state (decision #10). ensureWorkingEntry lazily initializes an
  // exercise's entry the FIRST time it is expanded (from its currently
  // persisted dosage, or an empty draft for a never-dosed exercise) —
  // exercises never opened this session carry no entry at all, so this
  // never does O(all exercises) work up front.
  // ---------------------------------------------------------------------
  const ensureWorkingEntry = useCallback(
    (exerciseId: string) => {
      setDosageWorkingState((prev) => {
        if (prev[exerciseId]) return prev;
        const ex = findExercise(exerciseId);
        const savedDraft: DosageDraft = ex?.dosage ?? emptyDosageDraft();
        const savedInstructions = ex?.additionalInstructions ?? "";
        return { ...prev, [exerciseId]: { draft: savedDraft, instructions: savedInstructions, savedDraft, savedInstructions } };
      });
    },
    [findExercise]
  );

  const handleToggleDosageExpand = (exerciseId: string) => {
    if (!isOwner) return;
    ensureWorkingEntry(exerciseId);
    setExpandedDosageIds((prev) => ({ ...prev, [exerciseId]: !prev[exerciseId] }));
  };

  const handleDosageDraftChange = (exerciseId: string, patch: Partial<DosageDraft>) => {
    setDosageWorkingState((prev) => {
      const entry = prev[exerciseId];
      if (!entry) return prev;
      return { ...prev, [exerciseId]: { ...entry, draft: { ...entry.draft, ...patch } } };
    });
  };

  const handleDosageInstructionsChange = (exerciseId: string, value: string) => {
    setDosageWorkingState((prev) => {
      const entry = prev[exerciseId];
      if (!entry) return prev;
      return { ...prev, [exerciseId]: { ...entry, instructions: value } };
    });
  };

  // C5.4 Revision B decision #12 — Cancel discards unsaved changes and
  // restores the last-SAVED dosage (never deletes it), then closes the
  // editor. Collapsing (handleToggleDosageExpand) never calls this.
  const handleCancelDosage = (exerciseId: string) => {
    setDosageWorkingState((prev) => {
      const entry = prev[exerciseId];
      if (!entry) return prev;
      return { ...prev, [exerciseId]: { ...entry, draft: entry.savedDraft, instructions: entry.savedInstructions } };
    });
    setDosageSaveError((prev) => ({ ...prev, [exerciseId]: null }));
    setDosageShowErrors((prev) => ({ ...prev, [exerciseId]: false }));
    setExpandedDosageIds((prev) => ({ ...prev, [exerciseId]: false }));
  };

  // C5.4 Performance Pass — record a server-confirmed dosage/instructions on
  // the exercise itself (what the collapsed summary and later saves read),
  // instead of re-reading the whole draft after every save. Registered as
  // an overlay so an unrelated in-flight refresh can't revert it.
  const applyPersistedExercise = (exerciseId: string, fields: { dosage?: DosageInput; additionalInstructions?: string | null }) => {
    const patchWorkouts = (ws: BuilderDraftWorkout[]) =>
      ws.map((w) =>
        w.exercises.some((e) => e.id === exerciseId)
          ? {
              ...w,
              exercises: w.exercises.map((e) =>
                e.id === exerciseId
                  ? {
                      ...e,
                      ...(fields.dosage !== undefined ? { dosage: fields.dosage, dosageConfigured: true } : {}),
                      ...(fields.additionalInstructions !== undefined ? { additionalInstructions: fields.additionalInstructions } : {}),
                    }
                  : e
              ),
            }
          : w
      );
    setWorkouts(patchWorkouts);
    const key = `exercise:${exerciseId}`;
    const previous = overlaysRef.current.get(key);
    setOverlay(key, (st) => ({ ...st, workouts: patchWorkouts(previous ? previous.apply(st).workouts : st.workouts) }), false);
  };

  // C5.4 Revision B decision #11/#23 — explicit Save only, no autosave.
  // The ONE dosage-save path, shared by an individual "Save dosage" and by
  // "Save all dosing". Validates with the same validateDosageInput() the
  // server runs; dosage_type is derived client-side purely so the payload
  // is well-typed (the server re-derives it authoritatively, and its
  // response is what reconciles savedDraft). Does NOT refresh the draft —
  // callers do that once, so Save All refreshes once rather than per row.
  //
  // Revision E: on success the editor COLLAPSES to the saved-prescription
  // card. On any failure (validation, dosage PUT, instructions PATCH,
  // network) the editor is kept/forced OPEN with the working draft
  // untouched and the error shown, so nothing entered is lost and a failed
  // exercise never looks saved. Returns whether the save fully succeeded.
  //
  // Only what actually changed is written: the dosage PUT is skipped when
  // the dosage already exists and is unchanged (an instructions-only edit),
  // and the instructions PATCH is skipped when instructions are unchanged.
  const saveDosageEntry = async (exerciseId: string): Promise<boolean> => {
    const entry = dosageWorkingStateRef.current[exerciseId];
    if (!entry || savingIdsRef.current.has(exerciseId)) return false;

    const fail = (message: string | null) => {
      setDosageSaveError((prev) => ({ ...prev, [exerciseId]: message }));
      setDosageShowErrors((prev) => ({ ...prev, [exerciseId]: true }));
      setExpandedDosageIds((prev) => ({ ...prev, [exerciseId]: true }));
      return false;
    };

    const validationErrors = validateDosageInput(entry.draft);
    if (validationErrors.length > 0) return fail("Fix the highlighted dosage values before saving.");

    // Captured at save-START so the success handler can tell whether the
    // clinician has ALREADY made a further edit by the time the round trip
    // resolves — a real, reachable race: click Save, then immediately change
    // another field on the SAME exercise before the requests complete.
    // Blindly setting draft = savedDraft (and collapsing) would silently
    // wipe that newer edit out from under the clinician.
    const draftAtSaveStart = entry.draft;
    const instructionsAtSaveStart = entry.instructions;
    const hasPersistedDosage = findExercise(exerciseId)?.dosage != null || entry.savedDraft.dosageType != null;
    const dosageChanged = !hasPersistedDosage || !dosageDraftsEqual(entry.draft, entry.savedDraft);
    const trimmedInstructions = entry.instructions.trim().length > 0 ? entry.instructions.trim() : null;
    const instructionsChanged = (trimmedInstructions ?? "") !== entry.savedInstructions;

    savingIdsRef.current.add(exerciseId);
    setDosageSaving((prev) => ({ ...prev, [exerciseId]: true }));
    setDosageSaveError((prev) => ({ ...prev, [exerciseId]: null }));
    try {
      let savedDraft: DosageDraft = entry.savedDraft;
      if (dosageChanged) {
        const dosageType = deriveDosageType(entry.draft, entry.savedDraft.dosageType);
        const payload: DosageInput = { ...entry.draft, dosageType } as DosageInput;
        const dosageRes = await fetch(`/api/clinician/prescription-exercises/${exerciseId}/dosage`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dosage: payload }),
        });
        if (!dosageRes.ok) {
          const body = await dosageRes.json().catch(() => ({}) as { details?: { fieldErrors?: { message: string }[] } });
          const firstFieldError = body?.details?.fieldErrors?.[0]?.message;
          return fail(firstFieldError ?? "This dosage could not be saved. Please check the values and try again.");
        }
        const savedBody: { dosage: DosageInput } = await dosageRes.json();
        savedDraft = savedBody.dosage;
      }
      if (instructionsChanged) {
        const instrRes = await fetch(`/api/clinician/prescription-exercises/${exerciseId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ additionalInstructions: trimmedInstructions }),
        });
        if (!instrRes.ok) {
          // The dosage half DID persist — record it as the new baseline so
          // the row honestly reflects what is saved, but keep the editor
          // open and dirty (instructions still differ) with the error shown.
          if (dosageChanged) {
            setDosageWorkingState((prev) => (prev[exerciseId] ? { ...prev, [exerciseId]: { ...prev[exerciseId], savedDraft } } : prev));
            applyPersistedExercise(exerciseId, { dosage: savedDraft as DosageInput });
          }
          return fail("Dosage saved, but instructions could not be saved. Please try again.");
        }
      }
      const savedInstructions = trimmedInstructions ?? "";
      // Only replace the WORKING draft/instructions with the saved snapshot
      // (and collapse) if nothing changed since this save started —
      // otherwise update just the saved baseline and leave the clinician's
      // newer, still-unsaved edits open exactly as they are.
      const isUnchanged = (cur: DosageWorkingEntry) => dosageDraftsEqual(cur.draft, draftAtSaveStart) && cur.instructions === instructionsAtSaveStart;
      const latest = dosageWorkingStateRef.current[exerciseId];
      setDosageWorkingState((prev) => {
        const cur = prev[exerciseId];
        if (!cur) return prev;
        return { ...prev, [exerciseId]: isUnchanged(cur) ? { draft: savedDraft, instructions: savedInstructions, savedDraft, savedInstructions } : { ...cur, savedDraft, savedInstructions } };
      });
      setDosageShowErrors((prev) => ({ ...prev, [exerciseId]: false }));
      applyPersistedExercise(exerciseId, {
        ...(dosageChanged ? { dosage: savedDraft as DosageInput } : {}),
        ...(instructionsChanged ? { additionalInstructions: trimmedInstructions } : {}),
      });
      if (!latest || isUnchanged(latest)) setExpandedDosageIds((prev) => ({ ...prev, [exerciseId]: false }));
      return true;
    } catch {
      return fail("Something went wrong. Please try again.");
    } finally {
      savingIdsRef.current.delete(exerciseId);
      setDosageSaving((prev) => ({ ...prev, [exerciseId]: false }));
    }
  };

  const handleSaveDosage = (exerciseId: string) => {
    if (!isOwner || saveAllInFlightRef.current) return;
    void (async () => {
      // The save reconciles from its own responses (applyPersistedExercise)
      // — no full-draft re-read (C5.4 Performance Pass).
      await saveDosageEntry(exerciseId);
    })();
  };

  // C5.4 Revision E — "Save all dosing". Saves ONLY dirty exercises (any
  // workout in this draft, expanded or not), sequentially through
  // saveDosageEntry() — one exercise's failure never stops the rest, and
  // never makes that exercise look saved: it stays open with its working
  // values and error. Draft-only: this never publishes (C5.3 publish
  // semantics are untouched).
  //
  // C5.4 Performance Pass — different exercises' saves are independent rows,
  // so they run with bounded concurrency (one exercise is still never saved
  // twice at once — saveDosageEntry's own guard), and each reconciles from
  // its own responses instead of a trailing full-draft re-read.
  const handleSaveAllDosing = () => {
    if (!isOwner || saveAllInFlightRef.current) return;
    const ids = Object.keys(dosageWorkingStateRef.current).filter(
      (id) => isWorkingEntryDirty(dosageWorkingStateRef.current[id]) && !savingIdsRef.current.has(id) && findExercise(id) !== null
    );
    if (ids.length === 0) return;
    saveAllInFlightRef.current = true;
    setSaveAllRunning(true);
    setSaveAllResult(null);
    void (async () => {
      let saved = 0;
      const failed: { id: string; name: string; workoutLabel: string }[] = [];
      const outcomes: boolean[] = new Array(ids.length);
      try {
        let next = 0;
        const worker = async () => {
          while (next < ids.length) {
            const i = next++;
            outcomes[i] = await saveDosageEntry(ids[i]);
          }
        };
        await Promise.all(Array.from({ length: Math.min(SAVE_ALL_CONCURRENCY, ids.length) }, worker));
        ids.forEach((id, i) => {
          if (outcomes[i]) saved++;
          else failed.push({ id, name: findExercise(id)?.exerciseName ?? "Exercise", workoutLabel: findWorkoutLabel(id) });
        });
      } finally {
        saveAllInFlightRef.current = false;
        setSaveAllRunning(false);
        setSaveAllResult({ saved, failed });
      }
    })();
  };

  // C5.4D — Review shows only SAVED draft content, and leaving the builder
  // drops unsaved working state, so Review is held back (never auto-saved)
  // until every edit has actually reached the server. The reason is carried
  // on the control itself (title/aria), never as an extra line: `busy`
  // toggles during reorders, and any header height change would shift the
  // list under an in-progress dnd-kit keyboard drag.
  const hasPendingAdds = workouts.some((w) => w.exercises.some((e) => e.pending));
  const reviewBlockedReason = !isOwner
    ? null
    : dirtyExerciseIds.size > 0
      ? `Save or cancel ${dirtyExerciseIds.size} unsaved ${dirtyExerciseIds.size === 1 ? "dosage" : "dosages"} before reviewing.`
      : saveAllRunning || syncingKeys.size > 0 || hasPendingAdds || busy
        ? "Saving changes…"
        : null;

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between shrink-0">
        <span className="text-xl font-bold text-brand-600">TenoTrainer</span>
        <Link href={`/clinician/patients/${patientId}/prescription`} className="text-sm text-gray-600 hover:text-brand-600 font-medium">
          ← Prescription overview
        </Link>
      </nav>

      {!isOwner && <div className="bg-amber-50 border-b border-amber-200 text-amber-800 text-sm px-6 py-2 shrink-0">{viewOnlyMessage}</div>}
      {actionError && <div className="bg-red-50 border-b border-red-200 text-red-700 text-sm px-6 py-2 shrink-0">{actionError}</div>}

      <div className="md:hidden flex border-b border-gray-200 bg-white shrink-0">
        <button
          onClick={() => setMobileTab("library")}
          className={mobileTab === "library" ? "flex-1 py-2 text-sm font-medium text-brand-600 border-b-2 border-brand-600" : "flex-1 py-2 text-sm font-medium text-gray-500"}
        >
          Library
        </button>
        <button
          onClick={() => setMobileTab("draft")}
          className={mobileTab === "draft" ? "flex-1 py-2 text-sm font-medium text-brand-600 border-b-2 border-brand-600" : "flex-1 py-2 text-sm font-medium text-gray-500"}
        >
          Draft ({totalDraftExercises})
        </button>
      </div>

      <div className="flex-1 min-h-0 grid md:grid-cols-[45fr_55fr]">
        <div className={`${mobileTab === "library" ? "block" : "hidden"} md:block overflow-y-auto border-r border-gray-200 p-4`} data-testid="library-panel">
          <LibraryPanel
            exercises={filtered}
            facets={facets}
            filters={filters}
            onFiltersChange={setFilters}
            draftCounts={draftCounts}
            expandedId={expandedId}
            onToggleExpand={(id) => setExpandedId((cur) => (cur === id ? null : id))}
            onAdd={handleAdd}
            onToggleFavorite={handleToggleFavorite}
            canAdd={isOwner}
            busy={busy}
          />
        </div>
        <div className={`${mobileTab === "draft" ? "block" : "hidden"} md:block overflow-y-auto p-4 space-y-4`} data-testid="draft-panel">
          {/* Sticky so "Save all dosing" stays reachable while scrolling a
              long workout. Hidden entirely for a view-only clinician. */}
          <div className="sticky top-0 z-20 -mx-4 -mt-4 px-4 pt-4 pb-2 bg-gray-50/95 backdrop-blur-sm space-y-2" data-testid="draft-header">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Prescription Draft</h2>
              <div className="flex flex-wrap items-center gap-2">
                <ReviewEntry patientId={patientId} blockedReason={reviewBlockedReason} />
                {isOwner && (
                  <div className="flex items-center gap-2">
                    {dirtyExerciseIds.size > 0 && !saveAllRunning && (
                      <span className="text-xs font-medium text-amber-700" data-testid="save-all-dirty-count">
                        {dirtyExerciseIds.size} unsaved {dirtyExerciseIds.size === 1 ? "dosage" : "dosages"}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={handleSaveAllDosing}
                      disabled={saveAllRunning || dirtyExerciseIds.size === 0}
                      data-testid="save-all-dosing"
                      title={dirtyExerciseIds.size === 0 ? "No unsaved dosage changes" : "Save every exercise with unsaved dosage changes in this draft"}
                      className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:bg-gray-200 disabled:text-gray-500 disabled:cursor-not-allowed"
                    >
                      {saveAllRunning ? "Saving dosing…" : "Save all dosing"}
                    </button>
                  </div>
                )}
              </div>
            </div>
            {isOwner && saveAllResult && <SaveAllResultBanner result={saveAllResult} dirtyExerciseIds={dirtyExerciseIds} onDismiss={() => setSaveAllResult(null)} />}
          </div>

          <SchedulingPanel
            schedulingMode={schedulingMode}
            targetSessionsPerWeek={targetSessionsPerWeek}
            phase={phase}
            performanceFocuses={performanceFocuses}
            workouts={orderedWorkouts}
            isOwner={isOwner}
            modeChangeLocked={savingWeekdayWorkoutIds.size > 0}
            onSchedulingModeChange={handleSchedulingModeChange}
            onTargetSessionsChange={handleTargetSessionsChange}
            onPhaseChange={handlePhaseChange}
            onPerformanceFocusToggle={handlePerformanceFocusToggle}
          />

          <WorkoutTabs
            workouts={orderedWorkouts}
            selectedWorkoutId={selectedWorkout?.id ?? null}
            isOwner={isOwner}
            schedulingMode={schedulingMode}
            busy={busy}
            dirtyExerciseIds={dirtyExerciseIds}
            savingWeekdayWorkoutIds={savingWeekdayWorkoutIds}
            onSelect={setSelectedWorkoutId}
            onAdd={handleAddWorkout}
            onRename={handleRenameWorkout}
            onReorder={handleReorderWorkout}
            onDelete={handleDeleteWorkout}
            onWeekdayToggle={handleWeekdayToggle}
          />

          <DraftPanel
            selectedWorkout={selectedWorkout}
            otherWorkouts={otherWorkouts}
            isOwner={isOwner}
            onRemove={handleRemove}
            onReorderExercises={handleReorderExercises}
            onMoveToWorkout={handleMoveToWorkout}
            busy={busy}
            exercisesById={exercisesById}
            expandedDosageIds={expandedDosageIds}
            dosageWorkingState={dosageWorkingState}
            dosageSaving={dosageSaving}
            dosageSaveError={dosageSaveError}
            pendingRemoveExerciseId={pendingRemoveExerciseId}
            onSetPendingRemoveExerciseId={setPendingRemoveExerciseId}
            dosageShowErrors={dosageShowErrors}
            saveAllRunning={saveAllRunning}
            onToggleDosageExpand={handleToggleDosageExpand}
            onDosageDraftChange={handleDosageDraftChange}
            onDosageInstructionsChange={handleDosageInstructionsChange}
            onSaveDosage={handleSaveDosage}
            onCancelDosage={handleCancelDosage}
          />
        </div>
      </div>
    </div>
  );
}

// C5.4 Revision E — outcome of the last "Save all dosing". A failed exercise
// is named (with its workout, since it may not be in the selected one) and
// only listed while it is still unsaved, so the banner never lingers about
// an exercise the clinician has since fixed and saved individually.
function SaveAllResultBanner({
  result,
  dirtyExerciseIds,
  onDismiss,
}: {
  result: { saved: number; failed: { id: string; name: string; workoutLabel: string }[] };
  dirtyExerciseIds: Set<string>;
  onDismiss: () => void;
}) {
  const stillFailed = result.failed.filter((f) => dirtyExerciseIds.has(f.id));
  const savedText = `Saved ${result.saved} ${result.saved === 1 ? "dosage" : "dosages"} to the draft.`;
  if (stillFailed.length === 0) {
    return (
      <div className="flex items-start justify-between gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800" role="status" data-testid="save-all-result" data-outcome="success">
        <span>{savedText}</span>
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="text-green-700 hover:text-green-900 leading-none">
          ×
        </button>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 space-y-1" role="alert" data-testid="save-all-result" data-outcome={result.saved > 0 ? "partial" : "failure"}>
      <div className="flex items-start justify-between gap-2">
        <span>
          {result.saved > 0 && <>{savedText} </>}
          <strong>
            {stillFailed.length} {stillFailed.length === 1 ? "exercise was" : "exercises were"} not saved
          </strong>{" "}
          — still open with your changes kept:
        </span>
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="text-red-700 hover:text-red-900 leading-none">
          ×
        </button>
      </div>
      <ul className="list-disc pl-5 text-xs" data-testid="save-all-failed-list">
        {stillFailed.map((f) => (
          <li key={f.id}>
            {f.name}
            {f.workoutLabel && <span className="text-red-600"> ({f.workoutLabel})</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// C5.4D — entry into Prescription Review. A plain link when the draft is
// fully saved; otherwise an inert button explaining why.
function ReviewEntry({ patientId, blockedReason }: { patientId: string; blockedReason: string | null }) {
  const className = "rounded-lg border px-3 py-1.5 text-sm font-medium";
  if (blockedReason) {
    return (
      <button
        type="button"
        disabled
        title={blockedReason}
        aria-label={`Review Prescription — ${blockedReason}`}
        data-testid="review-prescription"
        className={`${className} border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed`}
      >
        Review Prescription
      </button>
    );
  }
  return (
    <Link href={`/clinician/patients/${patientId}/prescription/review`} data-testid="review-prescription" className={`${className} border-brand-600 bg-white text-brand-700 hover:bg-brand-50`}>
      Review Prescription
    </Link>
  );
}
