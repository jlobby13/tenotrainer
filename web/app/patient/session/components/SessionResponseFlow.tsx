"use client";

import { useEffect, useRef, useState } from "react";
import type { ActiveSessionState } from "@/lib/activeSession";
import { hasPopReport, todayLocalDateString } from "@/lib/activeSession";
import type { RehabSessionRecord } from "@/lib/rehabSessionTypes";
import { deriveStep, type ResumeStep } from "@/lib/sessionResponseResume";
import {
  createRehabSession,
  submitExercisesComplete,
  submitResponseCheckpoint,
  type ResponseCheckpoint,
} from "@/lib/rehabSessionClient";
import { SessionHandoff } from "./SessionHandoff";
import { Level5Screen } from "./response/Level5Screen";
import { PeakPainScreen } from "./response/PeakPainScreen";
import { DifficultyScreen } from "./response/DifficultyScreen";
import { ExternalLoadScreen } from "./response/ExternalLoadScreen";
import { ContributorScreen } from "./response/ContributorScreen";
import { AcuteQuestionsScreen } from "./response/AcuteQuestionsScreen";
import { OutcomeScreen } from "./response/OutcomeScreen";

type Step = { kind: "loading" } | { kind: "error"; message: string } | ResumeStep;

export function SessionResponseFlow({
  localSession,
  onDone,
}: {
  localSession: ActiveSessionState;
  onDone: () => void;
}) {
  const [server, setServer] = useState<RehabSessionRecord | null>(null);
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [level5Acknowledged, setLevel5Acknowledged] = useState(false);
  const [externalLoadAnswered, setExternalLoadAnswered] = useState(false);
  const [showSummary, setShowSummary] = useState(true);
  // React Strict Mode double-invokes effects in dev, and createRehabSession/
  // submitExercisesComplete are safely idempotent under that — but the
  // finalize checkpoint does an append-only INSERT into
  // escalation_evaluations, so it must fire at most once per mount. These
  // refs guard the automatic (not the manual retry) calls only.
  const autoBootstrappedRef = useRef(false);
  const finalizedRef = useRef(false);

  async function bootstrap() {
    setStep({ kind: "loading" });
    try {
      const { session: created } = await createRehabSession({
        sessionInstanceId: localSession.sessionInstanceId,
        planId: localSession.planId,
        prescriptionInstanceId: localSession.prescriptionInstanceKey,
        patientLocalDate: todayLocalDateString(),
        startedAt: localSession.startedAt,
        prescriptionSnapshot: localSession.prescriptionSnapshot.exercises.map((ex, i) => ({
          ex_id: ex.exercise.ex_id,
          name: ex.exercise.name,
          category: ex.exercise.category,
          loading_profile: ex.exercise.loading_profile,
          order_index: i,
          dosage: ex.dosage,
        })),
      });

      const setOutcomes = localSession.exerciseStates.flatMap((exState, exIndex) =>
        exState.setOutcomes.map((o) => ({
          exerciseId: exState.exerciseId,
          exerciseOrderIndex: exIndex,
          setIndex: o.setIndex,
          outcome: o.kind,
          prescribedReps: null,
          prescribedLoad: null,
          actualReps: o.kind === "completed" ? o.actual.reps : null,
          actualLoad: o.kind === "completed" ? (o.actual.load ?? null) : null,
          wasEdited: o.kind === "completed" ? o.wasEdited : false,
          occurredAt: o.kind === "completed" ? o.completedAt : o.skippedAt,
        }))
      );
      const sessionEvents = localSession.exerciseStates.flatMap((exState) =>
        exState.problemReports.map((r) => ({
          exerciseId: exState.exerciseId,
          setIndex: r.setNumber ?? null,
          type: r.type,
          note: r.note ?? null,
          occurredAt: r.occurredAt,
        }))
      );
      const hasPop = hasPopReport(localSession);
      const exerciseOutcome = hasPop ? "acute_terminated" : localSession.status === "ended_early" ? "ended_early" : "completed";

      const { session: afterComplete } = await submitExercisesComplete(created.id, {
        exerciseOutcome,
        earlyEndReason: localSession.earlyEndReason ?? null,
        setOutcomes,
        sessionEvents,
      });

      setServer(afterComplete);
      setStep(deriveStep(afterComplete, localSession, level5Acknowledged, externalLoadAnswered));
    } catch (e) {
      setStep({ kind: "error", message: e instanceof Error ? e.message : "Something went wrong." });
    }
  }

  useEffect(() => {
    if (autoBootstrappedRef.current) return;
    autoBootstrappedRef.current = true;
    bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Finalize is a side effect, not something to trigger from inside render —
  // and it must only ever fire once per mount (see finalizedRef above).
  useEffect(() => {
    if (step.kind === "outcome" && step.escalationLevel === -1 && !finalizedRef.current) {
      finalizedRef.current = true;
      checkpoint({ finalize: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // overrideExternalLoadAnswered exists only to avoid a stale-closure read
  // of the externalLoadAnswered state variable: React state updates are
  // batched, so a `setExternalLoadAnswered(true)` called immediately before
  // `checkpoint(...)` would not yet be visible inside this same checkpoint()
  // invocation's closure. Same pattern Level5Screen's onContinue already
  // uses by calling deriveStep with a literal `true` directly.
  async function checkpoint(fields: ResponseCheckpoint, overrideExternalLoadAnswered?: boolean) {
    if (!server) return;
    try {
      const { session: updated, escalation } = await submitResponseCheckpoint(server.id, fields);
      setServer(updated);
      if (fields.finalize && escalation) {
        setStep({ kind: "outcome", escalationLevel: escalation.level });
      } else {
        setStep(deriveStep(updated, localSession, level5Acknowledged, overrideExternalLoadAnswered ?? externalLoadAnswered));
      }
    } catch (e) {
      setStep({ kind: "error", message: e instanceof Error ? e.message : "Something went wrong." });
    }
  }

  if (step.kind === "loading") {
    return <div className="max-w-md mx-auto px-4 py-10 text-center text-sm text-gray-400">Saving your session…</div>;
  }

  if (step.kind === "error") {
    return (
      <div className="max-w-md mx-auto px-4 py-10 text-center">
        <p className="text-sm text-red-700">{step.message}</p>
        <button
          type="button"
          onClick={bootstrap}
          className="mt-4 px-4 py-2.5 bg-brand-600 text-white text-sm font-semibold rounded-lg"
        >
          Try Again
        </button>
      </div>
    );
  }

  if (step.kind === "level5") {
    return (
      <Level5Screen
        onContinue={() => {
          setLevel5Acknowledged(true);
          if (server) setStep(deriveStep(server, localSession, true, externalLoadAnswered));
        }}
      />
    );
  }

  if (showSummary && server) {
    return (
      <SessionHandoff
        session={localSession}
        onDone={() => {
          setShowSummary(false);
          setStep(deriveStep(server, localSession, level5Acknowledged, externalLoadAnswered));
        }}
      />
    );
  }

  if (step.kind === "peak_pain") {
    return <PeakPainScreen onSubmit={(value) => checkpoint({ peakSessionPain: value })} />;
  }

  if (step.kind === "difficulty") {
    return <DifficultyScreen onSubmit={(value) => checkpoint({ difficulty: value })} />;
  }

  if (step.kind === "external_load") {
    return (
      <ExternalLoadScreen
        onSubmit={(selection) => {
          setExternalLoadAnswered(true);
          checkpoint({ externalLoad: selection }, true);
        }}
      />
    );
  }

  if (step.kind === "contributor") {
    const exercises = localSession.prescriptionSnapshot.exercises.map((ex, i) => ({
      exId: ex.exercise.ex_id,
      name: ex.exercise.name,
      hadReport: localSession.exerciseStates[i]?.problemReports.length > 0,
    }));
    return (
      <ContributorScreen
        exercises={exercises}
        onSubmit={(result) =>
          checkpoint({
            contributorReason: result.reason,
            contributorExerciseId: result.exerciseId,
            contributorOtherText: result.otherText,
          })
        }
      />
    );
  }

  if (step.kind === "acute") {
    return (
      <AcuteQuestionsScreen
        popKnownTrue={hasPopReport(localSession)}
        onSubmit={(result) => checkpoint({ ...result, finalize: true })}
      />
    );
  }

  if (step.kind === "outcome") {
    if (step.escalationLevel === -1) {
      // Everything required was already present (e.g. resumed after a refresh
      // right at the finalize boundary) — the effect above finalizes exactly
      // once; this just renders the in-between state.
      return <div className="max-w-md mx-auto px-4 py-10 text-center text-sm text-gray-400">Finishing up…</div>;
    }
    return <OutcomeScreen escalationLevel={step.escalationLevel} onDone={onDone} />;
  }

  return null;
}
