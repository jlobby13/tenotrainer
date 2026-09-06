"use client";

import { useEffect, useState } from "react";
import { getPendingMorningResponseSession } from "@/lib/rehabSessionClient";
import { PatientTimeline } from "./PatientTimeline";

// Self-contained wrapper: shows the lifecycle timeline for the current
// outstanding morning-response obligation, if one exists. Once it's
// submitted, getPendingMorningResponseSession no longer returns it here (the
// post-submit view on /patient/morning-response shows the completed
// timeline instead, at the moment it matters). Stage 2 scope: nothing to
// show a timeline FOR when there is no current/recent obligation, so this
// renders nothing in that case rather than inventing a permanent fixture.
export function DashboardTimeline() {
  const [hasOutstanding, setHasOutstanding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getPendingMorningResponseSession()
      .then(({ morningResponse }) => {
        if (!cancelled) setHasOutstanding(morningResponse !== null);
      })
      .catch(() => {
        if (!cancelled) setHasOutstanding(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!hasOutstanding) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-4 py-3">
      <PatientTimeline sessionResponseDone morningResponseDone={false} resultsAvailable={false} />
    </div>
  );
}
