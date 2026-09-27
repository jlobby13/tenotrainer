"use client";

// C5.4A — Prescription Builder Foundation. The one client component in the
// clinician surface so far (see PatientNav.tsx's header) — deliberately
// scoped to this route only. Owns all interactive state; every mutation
// goes through the EXISTING C5.3 API routes (never a direct client write),
// then re-fetches the draft from GET /api/clinician/prescription-drafts/
// [draftId] (the same route C5.3's own HTTP-layer verification already
// exercises) to pick up the authoritative server state.

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { filterLibraryExercises, computeLibraryFacets, EMPTY_LIBRARY_FILTERS, type LibraryFilters } from "@/lib/canonicalExerciseLibrary";
import { LibraryPanel } from "./LibraryPanel";
import { DraftPanel } from "./DraftPanel";
import type { BuilderDraftWorkout, BuilderLibraryExercise } from "./types";

type RawApiExercise = { id: string; canonical_exercise_id: string; order_index: number; status: "active" | "paused"; prescription_exercise_dosage: unknown };
type RawApiWorkout = { id: string; order_index: number; prescription_exercises: RawApiExercise[] | null };

type Props = {
  patientId: string;
  draftId: string;
  isOwner: boolean;
  editingClinicianName: string;
  initialWorkouts: BuilderDraftWorkout[];
  initialExercises: Omit<BuilderLibraryExercise, "hasReferenceDosage">[];
};

function withDerived(e: Omit<BuilderLibraryExercise, "hasReferenceDosage">): BuilderLibraryExercise {
  return { ...e, hasReferenceDosage: e.referenceDosage !== null };
}

export function BuilderShell({ patientId, draftId, isOwner, editingClinicianName, initialWorkouts, initialExercises }: Props) {
  const [workouts, setWorkouts] = useState<BuilderDraftWorkout[]>(initialWorkouts);
  const [exercises, setExercises] = useState<BuilderLibraryExercise[]>(() => initialExercises.map(withDerived));
  const [filters, setFilters] = useState<LibraryFilters>(EMPTY_LIBRARY_FILTERS);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"library" | "draft">("library");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // "Another clinician" is prescriptionManagementServer.ts's own fallback
  // sentinel for an unresolvable profile — matches the founder's exact
  // fallback wording for that case; any REAL resolved name uses the
  // name-specific sentence instead. Never exposes the internal `owner`/
  // `editing_clinician_id` concept to the clinician.
  const viewOnlyMessage =
    editingClinicianName === "Another clinician"
      ? "This prescription is currently being edited by another clinician. You can view the draft, but only the editing clinician can make changes."
      : `This prescription is currently being edited by ${editingClinicianName}. You can view the draft, but only the editing clinician can make changes.`;

  const exercisesById = useMemo(() => new Map(exercises.map((e) => [e.id, e])), [exercises]);
  const filtered = useMemo(() => filterLibraryExercises(exercises, filters), [exercises, filters]);
  const facets = useMemo(() => computeLibraryFacets(exercises), [exercises]);
  const totalDraftExercises = workouts.reduce((sum, w) => sum + w.exercises.length, 0);
  // Counts scoped to workouts[0] (the one workout C5.4A's single-workout
  // model ever shows) rather than summed across the whole draft — the
  // uniqueness rule is "within a workout" (founder correction), not
  // draft-wide, so a future A/B/C builder can still legitimately place the
  // same canonical exercise into a DIFFERENT workout without this check
  // blocking it. Still application-layer only; the schema stays unchanged
  // and remains defensive of any duplicate rows that already exist.
  const draftCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of workouts[0]?.exercises ?? []) counts.set(e.canonicalExerciseId, (counts.get(e.canonicalExerciseId) ?? 0) + 1);
    return counts;
  }, [workouts]);

  // Re-derives the enriched builder view from the SAME getDraft() shape the
  // server page used for the initial render — canonical exercise name/
  // loading-profile enrichment reuses the already-loaded library list
  // (exercisesById), matching the server's own enrichment source.
  const refreshDraft = useCallback(async () => {
    const res = await fetch(`/api/clinician/prescription-drafts/${draftId}`);
    if (!res.ok) throw new Error("Could not refresh the draft");
    const data: { workouts: RawApiWorkout[] } = await res.json();
    const enriched: BuilderDraftWorkout[] = (data.workouts ?? [])
      .slice()
      .sort((a, b) => a.order_index - b.order_index)
      .map((w) => ({
        id: w.id,
        orderIndex: w.order_index,
        exercises: (w.prescription_exercises ?? [])
          .slice()
          .sort((a, b) => a.order_index - b.order_index)
          .map((ex) => {
            const dosage = Array.isArray(ex.prescription_exercise_dosage) ? ex.prescription_exercise_dosage[0] : ex.prescription_exercise_dosage;
            const meta = exercisesById.get(ex.canonical_exercise_id);
            return {
              id: ex.id,
              canonicalExerciseId: ex.canonical_exercise_id,
              orderIndex: ex.order_index,
              status: ex.status,
              exerciseName: meta?.name ?? "Unknown exercise",
              loadingProfile: meta?.loadingProfile ?? null,
              dosageConfigured: !!dosage,
            };
          }),
      }));
    setWorkouts(enriched);
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

  // Adding an exercise ONLY establishes draft membership + order (C5.4A
  // §12) — never invents dosage, never copies reference dosage. If this is
  // the first exercise in the draft, lazily creates the one initial
  // workout the C5.3 schema requires (draft ordering/A-B-C scheduling is
  // explicitly deferred — see the builder's single-workout model).
  //
  // Founder correction: a canonical exercise already present in the
  // CURRENTLY DISPLAYED workout cannot be added again through this UI
  // (defensive re-check here, not just the disabled button, in case of a
  // stale render) — application-layer only, no schema change. The backend
  // itself places no uniqueness constraint on canonical_exercise_id and
  // stays tolerant of any duplicate rows that already exist.
  const handleAdd = (canonicalExerciseId: string) => {
    if (!isOwner) return;
    if ((draftCounts.get(canonicalExerciseId) ?? 0) > 0) return;
    void withBusy(async () => {
      let workoutId = workouts[0]?.id;
      let nextOrderIndex = workouts[0]?.exercises.length ?? 0;
      if (!workoutId) {
        const res = await fetch(`/api/clinician/prescription-drafts/${draftId}/workouts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderIndex: 0 }),
        });
        if (!res.ok) throw new Error("Could not create the initial workout");
        const body: { workoutId: string } = await res.json();
        workoutId = body.workoutId;
        nextOrderIndex = 0;
      }
      const addRes = await fetch(`/api/clinician/prescription-workouts/${workoutId}/exercises`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canonicalExerciseId, orderIndex: nextOrderIndex }),
      });
      if (!addRes.ok) throw new Error("Could not add exercise to draft");
      await refreshDraft();
    });
  };

  // Draft-only mutation (C5.4A §13) — never a published-exercise pause.
  const handleRemove = (exerciseId: string) => {
    if (!isOwner) return;
    void withBusy(async () => {
      const res = await fetch(`/api/clinician/prescription-exercises/${exerciseId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not remove exercise");
      await refreshDraft();
    });
  };

  const handleMove = (workoutId: string, exerciseId: string, direction: "up" | "down") => {
    if (!isOwner) return;
    const workout = workouts.find((w) => w.id === workoutId);
    if (!workout) return;
    const idx = workout.exercises.findIndex((e) => e.id === exerciseId);
    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    if (idx === -1 || swapWith < 0 || swapWith >= workout.exercises.length) return;
    const orderedIds = workout.exercises.map((e) => e.id);
    [orderedIds[idx], orderedIds[swapWith]] = [orderedIds[swapWith], orderedIds[idx]];
    void withBusy(async () => {
      const res = await fetch(`/api/clinician/prescription-workouts/${workoutId}/exercises/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedExerciseIds: orderedIds }),
      });
      if (!res.ok) throw new Error("Could not reorder exercises");
      await refreshDraft();
    });
  };

  // Favorites are clinician-specific and NOT a draft mutation — available
  // regardless of draft ownership (C5.4A §10, §17 only restricts DRAFT
  // edits to the owner). Optimistic with rollback on failure.
  const handleToggleFavorite = (exerciseId: string, next: boolean) => {
    setExercises((prev) => prev.map((e) => (e.id === exerciseId ? { ...e, isFavorite: next } : e)));
    void (async () => {
      const res = await fetch(`/api/clinician/library/exercises/${exerciseId}/favorite`, { method: next ? "POST" : "DELETE" });
      if (!res.ok) setExercises((prev) => prev.map((e) => (e.id === exerciseId ? { ...e, isFavorite: !next } : e)));
    })();
  };

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between shrink-0">
        <span className="text-xl font-bold text-brand-600">TenoTrainer</span>
        <Link href={`/clinician/patients/${patientId}/prescription`} className="text-sm text-gray-600 hover:text-brand-600 font-medium">
          ← Prescription overview
        </Link>
      </nav>

      {!isOwner && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-800 text-sm px-6 py-2 shrink-0">
          {viewOnlyMessage}
        </div>
      )}
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

      {/* Founder correction: desktop columns are ~45/55 (library/draft),
          not equal halves — fr units keep the ratio exact regardless of
          viewport width. Mobile tab model (below) is untouched. */}
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
        <div className={`${mobileTab === "draft" ? "block" : "hidden"} md:block overflow-y-auto p-4`} data-testid="draft-panel">
          <DraftPanel workouts={workouts} isOwner={isOwner} onRemove={handleRemove} onMove={handleMove} busy={busy} />
        </div>
      </div>
    </div>
  );
}
