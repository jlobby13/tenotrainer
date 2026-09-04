"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  type ActiveSessionState,
  loadSession,
  getTotalSets,
  getNextPendingSetIndex,
} from "@/lib/activeSession";

// Wraps the normal "Start Today's Rehab" CTA. Server Components can't read
// localStorage, so this client island checks for a resumable session after
// mount and swaps in a resume prompt in its place — otherwise it renders its
// children (the normal CTA) unchanged, matching Milestone 1's behavior exactly
// when no session is in progress.
export function ResumeSessionBanner({ patientId, children }: { patientId: string; children: ReactNode }) {
  const [checked, setChecked] = useState(false);
  const [session, setSession] = useState<ActiveSessionState | null>(null);

  useEffect(() => {
    setSession(loadSession(patientId));
    setChecked(true);
  }, [patientId]);

  if (!checked || !session) return <>{children}</>;

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
