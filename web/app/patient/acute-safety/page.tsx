import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBrakeStatus } from "@/lib/acuteSafetyServer";
import { getEpisode, getReassessmentHistory } from "@/lib/acuteSafetyServer";
import { AcuteReassessmentScreen } from "./components/AcuteReassessmentScreen";

export const metadata = { title: "Safety Check-In — TenoTrainer" };

// Acute Safety Gate milestone. Deliberately takes no episode id from the
// client — the obligation is derived entirely from authenticated server
// truth (getActiveBrakeStatus), mirroring /patient/morning-response's own
// "nothing for a client-supplied id to spoof" design. No active brake ->
// safe redirect to the dashboard (nothing to do here).
export default async function AcuteSafetyPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const brake = await getActiveBrakeStatus(user.id);
  if (!brake) redirect("/patient/dashboard");

  const [episode, history] = await Promise.all([getEpisode(brake.episodeId), getReassessmentHistory(brake.episodeId)]);
  if (!episode) redirect("/patient/dashboard");

  const hasEverBeenProfessionallyHeld = history.some((r) => r.evaluatedByProfessional === true && r.clearedByProfessional === false);
  const latest = history.length > 0 ? history[history.length - 1] : null;

  return (
    <div className="min-h-screen bg-gray-50">
      <AcuteReassessmentScreen
        episodeId={episode.id}
        effectiveLevel={brake.effectiveLevel}
        initialSuddenOrSharpPain={episode.initialSuddenOrSharpPain}
        initialNewFunctionalDifficulty={episode.initialNewFunctionalDifficulty}
        hasEverBeenProfessionallyHeld={hasEverBeenProfessionallyHeld}
        latestReassessment={
          latest
            ? {
                suddenOrSharpPainResolved: latest.suddenOrSharpPainResolved,
                newFunctionalDifficultyResolved: latest.newFunctionalDifficultyResolved,
                evaluatedByProfessional: latest.evaluatedByProfessional,
                clearedByProfessional: latest.clearedByProfessional,
              }
            : null
        }
      />
    </div>
  );
}
