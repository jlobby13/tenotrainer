import Link from "next/link";

// Patient-facing failure UX pass — rendered in place of Active Rehab only
// when today's session-plan data could not be loaded because the backend
// service that generates it is temporarily unreachable (see lib/fastapi.ts's
// BackendUnavailableError). Never creates a session, never fabricates or
// reuses a stale session plan — clinical prescription integrity outranks
// keeping the button flowing. "Try Again" is a full navigation (not a
// client-side transition) so it genuinely re-runs the server fetch rather
// than replaying a cached render.
export function SessionUnavailable() {
  return (
    <div className="max-w-md mx-auto px-4 py-10 text-center">
      <h1 className="text-xl font-bold text-gray-900">Today&apos;s rehab can&apos;t be loaded right now.</h1>
      <p className="text-sm text-gray-500 mt-2">
        Please try again shortly. Your existing rehab records have not been affected.
      </p>
      <div className="mt-6 flex flex-col gap-3">
        <a
          href="/patient/session"
          className="inline-block w-full px-4 py-3.5 bg-brand-600 text-white text-base font-semibold rounded-lg"
        >
          Try Again
        </a>
        <Link href="/patient/dashboard" className="text-sm text-gray-600 hover:text-brand-600 font-medium">
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
