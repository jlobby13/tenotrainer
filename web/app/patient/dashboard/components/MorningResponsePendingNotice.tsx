"use client";

import { useEffect, useState } from "react";
import { getPendingMorningResponseSession } from "@/lib/rehabSessionClient";

// Date-independent by design — queries the server directly rather than
// relying on any locally-cached, date-scoped session lookup. A session
// awaiting its morning response must keep surfacing here even after the
// calendar day rolls over and today's own agenda (rendered separately,
// unaffected by this component) has moved on.
//
// Milestone 4 owns the actual next-morning pain/stiffness questionnaire —
// this notice deliberately asks nothing and classifies nothing (never "Well
// Tolerated", never implying the session is clinically complete). It exists
// only so the unresolved state is never silently hidden before that
// questionnaire exists.
export function MorningResponsePendingNotice() {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getPendingMorningResponseSession()
      .then(({ session }) => {
        if (!cancelled) setPending(session != null);
      })
      .catch(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!pending) return null;

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-xl p-6">
      <h2 className="text-base font-semibold text-blue-900 mb-1">Morning Response Pending</h2>
      <p className="text-sm text-blue-700">
        Your rehab session was recorded. Your next step is a morning tendon check-in.
      </p>
    </div>
  );
}
