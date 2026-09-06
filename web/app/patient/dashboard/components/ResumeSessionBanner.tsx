"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  type ActiveSessionState,
  loadSession,
  getTotalSets,
  getNextPendingSetIndex,
  isSessionFinished,
} from "@/lib/activeSession";
import { getCurrentRehabSession } from "@/lib/rehabSessionClient";
import type { RehabSessionRecord } from "@/lib/rehabSessionTypes";

// Wraps the normal "Start Today's Rehab" CTA. Server Components can't read
// localStorage, so this client island checks for a resumable or already-
// finished-today session after mount and swaps in the appropriate state —
// otherwise it renders its children (the normal CTA) unchanged, matching
// Milestone 1's behavior exactly when neither applies.
//
// Once the exercise portion is finished (local isSessionFinished), the
// LOCAL state can no longer tell "response still needs finishing" apart
// from "fully done for today" — only the server-side rehab_sessions.status
// knows that, so this fetches it rather than guessing from local state.
export function ResumeSessionBanner({
  patientId,
  planId,
  children,
}: {
  patientId: string;
  planId: string | null;
  children: ReactNode;
}) {
  const [checked, setChecked] = useState(false);
  const [session, setSession] = useState<ActiveSessionState | null>(null);
  const [serverSession, setServerSession] = useState<RehabSessionRecord | null | "loading">("loading");

  useEffect(() => {
    const local = loadSession(patientId, planId);
    setSession(local);
    setChecked(true);
    if (local && isSessionFinished(local)) {
      getCurrentRehabSession()
        .then(({ session: s }) => setServerSession(s))
        .catch(() => setServerSession(null));
    }
  }, [patientId, planId]);

  if (!checked || !session) return <>{children}</>;

  if (isSessionFinished(session)) {
    if (serverSession === "loading") {
      return (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-6">
          <p className="text-sm text-gray-400">Checking today&apos;s session…</p>
        </div>
      );
    }

    if (serverSession?.status === "awaiting_morning_response" || serverSession?.status === "response_complete") {
      return (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-1">Today&apos;s session is complete</h2>
          <p className="text-sm text-gray-500">Your next-morning check-in will be available tomorrow.</p>
        </div>
      );
    }

    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-6">
        <h2 className="text-base font-semibold text-amber-900 mb-1">Session response needed</h2>
        <p className="text-sm text-amber-700 mb-4">
          Your exercises are logged — finish documenting today&apos;s session to complete it.
        </p>
        <Link
          href="/patient/session"
          className="inline-block px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 transition-colors"
        >
          Finish Session Response
        </Link>
      </div>
    );
  }

  const exIdx = session.currentExerciseIndex;
  const totalSets = getTotalSets(session.prescriptionSnapshot.exercises[exIdx]);
  const nextSet = getNextPendingSetIndex(session.exerciseStates[exIdx], totalSets);

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-6">
      <h2 className="text-base font-semibold text-amber-900 mb-1">Session in progress</h2>
      <p className="text-sm text-amber-700 mb-4">
        Exercise {exIdx + 1} of {session.prescriptionSnapshot.exercises.length} · Set{" "}
        {(nextSet ?? Math.max(totalSets - 1, 0)) + 1} of {totalSets}
      </p>
      <Link
        href="/patient/session"
        className="inline-block px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 transition-colors"
      >
        Resume Session
      </Link>
    </div>
  );
}
