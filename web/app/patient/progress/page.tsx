import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getSessionInfo } from "@/lib/auth";
import { getProgressData } from "@/lib/progressServer";
import { getProgressInterpretationData } from "@/lib/progressInterpretationServer";
import { RecentResponseSection } from "./components/RecentResponseSection";
import { SymptomsOverTimeSection } from "./components/SymptomsOverTimeSection";
import { LoadingHistorySection } from "./components/LoadingHistorySection";
import { ToleranceHistorySection } from "./components/ToleranceHistorySection";
import { ProgressSummarySection } from "./components/ProgressSummarySection";
import { SymptomsInterpretationCard } from "./components/SymptomsInterpretationCard";
import { CapacityConstructSection } from "./components/CapacityConstructSection";
import { TrainingResponseCard } from "./components/TrainingResponseCard";

export const metadata = { title: "Progress — TenoTrainer" };

// Milestone 6, Stage 2 — read-only against existing Postgres clinical
// history (see lib/progressServer.ts). Deliberately does NOT call
// getPatientSummary()/the FastAPI bridge — this page has no dependency on
// the legacy backend at all. Layer 1 (factual recorded data).
//
// Milestone 6, Stage 4 — adds Layer 2 (Symptoms/Capacity/Training Response
// interpretation, read-only via lib/progressInterpretationServer.ts) above
// the existing factual sections, per the founder-approved hierarchy:
// Summary -> Symptoms interpretation -> Symptoms evidence -> Capacity ->
// Training Response -> detailed factual history (Recent Response, Loading
// History, Tolerance History). The Stage 2 sections/queries themselves are
// unchanged; only their position in this file moved.
export default async function PatientProgressPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) redirect("/login");

  const session = await getSessionInfo();
  const role = session.memberships[0]?.role ?? "member";
  if (role === "super_user") redirect("/super/dashboard");
  if (role === "clinician" || role === "clinician_admin") redirect("/clinician/dashboard");

  const hasOrgMembership = session.memberships.length > 0;
  const [data, interpretationData] = hasOrgMembership
    ? await Promise.all([getProgressData(authUser.id), getProgressInterpretationData(authUser.id)])
    : [null, null];

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <span className="text-xl font-bold text-brand-600">TenoTrainer</span>
        <Link href="/patient/dashboard" className="text-sm text-gray-600 hover:text-brand-600 font-medium">
          Back to Dashboard
        </Link>
      </nav>

      <main className="max-w-3xl lg:max-w-4xl mx-auto px-4 py-8 lg:py-10">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Progress</h1>
        <p className="text-sm text-gray-500 mb-6">Am I improving? Interpretation first, evidence and full history below.</p>

        {!hasOrgMembership && (
          <div className="bg-white rounded-xl shadow border border-gray-100 p-6 text-sm text-gray-600">
            Your account isn&apos;t connected to a clinic yet. Ask your clinician to send you an invitation.
          </div>
        )}

        {data && !data.hasAnyHistory && (
          <div className="bg-white rounded-xl shadow border border-gray-100 p-6 text-sm text-gray-600">
            You haven&apos;t completed a rehab session yet. Once you have, your progress will start showing up here.
          </div>
        )}

        {data && data.hasAnyHistory && interpretationData && (
          <div className="space-y-6">
            <ProgressSummarySection interpretationData={interpretationData} />
            <SymptomsInterpretationCard symptoms={interpretationData.symptoms} />
            <SymptomsOverTimeSection symptomsOverTime={data.symptomsOverTime} acuteEventDates={data.acuteEventDates} />
            <CapacityConstructSection capacityConstructs={interpretationData.capacityConstructs} />
            <TrainingResponseCard trainingResponse={interpretationData.trainingResponse} />
            <RecentResponseSection recentResponse={data.recentResponse} />
            <LoadingHistorySection loadingHistory={data.loadingHistory} />
            <ToleranceHistorySection toleranceHistory={data.toleranceHistory} />
          </div>
        )}
      </main>
    </div>
  );
}
