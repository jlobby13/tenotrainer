import Link from "next/link";

// M4 Stage 3 — the session-triggered required state (distinct from the
// dashboard's date-independent "pending"/"ready" states, which remain
// governed entirely by scheduled_eligible_at and are untouched by this).
// This screen appears only at the moment of an actual new-session attempt
// while a PRIOR morning response remains outstanding — never on the
// dashboard itself, and never described as "overdue." No props needed: the
// obligation itself is derived from authenticated server truth wherever
// this is reached from (the /patient/session page guard, or a client-side
// 409 from the atomic session-creation RPC) — this component has no
// opinion on which obligation, it just presents the fixed, locked copy and
// routes to the flow that resolves it.
export function MorningCheckInRequired({ redirectTo = "/patient/morning-response" }: { redirectTo?: string }) {
  return (
    <div className="max-w-md mx-auto px-4 py-10 text-center">
      <h1 className="text-xl font-bold text-gray-900">Complete Your Morning Check-In First</h1>
      <p className="text-sm text-gray-500 mt-2">
        Your morning response helps TenoTrainer understand how your Achilles responded to your previous loading
        session.
      </p>
      <Link
        href={redirectTo}
        className="mt-6 inline-block w-full px-4 py-3.5 bg-brand-600 text-white text-base font-semibold rounded-lg"
      >
        Complete Check-In
      </Link>
    </div>
  );
}
