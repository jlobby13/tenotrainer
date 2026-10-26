"use client";

import { useState } from "react";
import type { C5UnitEntry } from "@/lib/c5RuntimeTypes";
import { formatValue } from "./c5Display";

// C5.6D — one set / round / bout. Ephemeral form state only; what counts as
// saved is decided by the server and reported back through `sync`.

export type C5UnitDisplay =
  | { kind: "pending" }
  | { kind: "completed"; value: number | null; load: number | null; loadUnit: string | null; wasEdited: boolean }
  | { kind: "skipped" };

export type C5UnitSyncView = { status: "saving" | "saved" | "retry" | "rejected"; message?: string } | null;

const BTN_PRIMARY = "min-h-11 rounded-xl bg-teal-400 px-4 text-sm font-semibold text-slate-950 hover:bg-teal-300 disabled:opacity-40 transition-colors";
const BTN_QUIET = "min-h-11 rounded-xl border border-slate-700 px-4 text-sm font-medium text-slate-200 hover:border-teal-400/60 disabled:opacity-40 transition-colors";
const BTN_TEXT = "min-h-11 px-2 text-sm font-medium text-slate-400 hover:text-slate-200 disabled:opacity-40";

function unitSuffix(entry: C5UnitEntry): string {
  if (entry.field === "duration") return "sec";
  if (entry.field === "distance") return entry.distanceUnit ?? "m";
  return entry.field === "contacts" ? "contacts" : "reps";
}

function EntryForm({
  entry,
  initialValue,
  initialLoad,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  entry: C5UnitEntry;
  initialValue: number | null;
  initialLoad: number | null;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (value: number, load: number | null) => void;
}) {
  const [value, setValue] = useState(initialValue != null ? String(initialValue) : "");
  const [load, setLoad] = useState(initialLoad != null ? String(initialLoad) : "");
  const parsed = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed > 0;
  const parsedLoad = load.trim() === "" ? null : Number(load);
  const loadValid = parsedLoad === null || (Number.isFinite(parsedLoad) && parsedLoad >= 0);
  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && loadValid) onSubmit(parsed, parsedLoad);
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs font-medium text-slate-400">
          {entry.label}
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Enter a number"
            className="mt-1 block min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-base text-slate-50 focus:border-teal-400 focus:outline-none"
          />
        </label>
        {entry.load && (
          <label className="text-xs font-medium text-slate-400">
            Load ({entry.load.unit})
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={load}
              onChange={(e) => setLoad(e.target.value)}
              placeholder="Optional"
              className="mt-1 block min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-base text-slate-50 focus:border-teal-400 focus:outline-none"
            />
          </label>
        )}
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={!valid || !loadValid} className={`${BTN_PRIMARY} flex-1`}>
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel} className={BTN_QUIET}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function SyncBadge({ sync, onRetry }: { sync: C5UnitSyncView; onRetry?: () => void }) {
  if (!sync) return null;
  if (sync.status === "saving") return <span className="text-xs font-medium text-slate-400">Saving…</span>;
  if (sync.status === "saved") return <span className="text-xs font-medium text-teal-300">Saved</span>;
  if (sync.status === "retry")
    return (
      <button type="button" onClick={onRetry} className="min-h-11 text-xs font-semibold text-amber-300 underline">
        Not saved — retry
      </button>
    );
  return <span className="text-xs font-medium text-rose-300">Not saved</span>;
}

export function C5UnitRow({
  title,
  entry,
  display,
  sync,
  interactive,
  allowUndoSkip,
  restHint = null,
  onComplete,
  onSkip,
  onUndoSkip,
  onRetry,
}: {
  title: string;
  entry: C5UnitEntry;
  display: C5UnitDisplay;
  sync: C5UnitSyncView;
  interactive: boolean;
  // Only before Start: a pre-session skip is ephemeral and can be undone.
  allowUndoSkip: boolean;
  // PEC — prescribed rest, shown on the next set after one is done. Display
  // only: never a timer, never enforced, never written anywhere.
  restHint?: string | null;
  onComplete: (value: number, load: number | null) => void;
  onSkip: () => void;
  onUndoSkip: () => void;
  onRetry: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const suffix = unitSuffix(entry);

  const message = sync?.status === "rejected" || sync?.status === "retry" ? sync.message : undefined;
  const base = "rounded-xl border p-3 sm:p-4";

  if (display.kind === "completed") {
    return (
      <div className={`${base} border-slate-800 bg-slate-950/40`} data-c5-unit data-c5-unit-state="completed">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-slate-100">
            <span className="text-slate-400">{title}:</span> {display.value != null ? `${formatValue(display.value)} ${suffix}` : "Done"}
            {display.load != null ? ` · ${formatValue(display.load)} ${display.loadUnit ?? ""}` : ""}
            {display.wasEdited && <span className="ml-2 text-xs text-slate-500">edited</span>}
          </p>
          <div className="flex items-center gap-2">
            <SyncBadge sync={sync} onRetry={onRetry} />
            {interactive && !editing && (
              <button type="button" onClick={() => setEditing(true)} className={BTN_TEXT}>
                Edit
              </button>
            )}
          </div>
        </div>
        {message && <p className="mt-1 text-xs text-rose-300">{message}</p>}
        {editing && (
          <EntryForm
            entry={entry}
            initialValue={display.value}
            initialLoad={display.load}
            submitLabel="Save change"
            onCancel={() => setEditing(false)}
            onSubmit={(v, l) => {
              setEditing(false);
              onComplete(v, l);
            }}
          />
        )}
      </div>
    );
  }

  if (display.kind === "skipped") {
    return (
      <div className={`${base} border-slate-800/70 bg-slate-900/40`} data-c5-unit data-c5-unit-state="skipped">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-slate-400">
            {title}: <span className="font-medium text-slate-300">Skipped</span>
          </p>
          <div className="flex items-center gap-2">
            <SyncBadge sync={sync} onRetry={onRetry} />
            {interactive && allowUndoSkip && (
              <button type="button" onClick={onUndoSkip} className={BTN_TEXT}>
                Undo
              </button>
            )}
            {interactive && !editing && (
              <button type="button" onClick={() => setEditing(true)} className={BTN_TEXT}>
                Log instead
              </button>
            )}
          </div>
        </div>
        {message && <p className="mt-1 text-xs text-rose-300">{message}</p>}
        {editing && (
          <EntryForm
            entry={entry}
            initialValue={entry.prescribedExact}
            initialLoad={entry.load?.prescribedExact ?? null}
            submitLabel="Save"
            onCancel={() => setEditing(false)}
            onSubmit={(v, l) => {
              setEditing(false);
              onComplete(v, l);
            }}
          />
        )}
      </div>
    );
  }

  // Pending.
  const canOneTap = entry.prescribedExact != null;
  return (
    <div className={`${base} ${interactive ? "border-teal-400/25 bg-slate-900" : "border-slate-800 bg-slate-900/40"}`} data-c5-unit data-c5-unit-state="pending">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-100">
          {title}
          {entry.prescribedExact != null && (
            <span className="ml-2 font-normal text-slate-400">
              {formatValue(entry.prescribedExact)} {suffix}
              {entry.load?.prescribedExact != null ? ` · ${formatValue(entry.load.prescribedExact)} ${entry.load.unit}` : ""}
            </span>
          )}
        </p>
        <SyncBadge sync={sync} onRetry={onRetry} />
      </div>
      {message && <p className="mt-1 text-xs text-rose-300">{message}</p>}
      {restHint && <p className="mt-1 text-xs font-medium text-sky-200" data-c5-rest-hint>{restHint} before this set</p>}
      {editing ? (
        <EntryForm
          entry={entry}
          initialValue={entry.prescribedExact}
          initialLoad={entry.load?.prescribedExact ?? null}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={(v, l) => {
            setEditing(false);
            onComplete(v, l);
          }}
        />
      ) : (
        interactive && (
          <div className="mt-3 flex flex-wrap gap-2">
            {canOneTap ? (
              <>
                <button
                  type="button"
                  onClick={() => onComplete(entry.prescribedExact!, entry.load?.prescribedExact ?? null)}
                  className={`${BTN_PRIMARY} flex-1`}
                >
                  Done
                </button>
                <button type="button" onClick={() => setEditing(true)} className={BTN_QUIET}>
                  Change
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setEditing(true)} className={`${BTN_PRIMARY} flex-1`}>
                Log
              </button>
            )}
            <button type="button" onClick={onSkip} className={BTN_TEXT}>
              Skip
            </button>
          </div>
        )
      )}
    </div>
  );
}
