"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getPendingMorningResponseSession } from "@/lib/rehabSessionClient";
import { getMorningResponseState } from "@/lib/morningEligibility";
import type { MorningResponseRecord } from "@/lib/morningResponseTypes";

// Date-independent by design — queries the server directly rather than
// relying on any locally-cached, date-scoped session lookup. A session
// awaiting its morning response must keep surfacing here even after the
// calendar day rolls over and today's own agenda (rendered separately,
// unaffected by this component) has moved on.
//
// Two states, driven by scheduled_eligible_at (server truth) vs. the
// viewer's own clock (fine for this UI-only freshness check — nothing
// security-sensitive depends on it; the actual Stage 3 gate is server-side):
//   - before eligibility: restrained, informational, never the dominant CTA.
//   - at/after eligibility: the PRIMARY dashboard action, with a real CTA
//     into the check-in flow. Never called "overdue" — the scheduled time
//     passing is not a judgment, just a fact.
export function MorningResponsePendingNotice() {
  const [morningResponse, setMorningResponse] = useState<MorningResponseRecord | null | "loading">("loading");

  useEffect(() => {
    let cancelled = false;
    getPendingMorningResponseSession()
      .then(({ morningResponse }) => {
        if (!cancelled) setMorningResponse(morningResponse);
      })
      .catch(() => {
        if (!cancelled) setMorningResponse(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (morningResponse === "loading" || morningResponse === null) return null;

  const state = getMorningResponseState(morningResponse, new Date());
  if (state === "submitted") return null; // shouldn't happen (outstanding query excludes these), but stay safe

  if (state === "pending") {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-6">
        <h2 className="text-base font-semibold text-blue-900 mb-1">Morning Response Pending</h2>
        <p className="text-sm text-blue-700">
          We&apos;ll check your tendon response at your scheduled morning check-in time.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-6">
      <h2 className="text-base font-semibold text-amber-900 mb-1">Morning Check-In Ready</h2>
      <p className="text-sm text-amber-700 mb-4">
        Tell us how your Achilles feels this morning so we can understand how you responded to your last rehab
        session.
      </p>
      <Link
        href="/patient/morning-response"
        className="inline-block px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 transition-colors"
      >
        Complete Check-In
      </Link>
    </div>
  );
}
