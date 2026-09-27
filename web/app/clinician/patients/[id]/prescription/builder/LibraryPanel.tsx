"use client";

// C5.4A — Canonical Exercise Library browser (brief §4 left panel, §7-11).
// Purely presentational + local expand state is owned by the parent
// (BuilderShell) so that switching mobile tabs doesn't discard it.

import { formatLoadingProfileLabel, formatLateralityLabel, formatFreeTextLabel, formatReferenceDosageSummary, type LibraryFilters } from "@/lib/canonicalExerciseLibrary";
import type { BuilderLibraryExercise } from "./types";

type Props = {
  exercises: BuilderLibraryExercise[];
  facets: { loadingProfiles: string[]; categories: string[] };
  filters: LibraryFilters;
  onFiltersChange: (filters: LibraryFilters) => void;
  draftCounts: Map<string, number>;
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onAdd: (canonicalExerciseId: string) => void;
  onToggleFavorite: (exerciseId: string, next: boolean) => void;
  canAdd: boolean;
  busy: boolean;
};

export function LibraryPanel({ exercises, facets, filters, onFiltersChange, draftCounts, expandedId, onToggleExpand, onAdd, onToggleFavorite, canAdd, busy }: Props) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Exercise Library</h2>
        <input
          type="text"
          placeholder="Search exercises…"
          value={filters.search}
          onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <div className="flex flex-wrap gap-2">
          <select
            value={filters.loadingProfile ?? ""}
            onChange={(e) => onFiltersChange({ ...filters, loadingProfile: e.target.value || null })}
            className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm text-gray-700"
          >
            <option value="">All loading profiles</option>
            {facets.loadingProfiles.map((lp) => (
              <option key={lp} value={lp}>
                {formatLoadingProfileLabel(lp)}
              </option>
            ))}
          </select>
          <select
            value={filters.category ?? ""}
            onChange={(e) => onFiltersChange({ ...filters, category: e.target.value || null })}
            className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm text-gray-700"
          >
            <option value="">All categories</option>
            {facets.categories.map((c) => (
              <option key={c} value={c}>
                {formatFreeTextLabel(c)}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-sm text-gray-700 px-1">
            <input type="checkbox" checked={filters.favoritesOnly} onChange={(e) => onFiltersChange({ ...filters, favoritesOnly: e.target.checked })} />
            Favorites
          </label>
        </div>
      </div>

      {exercises.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-8">No exercises match these filters.</p>
      ) : (
        <div className="space-y-2" data-testid="library-results">
          {exercises.map((ex) => (
            <ExerciseCard
              key={ex.id}
              exercise={ex}
              inDraftCount={draftCounts.get(ex.id) ?? 0}
              expanded={expandedId === ex.id}
              onToggleExpand={() => onToggleExpand(ex.id)}
              onAdd={() => onAdd(ex.id)}
              onToggleFavorite={(next) => onToggleFavorite(ex.id, next)}
              canAdd={canAdd}
              busy={busy}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ExerciseCard({
  exercise,
  inDraftCount,
  expanded,
  onToggleExpand,
  onAdd,
  onToggleFavorite,
  canAdd,
  busy,
}: {
  exercise: BuilderLibraryExercise;
  inDraftCount: number;
  expanded: boolean;
  onToggleExpand: () => void;
  onAdd: () => void;
  onToggleFavorite: (next: boolean) => void;
  canAdd: boolean;
  busy: boolean;
}) {
  const loadingLabel = formatLoadingProfileLabel(exercise.loadingProfile);
  const lateralityLabel = formatLateralityLabel(exercise.unilateralBilateral);

  return (
    <div className="bg-white rounded-lg border border-gray-100 shadow-sm" data-testid="exercise-card" data-exercise-name={exercise.name}>
      <div className="flex items-center gap-2 p-3">
        <button onClick={() => onToggleFavorite(!exercise.isFavorite)} aria-label="Toggle favorite" className="text-lg leading-none shrink-0">
          <span className={exercise.isFavorite ? "text-amber-500" : "text-gray-300"}>★</span>
        </button>

        <button onClick={onToggleExpand} className="flex-1 min-w-0 text-left" data-testid="exercise-card-name">
          <div className="font-medium text-gray-900 truncate">{exercise.name}</div>
          <div className="flex flex-wrap gap-x-2 text-xs text-gray-500">
            {loadingLabel && <span>{loadingLabel}</span>}
            {exercise.category && <span>· {formatFreeTextLabel(exercise.category)}</span>}
            {lateralityLabel && lateralityLabel !== "Not Applicable" && <span>· {lateralityLabel}</span>}
          </div>
        </button>

        {inDraftCount > 1 && <span className="shrink-0 text-xs rounded-full bg-brand-50 text-brand-700 px-2 py-0.5">In draft ×{inDraftCount}</span>}

        {inDraftCount > 0 ? (
          <button disabled className="shrink-0 rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-500 cursor-not-allowed">
            Added
          </button>
        ) : (
          <button
            onClick={onAdd}
            disabled={!canAdd || busy}
            className="shrink-0 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Add
          </button>
        )}
      </div>

      {expanded && (
        <div className="border-t border-gray-100 p-3 text-sm text-gray-700 space-y-2">
          {exercise.setupInstructions && (
            <Detail label="Setup">
              <p>{exercise.setupInstructions}</p>
            </Detail>
          )}
          {exercise.executionCues && exercise.executionCues.length > 0 && (
            <Detail label="Execution cues">
              <ul className="list-disc list-inside">
                {exercise.executionCues.map((cue, i) => (
                  <li key={i}>{cue}</li>
                ))}
              </ul>
            </Detail>
          )}
          {exercise.patientFacingExplanation && (
            <Detail label="Patient-facing explanation">
              <p>{exercise.patientFacingExplanation}</p>
            </Detail>
          )}
          {exercise.commonCompensations && exercise.commonCompensations.length > 0 && (
            <Detail label="Common compensations">
              <ul className="list-disc list-inside">
                {exercise.commonCompensations.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </Detail>
          )}
          {exercise.contraindicationsOrCautions && (
            <Detail label="Contraindications / cautions">
              <p className="text-amber-700">{exercise.contraindicationsOrCautions}</p>
            </Detail>
          )}
          {exercise.referenceDosage && (
            <Detail label="Reference dosage">
              <p className="text-gray-600">{formatReferenceDosageSummary(exercise.referenceDosage)}</p>
              <p className="text-xs text-gray-400 italic">Informational only — does not populate this patient&apos;s prescription.</p>
            </Detail>
          )}
        </div>
      )}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-0.5">{label}</div>
      {children}
    </div>
  );
}
