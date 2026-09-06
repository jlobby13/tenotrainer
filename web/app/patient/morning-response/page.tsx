import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getOldestOutstandingMorningResponse } from "@/lib/morningResponseServer";
import { mapRehabSessionRow } from "@/lib/rehabSessionTypes";
import { MorningCheckInScreen } from "./components/MorningCheckInScreen";

export const metadata = { title: "Morning Check-In — TenoTrainer" };

// Deliberately takes no session/response id from the client at all — the
// obligation is derived entirely from authenticated server truth
// (getOldestOutstandingMorningResponse), so there is nothing here for a
// client-supplied id to spoof. No obligation -> safe redirect to dashboard.
export default async function MorningResponsePage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const outstanding = await getOldestOutstandingMorningResponse(user.id);
  if (!outstanding) redirect("/patient/dashboard");

  const { data: sessionRow } = await supabase
    .from("rehab_sessions")
    .select()
    .eq("id", outstanding.rehabSessionId)
    .maybeSingle();
  if (!sessionRow) redirect("/patient/dashboard");

  const { data: setOutcomeRows } = await supabase
    .from("set_outcomes")
    .select("outcome")
    .eq("rehab_session_id", outstanding.rehabSessionId);

  const completedSets = (setOutcomeRows ?? []).filter((r) => r.outcome === "completed").length;
  const skippedSets = (setOutcomeRows ?? []).filter((r) => r.outcome === "skipped").length;

  const session = mapRehabSessionRow(sessionRow);

  return (
    <div className="min-h-screen bg-gray-50">
      <MorningCheckInScreen
        morningResponse={outstanding}
        previousSession={{
          patientLocalDate: session.patientLocalDate,
          exerciseNames: session.prescriptionSnapshot.map((ex) => ex.name),
          completedSets,
          skippedSets,
          peakSessionPain: session.peakSessionPain,
          difficulty: session.difficulty,
          escalationLevel: session.currentEscalationLevel,
        }}
      />
    </div>
  );
}
