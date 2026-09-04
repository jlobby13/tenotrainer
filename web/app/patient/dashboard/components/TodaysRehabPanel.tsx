import Link from "next/link";
import type { PatientSummary } from "@/lib/fastapi";
import { ResumeSessionBanner } from "./ResumeSessionBanner";

const IRRITABILITY_LABEL: Record<string, string> = {
  low: "Low irritability",
  moderate: "Moderate irritability",
  high: "High irritability",
};

const STAGE_COLOR: Record<number, string> = {
  1: "bg-blue-100 text-blue-800",
  2: "bg-teal-100 text-teal-800",
  3: "bg-green-100 text-green-800",
  4: "bg-amber-100 text-amber-800",
};

function LoadingContextBadges({
  currentPlan,
}: {
  currentPlan: NonNullable<PatientSummary["current_plan"]>;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap mb-4">
      <span
        className={`px-3 py-1 rounded-full text-xs font-semibold ${
          STAGE_COLOR[currentPlan.stage] ?? "bg-gray-100 text-gray-700"
        }`}
      >
        Stage {currentPlan.stage}
      </span>
      <span className="px-3 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-700">
        {IRRITABILITY_LABEL[currentPlan.irritability] ?? currentPlan.irritability}
      </span>
    </div>
  );
}

export function TodaysRehabPanel({
  currentPlan,
  sessionPlan,
  hasOnboarding,
  hasNoPlan,
  todayLogged,
  patientId,
}: {
  currentPlan: PatientSummary["current_plan"];
  sessionPlan: PatientSummary["session_plan"];
  hasOnboarding: boolean;
  hasNoPlan: boolean;
  todayLogged: boolean;
  patientId: string;
}) {
  if (!hasOnboarding) {
    return (
      <div className="bg-brand-50 border border-brand-200 rounded-xl p-6">
        <h2 className="text-base font-semibold text-brand-900 mb-1">Complete your assessment</h2>
        <p className="text-sm text-brand-700 mb-4">
          Your clinician will generate your personalised rehab plan once your initial assessment is done.
        </p>
        <a
          href="/api/auth/launch-dashboard?dest=/onboarding"
          className="inline-block px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 transition-colors"
        >
          Start Assessment
        </a>
      </div>
    );
  }

  if (hasNoPlan) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-6">
        <h2 className="text-base font-semibold text-gray-700 mb-1">Waiting for your rehab plan</h2>
        <p className="text-sm text-gray-500">
          Your assessment is complete. Your clinician will set up your personalised plan shortly.
        </p>
      </div>
    );
  }

  if (todayLogged) {
    return (
      <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
        {currentPlan && <LoadingContextBadges currentPlan={currentPlan} />}
        <div className="flex items-start gap-4">
          <span className="text-green-500 text-2xl mt-0.5">✓</span>
          <div>
            <h2 className="text-base font-semibold text-gray-900">Session logged for today</h2>
            <p className="text-sm text-gray-500 mt-0.5">Nice work.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ResumeSessionBanner patientId={patientId}>
      <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
        {currentPlan && <LoadingContextBadges currentPlan={currentPlan} />}

        <h2 className="text-lg font-semibold text-gray-900">Today&apos;s Rehab</h2>
        <p className="text-sm text-gray-500 mt-0.5 mb-5">
          {sessionPlan.length} exercise{sessionPlan.length !== 1 ? "s" : ""} prescribed for today
        </p>

        {sessionPlan.length > 0 && (
          <ul className="space-y-4 mb-6">
            {sessionPlan.map((item) => (
              <li key={item.exercise.ex_id} className="border-b border-gray-50 last:border-0 pb-3 last:pb-0">
                <p className="text-sm font-semibold text-gray-900">{item.exercise.name}</p>
                {item.dosage && Object.keys(item.dosage).length > 0 && (
                  <p className="text-sm text-gray-700 mt-0.5">
                    {Object.entries(item.dosage)
                      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
                      .join(" · ")}
                  </p>
                )}
                {item.reason && <p className="text-xs text-gray-400 mt-0.5">{item.reason}</p>}
              </li>
            ))}
          </ul>
        )}

        <Link
          href="/patient/session"
          className="block w-full text-center px-4 py-3.5 bg-brand-600 text-white text-base font-semibold rounded-lg hover:bg-brand-700 transition-colors"
        >
          Start Today&apos;s Rehab
        </Link>
      </div>
    </ResumeSessionBanner>
  );
}
