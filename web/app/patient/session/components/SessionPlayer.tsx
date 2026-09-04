"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { SessionExercise, PreviousPerformance } from "@/lib/fastapi";
import {
  type ActiveSessionState,
  type EarlyEndReason,
  type ProblemType,
  createSession,
  loadSession,
  saveSession,
  clearSession,
  completeSet,
  undoSet,
  advanceToNextExercise,
  completeAllExercises,
  reportProblem,
  skipExercise,
  resumeSession,
  pauseSession,
  endSessionEarly,
  isReminderDismissed,
  setReminderDismissed,
  getTotalSets,
  getNextPendingSetIndex,
  isExerciseFullyCompleted,
} from "@/lib/activeSession";
import { previousPerformanceSummary, dosageSummary, restSeconds } from "@/lib/exerciseDisplay";
import { SessionOpening } from "./SessionOpening";
import { ResumePrompt } from "./ResumePrompt";
import { ExerciseHeader } from "./ExerciseHeader";
import { ExerciseGuidance } from "./ExerciseGuidance";
import { SetTracker } from "./SetTracker";
import { RestTimer } from "./RestTimer";
import { ExerciseCompleteTransition } from "./ExerciseCompleteTransition";
import { ReportProblemSheet } from "./ReportProblemSheet";
import { EndSessionReasonPicker } from "./EndSessionReasonPicker";
import { SessionHandoff } from "./SessionHandoff";

export function SessionPlayer({
  initialSessionPlan,
  previousPerformance,
  patientId,
  planId,
}: {
  initialSessionPlan: SessionExercise[];
  previousPerformance: Record<string, PreviousPerformance | null>;
  patientId: string;
  planId: string | null;
}) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [session, setSession] = useState<ActiveSessionState | null>(null);
  const [resumeConfirmed, setResumeConfirmed] = useState(false);
  const [awaitingNextExercise, setAwaitingNextExercise] = useState(false);
  const [showRest, setShowRest] = useState(false);
  const [showReportSheet, setShowReportSheet] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);

  // localStorage only exists client-side — check for a resumable session after mount.
  useEffect(() => {
    const existing = loadSession(patientId);
    if (existing) setSession(existing);
    setMounted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  function persist(next: ActiveSessionState) {
    setSession(next);
    saveSession(next);
  }

  function handleBegin(dismissReminder: boolean) {
    if (dismissReminder) setReminderDismissed(patientId);
    persist(createSession({ patientId, planId, sessionPlan: initialSessionPlan }));
    setResumeConfirmed(true);
  }

  function handleResume() {
    if (!session) return;
    persist(resumeSession(session));
    setResumeConfirmed(true);
  }

  function handleCompleteSet(
    exerciseIndex: number,
    setIndex: number,
    actual: { reps: number; load?: number },
    wasEdited: boolean
  ) {
    if (!session) return;
    let next = completeSet(session, exerciseIndex, setIndex, actual, wasEdited);
    const totalSets = getTotalSets(next.prescriptionSnapshot.exercises[exerciseIndex]);
    const fullyDone = isExerciseFullyCompleted(next.exerciseStates[exerciseIndex], totalSets);
    if (fullyDone) {
      const isLast = exerciseIndex === next.prescriptionSnapshot.exercises.length - 1;
      if (isLast) {
        next = completeAllExercises(next);
      } else {
        setAwaitingNextExercise(true);
      }
    } else {
      setShowRest(true);
    }
    persist(next);
  }

  function handleUndo(exerciseIndex: number, setIndex: number) {
    if (!session) return;
    persist(undoSet(session, exerciseIndex, setIndex));
  }

  function handleNextExercise() {
    if (!session) return;
    persist(advanceToNextExercise(session));
    setAwaitingNextExercise(false);
    setShowRest(false);
  }

  function handleReport(exerciseIndex: number, report: { type: ProblemType; note?: string }) {
    if (!session) return;
    persist(reportProblem(session, exerciseIndex, report));
  }

  function handleSkipExercise(exerciseIndex: number) {
    if (!session) return;
    let next = skipExercise(session, exerciseIndex);
    const isLast = exerciseIndex === next.prescriptionSnapshot.exercises.length - 1;
    next = isLast ? completeAllExercises(next) : advanceToNextExercise(next);
    persist(next);
    setAwaitingNextExercise(false);
    setShowReportSheet(false);
    setShowRest(false);
  }

  function handleEndSessionEarly(reason: EarlyEndReason) {
    if (!session) return;
    persist(endSessionEarly(session, reason));
    setShowEndPicker(false);
  }

  function handlePauseAndLeave() {
    if (session) saveSession(pauseSession(session));
    router.push("/patient/dashboard");
  }

  function handleDoneFromHandoff() {
    if (session) clearSession(session.patientId);
    router.push("/patient/dashboard");
  }

  if (!mounted) return null;

  if (!session) {
    return (
      <SessionOpening
        sessionPlan={initialSessionPlan}
        reminderAlreadyDismissed={isReminderDismissed(patientId)}
        onBegin={handleBegin}
      />
    );
  }

  if (session.status === "completed_exercises" || session.status === "ended_early") {
    return <SessionHandoff session={session} onDone={handleDoneFromHandoff} />;
  }

  if (!resumeConfirmed) {
    const exIdx = session.currentExerciseIndex;
    const totalSets = getTotalSets(session.prescriptionSnapshot.exercises[exIdx]);
    const nextSet = getNextPendingSetIndex(session.exerciseStates[exIdx], totalSets);
    return (
      <ResumePrompt
        exerciseNumber={exIdx + 1}
        totalExercises={session.prescriptionSnapshot.exercises.length}
        setNumber={(nextSet ?? Math.max(totalSets - 1, 0)) + 1}
        totalSets={totalSets}
        onResume={handleResume}
        onEndSession={() => setShowEndPicker(true)}
      />
    );
  }

  const exerciseIndex = session.currentExerciseIndex;
  const exercise = session.prescriptionSnapshot.exercises[exerciseIndex];
  const exerciseState = session.exerciseStates[exerciseIndex];
  const totalSets = getTotalSets(exercise);
  const nextPending = getNextPendingSetIndex(exerciseState, totalSets);

  if (awaitingNextExercise) {
    const next = session.prescriptionSnapshot.exercises[exerciseIndex + 1];
    return (
      <ExerciseCompleteTransition
        nextExercise={next}
        onNext={handleNextExercise}
        onReview={() => setAwaitingNextExercise(false)}
      />
    );
  }

  const prevPerf = previousPerformanceSummary(previousPerformance[exercise.exercise.ex_id] ?? null);

  return (
    <div className="max-w-md mx-auto px-4 py-6 space-y-4">
      <div className="flex justify-between items-center">
        <button type="button" onClick={handlePauseAndLeave} className="text-sm text-gray-400">
          ← Leave
        </button>
        <button type="button" onClick={() => setShowEndPicker(true)} className="text-sm text-gray-400">
          End Session
        </button>
      </div>

      <ExerciseHeader
        exercise={exercise}
        exerciseIndex={exerciseIndex}
        totalExercises={session.prescriptionSnapshot.exercises.length}
        currentSetNumber={(nextPending ?? Math.max(totalSets - 1, 0)) + 1}
        totalSets={totalSets}
        problemReportCount={exerciseState.problemReports.length}
      />

      {prevPerf && (
        <div className="bg-gray-50 rounded-lg p-3 text-sm">
          <p className="text-xs text-gray-400">Last Time</p>
          <p className="text-gray-700">{prevPerf}</p>
          <p className="text-xs text-gray-400 mt-2">Today</p>
          <p className="text-gray-900 font-medium">{dosageSummary(exercise.dosage)}</p>
        </div>
      )}

      <ExerciseGuidance exercise={exercise} />

      {showRest ? (
        <RestTimer prescribedRestSeconds={restSeconds(exercise.dosage)} onDone={() => setShowRest(false)} />
      ) : (
        <SetTracker
          exercise={exercise}
          exerciseState={exerciseState}
          onCompleteSet={(setIndex, actual, wasEdited) =>
            handleCompleteSet(exerciseIndex, setIndex, actual, wasEdited)
          }
          onUndoSet={(setIndex) => handleUndo(exerciseIndex, setIndex)}
        />
      )}

      <button
        type="button"
        onClick={() => setShowReportSheet(true)}
        className="text-xs text-gray-400 underline"
      >
        Report a Problem
      </button>

      {showReportSheet && (
        <ReportProblemSheet
          onSubmit={(report) => handleReport(exerciseIndex, report)}
          onClose={() => setShowReportSheet(false)}
          onSkipExercise={() => handleSkipExercise(exerciseIndex)}
        />
      )}

      {showEndPicker && (
        <EndSessionReasonPicker onConfirm={handleEndSessionEarly} onCancel={() => setShowEndPicker(false)} />
      )}
    </div>
  );
}
