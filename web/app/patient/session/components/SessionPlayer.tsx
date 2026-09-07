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
  completeSet,
  skipSet,
  undoSetOutcome,
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
  isExerciseFullyAddressed,
  isSessionFinished,
  getSetDotStates,
  getExerciseDotStates,
  todayLocalDateString,
} from "@/lib/activeSession";
import { previousPerformanceSummary, dosageSummary, restSeconds } from "@/lib/exerciseDisplay";
import { createRehabSession, type ApiError } from "@/lib/rehabSessionClient";
import { SessionOpening } from "./SessionOpening";
import { MorningCheckInRequired } from "./MorningCheckInRequired";
import { ResumePrompt } from "./ResumePrompt";
import { ExerciseHeader } from "./ExerciseHeader";
import { ExerciseGuidance } from "./ExerciseGuidance";
import { SetTracker } from "./SetTracker";
import { RestTimer } from "./RestTimer";
import { ExerciseCompleteTransition } from "./ExerciseCompleteTransition";
import { ReportProblemSheet } from "./ReportProblemSheet";
import { EndSessionReasonPicker } from "./EndSessionReasonPicker";
import { SessionResponseFlow } from "./SessionResponseFlow";
import { ProgressDots } from "./ProgressDots";

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
  // M4 Stage 3: durable session creation is now the authoritative
  // clinical-sequence boundary, not fire-and-forget. "idle" covers both the
  // not-yet-attempted state and a fresh retry.
  const [beginStatus, setBeginStatus] = useState<"idle" | "pending" | "required" | "error">("idle");
  const [beginError, setBeginError] = useState<string | null>(null);
  const [requiredRedirectTo, setRequiredRedirectTo] = useState("/patient/morning-response");

  // localStorage only exists client-side — check for a resumable/finished
  // session after mount. A finished session for a DIFFERENT prescription
  // instance (new day, or the plan itself changed) is discarded as stale by
  // loadSession itself; one for the SAME instance is returned so we can show
  // the handoff instead of letting the patient start today's prescription again.
  useEffect(() => {
    const existing = loadSession(patientId, planId);
    if (existing) setSession(existing);
    setMounted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId, planId]);

  function persist(next: ActiveSessionState) {
    setSession(next);
    saveSession(next);
  }

  // M4 Stage 3: durable session creation now happens HERE, at the moment the
  // patient actually chooses to begin — not retroactively at the M2->M3
  // handoff (see createRehabSession's route/RPC for why that mattered). This
  // is no longer fire-and-forget: Active Rehab must not start client-side
  // until the server has authoritatively allowed it. A server rejection
  // (an outstanding prior morning response, or any other failure) must
  // never be silently bypassed by proceeding into a local-only session.
  async function handleBegin(dismissReminder: boolean) {
    if (dismissReminder) setReminderDismissed(patientId);
    setBeginStatus("pending");
    setBeginError(null);

    const candidate = createSession({ patientId, planId, sessionPlan: initialSessionPlan });

    try {
      await createRehabSession({
        sessionInstanceId: candidate.sessionInstanceId,
        planId: candidate.planId,
        prescriptionInstanceId: candidate.prescriptionInstanceKey,
        patientLocalDate: todayLocalDateString(),
        startedAt: candidate.startedAt,
        prescriptionSnapshot: candidate.prescriptionSnapshot.exercises.map((ex, i) => ({
          ex_id: ex.exercise.ex_id,
          name: ex.exercise.name,
          category: ex.exercise.category,
          loading_profile: ex.exercise.loading_profile,
          order_index: i,
          dosage: ex.dosage,
        })),
      });
      // Only now, with server confirmation in hand, does the local session
      // become real and Active Rehab begin.
      persist(candidate);
      setResumeConfirmed(true);
      setBeginStatus("idle");
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "MORNING_RESPONSE_REQUIRED") {
        setRequiredRedirectTo(err.redirectTo ?? "/patient/morning-response");
        setBeginStatus("required");
      } else {
        setBeginError(err.message || "Something went wrong. Please try again.");
        setBeginStatus("error");
      }
    }
  }

  function handleResume() {
    if (!session) return;
    persist(resumeSession(session));
    setResumeConfirmed(true);
  }

  function advanceIfExerciseDone(next: ActiveSessionState, exerciseIndex: number): ActiveSessionState {
    const totalSets = getTotalSets(next.prescriptionSnapshot.exercises[exerciseIndex]);
    const fullyAddressed = isExerciseFullyAddressed(next.exerciseStates[exerciseIndex], totalSets);
    if (!fullyAddressed) return next;
    const isLast = exerciseIndex === next.prescriptionSnapshot.exercises.length - 1;
    if (isLast) return completeAllExercises(next);
    setAwaitingNextExercise(true);
    return next;
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
    const fullyAddressed = isExerciseFullyAddressed(next.exerciseStates[exerciseIndex], totalSets);
    next = advanceIfExerciseDone(next, exerciseIndex);
    if (!fullyAddressed) setShowRest(true);
    persist(next);
  }

  function handleSkipSet(exerciseIndex: number, setIndex: number) {
    if (!session) return;
    let next = skipSet(session, exerciseIndex, setIndex);
    next = advanceIfExerciseDone(next, exerciseIndex);
    persist(next);
  }

  function handleUndoSetOutcome(exerciseIndex: number, setIndex: number) {
    if (!session) return;
    persist(undoSetOutcome(session, exerciseIndex, setIndex));
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

  function handlePopReported(exerciseIndex: number) {
    // A pop is safety-critical: immediately stop normal exercise progression
    // regardless of remaining sets/exercises, preserving everything completed/
    // skipped/modified so far. Recording the report and completing the
    // session must happen as ONE transformation of the same session snapshot
    // — doing them as two separate persist() calls (report, then complete)
    // raced against the stale `session` closure and silently dropped the pop
    // report, since the second call's completeAllExercises(session) still
    // read the pre-report state.
    if (!session) return;
    const reported = reportProblem(session, exerciseIndex, { type: "pop_reported" });
    persist(completeAllExercises(reported));
    setAwaitingNextExercise(false);
    setShowReportSheet(false);
    setShowRest(false);
    setShowEndPicker(false);
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
    // Deliberately does NOT clear the local session — a finished session for
    // today's prescription instance must persist so the dashboard keeps
    // recognizing that today's prescribed session has already been executed.
    // The durable record of record is now the rehab_sessions row on the
    // server; this local copy is only used for the same-day-already-done
    // check in loadSession().
    router.push("/patient/dashboard");
  }

  if (!mounted) return null;

  if (!session) {
    if (beginStatus === "required") {
      return <MorningCheckInRequired redirectTo={requiredRedirectTo} />;
    }
    return (
      <div>
        <SessionOpening
          sessionPlan={initialSessionPlan}
          reminderAlreadyDismissed={isReminderDismissed(patientId)}
          onBegin={handleBegin}
          beginPending={beginStatus === "pending"}
        />
        {beginStatus === "error" && (
          <div className="max-w-md mx-auto px-4 -mt-4">
            <p className="text-sm text-red-600 text-center">{beginError}</p>
          </div>
        )}
      </div>
    );
  }

  if (isSessionFinished(session)) {
    return <SessionResponseFlow localSession={session} onDone={handleDoneFromHandoff} />;
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
        <ProgressDots states={getExerciseDotStates(session)} label="Session progress" />
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
        setDotStates={getSetDotStates(exerciseState, totalSets)}
      />

      {prevPerf && (
        <div className="bg-gray-50 rounded-lg p-3 text-sm">
          <p className="text-xs text-gray-400">Last Time</p>
          <p className="text-gray-700">{prevPerf}</p>
          <p className="text-xs text-gray-400 mt-2">Today</p>
          <p className="text-gray-900 font-medium">{dosageSummary(exercise.dosage)}</p>
        </div>
      )}

      <ExerciseGuidance key={exerciseIndex} exercise={exercise} />

      {showRest ? (
        <RestTimer prescribedRestSeconds={restSeconds(exercise.dosage)} onDone={() => setShowRest(false)} />
      ) : (
        <SetTracker
          exercise={exercise}
          exerciseState={exerciseState}
          onCompleteSet={(setIndex, actual, wasEdited) =>
            handleCompleteSet(exerciseIndex, setIndex, actual, wasEdited)
          }
          onSkipSet={(setIndex) => handleSkipSet(exerciseIndex, setIndex)}
          onUndoSetOutcome={(setIndex) => handleUndoSetOutcome(exerciseIndex, setIndex)}
        />
      )}

      <button type="button" onClick={() => setShowReportSheet(true)} className="text-xs text-gray-400 underline">
        Report a Problem
      </button>

      {showReportSheet && (
        <ReportProblemSheet
          onSubmit={(report) => handleReport(exerciseIndex, report)}
          onClose={() => setShowReportSheet(false)}
          onSkipExercise={() => handleSkipExercise(exerciseIndex)}
          onPopReported={() => handlePopReported(exerciseIndex)}
        />
      )}

      {showEndPicker && (
        <EndSessionReasonPicker onConfirm={handleEndSessionEarly} onCancel={() => setShowEndPicker(false)} />
      )}
    </div>
  );
}
