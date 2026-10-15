"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  completedPayload,
  outcomeValue,
  payloadToOutcome,
  resultMessage,
  skippedPayload,
  unitCount,
  unitEntry,
  unitKey,
  type C5PerformancePayload,
  type C5SessionView,
  type C5Snapshot,
  type C5TrainingState,
  type C5TrainingStatus,
  type C5UnitKey,
  type C5UnitOutcome,
  type C5WorkoutOption,
} from "@/lib/c5RuntimeTypes";
import {
  C5NetworkError,
  fetchC5State,
  fetchSessionView,
  finishSession,
  startWithFirstPerformance,
  stopSession,
  writeUnit,
} from "@/lib/c5RuntimeClient";
import { C5TodaysRehabCard } from "@/app/patient/dashboard/components/C5TodaysRehabCard";
import { C5ExerciseCard } from "./C5ExerciseCard";
import type { C5UnitDisplay, C5UnitSyncView } from "./C5UnitRow";
import { C5SequenceChoice } from "./C5SequenceChoice";
import { C5StopSheet, type C5AcuteReportInput } from "./C5StopSheet";
import { c5OptionLabel, c5WorkoutTitle } from "./c5Display";

// C5.6D — the C5 patient session.
//
// Before Start, everything here is EPHEMERAL React state: the Sequence
// choice, pre-session skips, navigation. Nothing is written, nothing is
// stored in the browser; leaving discards it (no session, no exposure, no
// consumed day). The FIRST confirmed performed unit calls
// c5_record_first_performance (via /api/patient/c5/start) with a stable
// clientRequestId reused on every retry; the session exists only once the
// server says "started". After that, every unit is written immediately and
// the server's recorded units are the record — the UI shows saving / saved /
// retry / rejected per unit. Finish and Stop are explicit patient intent;
// the server classifies the outcome.

type UnitSync = { status: "saving" | "saved" | "retry" | "rejected"; payload: C5PerformancePayload; edit: boolean; message?: string };
type StartAttempt = { key: C5UnitKey; payload: C5PerformancePayload; status: "saving" | "retry" | "rejected"; message?: string };

const BAR_PRIMARY = "min-h-12 flex-1 rounded-xl bg-teal-400 px-4 text-sm font-semibold text-slate-950 hover:bg-teal-300 disabled:opacity-40 transition-colors";
const BAR_SECONDARY = "min-h-12 flex-1 rounded-xl border border-slate-700 px-4 text-sm font-semibold text-slate-200 hover:border-teal-400/60 disabled:opacity-40 transition-colors";

function sessionFrom(state: C5TrainingState): C5SessionView | null {
  return state.kind === "resume" || state.kind === "acute_resolution_required" ? state.session : null;
}

function defaultOptionKey(state: C5TrainingState): C5WorkoutOption["key"] | null {
  return state.kind === "available" && !state.choiceRequired ? state.options[0].key : null;
}

function withOutcome(session: C5SessionView, o: C5UnitOutcome): C5SessionView {
  const rest = session.outcomes.filter((x) => !(x.exerciseId === o.exerciseId && x.unitIndex === o.unitIndex));
  return { ...session, outcomes: [...rest, o] };
}

function newRequestId(): string {
  return crypto.randomUUID();
}

export function C5SessionRunner({ initialState }: { initialState: C5TrainingState }) {
  const [state, setState] = useState<C5TrainingState>(initialState);
  const [session, setSession] = useState<C5SessionView | null>(sessionFrom(initialState));
  const [optionKey, setOptionKey] = useState<C5WorkoutOption["key"] | null>(defaultOptionKey(initialState));
  const [preSkips, setPreSkips] = useState<Set<C5UnitKey>>(() => new Set());
  const [startAttempt, setStartAttempt] = useState<StartAttempt | null>(null);
  const [sync, setSync] = useState<Partial<Record<C5UnitKey, UnitSync>>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [closed, setClosed] = useState<C5TrainingStatus | null>(null);
  const [closing, setClosing] = useState(false);
  const [showStop, setShowStop] = useState(false);

  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  // One idempotency key per pre-Start attempt; reused on every retry.
  const requestIdRef = useRef<string | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const option = state.kind === "available" ? (state.options.find((o) => o.key === optionKey) ?? null) : null;
  const acute = state.kind === "acute_resolution_required";
  const paused = (state.kind === "resume" || state.kind === "acute_resolution_required") && state.paused;
  const snapshot: C5Snapshot | null = session?.snapshot ?? option?.preview ?? null;

  // ---- authoritative refresh ------------------------------------------------
  async function refreshState(message?: string) {
    try {
      const { state: next } = await fetchC5State();
      applyState(next);
      if (message) setBanner(message);
    } catch {
      setBanner("We couldn't refresh your session. Check your connection and try again.");
    }
  }

  function applyState(next: C5TrainingState, keepSelection = false) {
    setState(next);
    const nextSession = sessionFrom(next);
    setSession(nextSession);
    if (nextSession) {
      setPreSkips(new Set());
      requestIdRef.current = null;
    } else if (!keepSelection) {
      setOptionKey(defaultOptionKey(next));
      setPreSkips(new Set());
      requestIdRef.current = null;
    }
  }

  async function resyncSession() {
    const current = sessionRef.current;
    if (!current) return;
    try {
      const { session: fresh } = await fetchSessionView(current.id);
      setSession(fresh);
    } catch {
      // keep what we have; the per-unit message already explains
    }
  }

  // ---- Start (first confirmed performance) ------------------------------------
  async function attemptStart(key: C5UnitKey, payload: C5PerformancePayload) {
    if (state.kind !== "available" || !option) return;
    requestIdRef.current ??= newRequestId();
    const clientRequestId = requestIdRef.current;
    setStartAttempt({ key, payload, status: "saving" });
    setBanner(null);
    setNotice(null);
    const preStartSkips = [...preSkips].map((k) => {
      const [exercise_id, idx] = k.split("#");
      return { exercise_id, unit_index: Number(idx) };
    });
    try {
      const r = await startWithFirstPerformance({
        clientRequestId,
        expectedVersionId: state.versionId,
        workoutId: option.workoutId,
        performance: payload,
        preStartSkips,
        sequenceChoice: option.sequenceChoice,
      });
      if (r.result === "started" && "session" in r) {
        setStartAttempt(null);
        setPreSkips(new Set());
        requestIdRef.current = null;
        setSession(r.session);
        setState({ kind: "resume", paused: false, session: r.session });
        return;
      }
      const next = (r as { state: C5TrainingState }).state;
      if (r.result === "invalid_performance") {
        // Nothing was saved; keep the patient's place and let them correct it.
        setStartAttempt({ key, payload, status: "rejected", message: resultMessage(r.result) });
        return;
      }
      setStartAttempt(null);
      const sameOption =
        next.kind === "available" &&
        next.versionId === state.versionId &&
        next.options.some((o) => o.key === option.key && o.workoutId === option.workoutId);
      applyState(next, sameOption);
      setBanner(
        r.result === "resume_existing_session"
          ? "You already have a session in progress. Your last entry wasn't saved — please enter it again."
          : resultMessage(r.result)
      );
    } catch (e) {
      const message = e instanceof C5NetworkError && e.message === "SAFETY_CHECK_FAILED" ? "We couldn't confirm your safety status." : "Not saved — check your connection.";
      setStartAttempt({ key, payload, status: "retry", message });
    }
  }

  // ---- writes after Start -----------------------------------------------------
  function enqueueWrite(key: C5UnitKey, payload: C5PerformancePayload, edit: boolean) {
    setSync((s) => ({ ...s, [key]: { status: "saving", payload, edit } }));
    queueRef.current = queueRef.current.then(() => runWrite(key, payload, edit));
  }

  async function runWrite(key: C5UnitKey, payload: C5PerformancePayload, edit: boolean) {
    const current = sessionRef.current;
    if (!current) return;
    try {
      const r = await writeUnit(current.id, payload, edit);
      if (r.result === "recorded" || r.result === "edited") {
        setSession((s) => (s ? withOutcome(s, payloadToOutcome(payload, edit)) : s));
        setSync((s) => ({ ...s, [key]: { status: "saved", payload, edit } }));
        return;
      }
      setSync((s) => ({ ...s, [key]: { status: "rejected", payload, edit, message: resultMessage(r.result) } }));
      if (r.result.startsWith("acute_") || r.result === "session_closed" || r.result === "session_not_found") {
        await refreshState(resultMessage(r.result));
      } else if (r.result === "performance_already_recorded" || r.result === "performance_not_recorded") {
        await resyncSession();
      }
    } catch {
      setSync((s) => ({ ...s, [key]: { status: "retry", payload, edit, message: "Not saved — check your connection." } }));
    }
  }

  // ---- unit handlers ------------------------------------------------------------
  function serverOutcome(key: C5UnitKey): C5UnitOutcome | undefined {
    return session?.outcomes.find((o) => unitKey(o.exerciseId, o.unitIndex) === key);
  }

  function handleComplete(exerciseId: string, unitIndex: number, value: number, load: number | null) {
    if (!snapshot) return;
    const exercise = snapshot.exercises.find((e) => e.exerciseId === exerciseId)!;
    const key = unitKey(exerciseId, unitIndex);
    const payload = completedPayload(exerciseId, unitIndex, unitEntry(exercise.dosage), value, load);
    setNotice(null);
    if (!session) {
      if (startAttempt?.status === "saving") return;
      setPreSkips((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
      void attemptStart(key, payload);
      return;
    }
    enqueueWrite(key, payload, serverOutcome(key) !== undefined);
  }

  function handleSkip(exerciseId: string, unitIndex: number) {
    const key = unitKey(exerciseId, unitIndex);
    setNotice(null);
    if (!session) {
      setPreSkips((s) => new Set(s).add(key));
      return;
    }
    if (serverOutcome(key)) return; // a recorded unit is never turned into a skip
    enqueueWrite(key, skippedPayload(exerciseId, unitIndex), false);
  }

  function handleUndoSkip(exerciseId: string, unitIndex: number) {
    const key = unitKey(exerciseId, unitIndex);
    setPreSkips((s) => {
      const n = new Set(s);
      n.delete(key);
      return n;
    });
  }

  function handleRetry(exerciseId: string, unitIndex: number) {
    const key = unitKey(exerciseId, unitIndex);
    if (!session && startAttempt?.key === key) {
      void attemptStart(key, startAttempt.payload);
      return;
    }
    const s = sync[key];
    if (s) enqueueWrite(key, s.payload, s.edit);
  }

  function handleSkipExercise(exerciseId: string) {
    if (!snapshot) return;
    const exercise = snapshot.exercises.find((e) => e.exerciseId === exerciseId)!;
    for (let i = 0; i < unitCount(exercise.dosage); i++) {
      if (displayFor(unitKey(exerciseId, i)).kind === "pending") handleSkip(exerciseId, i);
    }
  }

  // ---- display ---------------------------------------------------------------
  function toDisplay(entryOf: string, o: Pick<C5UnitOutcome, "outcome" | "actualReps" | "actualDurationSeconds" | "actualDistanceM" | "actualLoad" | "actualLoadUnit" | "wasEdited">): C5UnitDisplay {
    if (o.outcome === "skipped") return { kind: "skipped" };
    const exercise = snapshot!.exercises.find((e) => e.exerciseId === entryOf)!;
    return {
      kind: "completed",
      value: outcomeValue(unitEntry(exercise.dosage), o),
      load: o.actualLoad,
      loadUnit: o.actualLoadUnit,
      wasEdited: o.wasEdited,
    };
  }

  function displayFor(key: C5UnitKey): C5UnitDisplay {
    const [exerciseId] = key.split("#");
    if (!session) {
      if (startAttempt?.key === key && startAttempt.status !== "rejected") return toDisplay(exerciseId, payloadToOutcome(startAttempt.payload));
      return preSkips.has(key) ? { kind: "skipped" } : { kind: "pending" };
    }
    const pending = sync[key];
    if (pending && (pending.status === "saving" || pending.status === "retry")) return toDisplay(exerciseId, payloadToOutcome(pending.payload, pending.edit));
    const o = serverOutcome(key);
    return o ? toDisplay(exerciseId, o) : { kind: "pending" };
  }

  function syncFor(key: C5UnitKey): C5UnitSyncView {
    if (!session) {
      if (startAttempt?.key !== key) return null;
      return { status: startAttempt.status === "saving" ? "saving" : startAttempt.status, message: startAttempt.message };
    }
    const s = sync[key];
    return s ? { status: s.status, message: s.message } : null;
  }

  const unsaved = Object.values(sync).some((s) => s && (s.status === "saving" || s.status === "retry"));
  const progress = useMemo(() => {
    if (!snapshot) return { done: 0, total: 0 };
    const total = snapshot.exercises.reduce((n, e) => n + unitCount(e.dosage), 0);
    const done = session ? session.outcomes.filter((o) => o.outcome === "completed").length : 0;
    return { done, total };
  }, [snapshot, session]);

  // ---- Finish / Stop ---------------------------------------------------------
  async function handleFinish() {
    if (!session) {
      // Before Start nothing has been performed; there is nothing to finish.
      setNotice("No exercises have been completed yet.");
      return;
    }
    if (unsaved) {
      setNotice("Waiting for your last entries to save.");
      return;
    }
    setClosing(true);
    setNotice(null);
    try {
      const r = await finishSession(session.id);
      if (r.result === "closed" || r.result === "session_already_closed") setClosed(r.trainingStatus ?? null);
      else if (r.result.startsWith("acute_")) await refreshState(resultMessage(r.result));
      else setNotice(resultMessage(r.result));
    } catch {
      setNotice("We couldn't reach the server. Your session is still open — try again.");
    } finally {
      setClosing(false);
    }
  }

  async function handleStop(report: C5AcuteReportInput | null) {
    if (!session) return;
    setClosing(true);
    setNotice(null);
    try {
      const r = await stopSession(session.id, report);
      if (r.result === "closed" || r.result === "session_already_closed") {
        setShowStop(false);
        setClosed(r.trainingStatus ?? null);
      } else {
        setNotice(resultMessage(r.result));
      }
    } catch {
      setNotice("We couldn't reach the server. Your session is still open — try again.");
    } finally {
      setClosing(false);
    }
  }

  // ---- render ----------------------------------------------------------------
  const header = (
    <div className="flex items-center justify-between">
      <Link href="/patient/dashboard" className="inline-flex min-h-11 items-center text-sm font-medium text-slate-400 hover:text-slate-200">
        ← Today&apos;s Rehab
      </Link>
      {session && !closed && (
        <span className="text-xs font-medium text-slate-400" data-c5-progress>
          {progress.done} of {progress.total} done
        </span>
      )}
    </div>
  );

  if (closed) {
    const stopped = closed !== "finished";
    return (
      <Frame>
        {header}
        <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/80 p-6 text-center" data-c5-closed={closed}>
          <h1 className="text-xl font-semibold text-slate-50">
            {closed === "finished" ? "Workout finished" : closed === "stopped_acute" ? "Session stopped for safety" : "Session stopped"}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-300">
            {stopped ? "Your session has been saved, including everything you completed." : "Nice work — your session has been saved."}
          </p>
          {closed === "stopped_pause" && <p className="mt-2 text-sm text-slate-400">Your clinician has paused your program.</p>}
          {closed === "stopped_acute" && <p className="mt-2 text-sm text-slate-400">If you&apos;re worried about your symptoms, contact your clinician.</p>}
          <p className="mt-4 text-sm text-slate-400">Next: a short check-in about today&apos;s session.</p>
          <Link href="/patient/dashboard" className="mt-6 inline-flex min-h-11 items-center justify-center rounded-xl bg-teal-400 px-5 text-sm font-semibold text-slate-950">
            Back to Today&apos;s Rehab
          </Link>
        </section>
      </Frame>
    );
  }

  // Nothing actionable here: show the same authoritative card as the dashboard.
  if (!session && state.kind !== "available") {
    return (
      <Frame>
        {header}
        {banner && <Banner tone="info">{banner}</Banner>}
        <div className="mt-6">
          <C5TodaysRehabCard state={state} />
        </div>
      </Frame>
    );
  }

  if (!session && state.kind === "available" && !option) {
    return (
      <Frame>
        {header}
        {banner && <Banner tone="info">{banner}</Banner>}
        <div className="mt-6">
          <C5SequenceChoice options={state.options} onChoose={(k) => setOptionKey(k)} />
        </div>
      </Frame>
    );
  }

  // While a Start attempt is unresolved (saving, or a retry whose outcome is
  // unknown) nothing else may be entered: a replayed Start returns the
  // session created by THAT attempt, so a second entry could be lost.
  const interactive = !acute && !closing && (startAttempt === null || startAttempt.status === "rejected");
  return (
    <Frame withBar>
      {header}
      <div className="mt-4">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-teal-300">
          {session ? (acute ? "Session on hold" : "In progress") : option ? c5OptionLabel(option) : ""}
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-50">{snapshot ? c5WorkoutTitle(snapshot.workout) : ""}</h1>
        {!session && state.kind === "available" && state.choiceRequired && (
          <button type="button" onClick={() => setOptionKey(null)} className="mt-1 min-h-11 text-sm font-medium text-slate-400 underline">
            Choose a different workout
          </button>
        )}
        {!session && <p className="mt-2 text-sm text-slate-400">Your session starts when you complete your first set.</p>}
      </div>

      {banner && <Banner tone="info">{banner}</Banner>}
      {acute && (
        <Banner tone="safety" testId="c5-acute-banner">
          A safety check means no more exercises can be added to this session. Everything you completed is saved. Please stop
          the session to continue.
        </Banner>
      )}
      {!acute && paused && (
        <Banner tone="calm" testId="c5-paused-banner">
          Your clinician has paused your program. You can carry on and finish this session, or stop it now.
        </Banner>
      )}

      <div className="mt-5 space-y-4">
        {snapshot?.exercises.map((e, i) => (
          <C5ExerciseCard
            key={e.exerciseId}
            exercise={e}
            position={i + 1}
            total={snapshot.exercises.length}
            displayFor={displayFor}
            syncFor={syncFor}
            interactive={interactive}
            allowUndoSkip={!session}
            onComplete={(u, v, l) => handleComplete(e.exerciseId, u, v, l)}
            onSkip={(u) => handleSkip(e.exerciseId, u)}
            onUndoSkip={(u) => handleUndoSkip(e.exerciseId, u)}
            onRetry={(u) => handleRetry(e.exerciseId, u)}
            onSkipExercise={() => handleSkipExercise(e.exerciseId)}
          />
        ))}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-800 bg-slate-950/95 backdrop-blur" data-c5-action-bar>
        <div className="mx-auto max-w-2xl px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {notice && (
            <p className="mb-2 text-center text-sm text-amber-200" role="status" data-c5-notice>
              {notice}
            </p>
          )}
          <div className="flex gap-2">
            {acute ? (
              <button type="button" disabled={closing} onClick={() => setShowStop(true)} className={BAR_PRIMARY}>
                Stop today&apos;s session
              </button>
            ) : session ? (
              <>
                <button type="button" disabled={closing} onClick={() => setShowStop(true)} className={BAR_SECONDARY}>
                  {paused ? "Stop today's session" : "Stop session"}
                </button>
                <button type="button" disabled={closing || unsaved} onClick={handleFinish} className={BAR_PRIMARY}>
                  {unsaved ? "Saving…" : paused ? "Finish current session" : "Finish workout"}
                </button>
              </>
            ) : (
              <>
                <Link href="/patient/dashboard" className={`${BAR_SECONDARY} inline-flex items-center justify-center`}>
                  Leave
                </Link>
                <button type="button" onClick={handleFinish} className={BAR_PRIMARY}>
                  Finish workout
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {showStop && <C5StopSheet pending={closing} onConfirm={handleStop} onCancel={() => setShowStop(false)} />}
    </Frame>
  );
}

function Frame({ children, withBar = false }: { children: React.ReactNode; withBar?: boolean }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <main className={`mx-auto max-w-2xl px-4 pt-4 ${withBar ? "pb-40" : "pb-12"}`}>{children}</main>
    </div>
  );
}

function Banner({ tone, children, testId }: { tone: "info" | "calm" | "safety"; children: React.ReactNode; testId?: string }) {
  const cls =
    tone === "safety"
      ? "border-amber-400/40 bg-amber-400/10 text-amber-100"
      : tone === "calm"
        ? "border-sky-400/30 bg-sky-400/10 text-sky-100"
        : "border-slate-700 bg-slate-900 text-slate-200";
  return (
    <div className={`mt-4 rounded-xl border px-4 py-3 text-sm leading-relaxed ${cls}`} role="status" data-testid={testId}>
      {children}
    </div>
  );
}
