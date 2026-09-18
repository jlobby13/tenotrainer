import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClinicianAuth, assertSupervises } from "@/lib/clinicianAuth";
import { getClinicianPatientOverview, type AcuteEpisodeHistoryEntry } from "@/lib/clinicianPatientOverviewServer";
import { formatInsertionalLabel, formatIrritabilityLabel, formatReleasePathLabel } from "@/lib/clinicianPatientOverview";
import { formatLastSessionLabel } from "@/lib/clinicianRoster";
import { RecentSessionCard } from "./components/RecentSessionCard";
import { PatientNav } from "./components/PatientNav";

export const metadata = { title: "Patient — TenoTrainer" };

// C2 — Patient Clinical Overview. Fully Next.js/Supabase-native, same as
// C1A/C1B: no FastAPI dependency of any kind — see
// clinicianPatientOverviewServer.ts's header for the exact boundary this
// enforces (Postgres-persisted facts only, never the legacy rule engine's
// live daily-plan generation).
//
// Authorization sequence UNCHANGED from C1A: requireClinicianAuth() ->
// assertSupervises() -> notFound() before ANY patient data is read ->
// getClinicianPatientOverview() only after supervision is confirmed.
//
// Deliberately factual/descriptive — no adherence metric, no composite
// risk/attention score, no M6 longitudinal interpretation, no automated
// clinical recommendation. See lib/clinicianPatientOverview.ts's header for
// the full list of locked decisions this page renders.
export default async function ClinicianPatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: patientId } = await params;
  const { clinicianId } = await requireClinicianAuth();

  const supervises = await assertSupervises(clinicianId, patientId);
  if (!supervises) notFound();

  const overview = await getClinicianPatientOverview(patientId);
  if (!overview) notFound();

  const now = new Date();

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <span className="text-xl font-bold text-brand-600">TenoTrainer</span>
        <Link href="/clinician/dashboard" className="text-sm text-gray-600 hover:text-brand-600 font-medium">
          Back to Patients
        </Link>
      </nav>

      <main className="max-w-3xl mx-auto px-4 py-8 lg:py-10 space-y-6">
        {/* Patient Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-3">{overview.displayName}</h1>
          <PatientNav patientId={overview.patientId} active="overview" />
          {(overview.acuteReviewActive || overview.morningResponseStatus !== null) && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {overview.acuteReviewActive && <Badge color="red">Clinical review active</Badge>}
              {overview.morningResponseStatus === "due" && <Badge color="amber">Morning response due</Badge>}
              {overview.morningResponseStatus === "pending" && <Badge color="gray">Morning response pending</Badge>}
            </div>
          )}
        </div>

        {/* Current Prescription — metadata only. Never the historical
            session snapshot (see clinicianPatientOverviewServer.ts's header
            on why that would misrepresent "current"). */}
        <section className="bg-white rounded-xl shadow border border-gray-100 p-6">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Current Prescription</h2>
          {overview.prescription ? (
            <div className="space-y-2 text-sm">
              <Row label="Stage" value={`Stage ${overview.prescription.stage}`} />
              <Row label="Irritability" value={formatIrritabilityLabel(overview.prescription.irritability)} />
              <Row label="Classification" value={formatInsertionalLabel(overview.prescription.isInsertional)} />
              <Row label="Prescription date" value={formatLastSessionLabel(overview.prescription.versionCreatedAt, now)} />
            </div>
          ) : (
            <p className="text-sm text-gray-500 py-2 text-center">No current prescription</p>
          )}
        </section>

        {/* Acute Safety History — only rendered when at least one episode
            has ever existed (active or released). Factual/process only,
            never a diagnosis, never L3/L4/L5 as primary language. */}
        {overview.acuteHistory.length > 0 && (
          <section className="bg-white rounded-xl shadow border border-gray-100 p-6">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Acute Safety History</h2>
            <div className="space-y-3">
              {overview.acuteHistory.map((episode) => (
                <AcuteHistoryEntryView key={episode.episodeId} episode={episode} now={now} />
              ))}
            </div>
          </section>
        )}

        {/* Recent Rehab — latest 5 qualifying sessions, uniform collapsed
            cards, independently expandable. */}
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Recent Rehab</h2>
          {overview.recentSessions.length === 0 ? (
            <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
              <p className="text-sm text-gray-500 text-center py-4">No sessions yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              {overview.recentSessions.map((session) => (
                <RecentSessionCard key={session.rehabSessionId} session={session} now={now} />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function Badge({ color, children }: { color: "red" | "amber" | "gray"; children: React.ReactNode }) {
  const classes = { red: "bg-red-50 text-red-700", amber: "bg-amber-50 text-amber-700", gray: "bg-gray-100 text-gray-600" }[color];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}>{children}</span>;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-gray-900">{value}</span>
    </div>
  );
}

// One Acute Safety History entry — factual clinical/process facts only.
// Deliberately never renders initial_level or any L3/L4/L5 language (see
// clinicianPatientOverview.ts's header): that data isn't even in
// AcuteEpisodeHistoryEntry's rendered fields, only its provenance.
function AcuteHistoryEntryView({ episode, now }: { episode: AcuteEpisodeHistoryEntry; now: Date }) {
  const clearedText =
    episode.latestReassessment?.clearedByProfessional === true
      ? "Yes"
      : episode.latestReassessment?.clearedByProfessional === false
        ? "No"
        : "Not yet recorded";

  return (
    <div className="border border-gray-100 rounded-lg p-3 text-sm space-y-1">
      <div className="flex items-center justify-between">
        <span className="font-medium text-gray-900">{formatLastSessionLabel(episode.confirmedAt, now)}</span>
        <span className={episode.status === "active" ? "text-red-700 font-medium" : "text-gray-500"}>
          {episode.status === "active" ? "Active" : "Released"}
        </span>
      </div>
      <p className="text-gray-700">Sudden or sharp pain reported: {episode.reportedSuddenOrSharpPain ? "Yes" : "No"}</p>
      <p className="text-gray-700">Pop felt or heard reported: {episode.reportedPopFeltOrHeard ? "Yes" : "No"}</p>
      <p className="text-gray-700">New functional difficulty reported: {episode.reportedNewFunctionalDifficulty ? "Yes" : "No"}</p>
      <p className="text-gray-700">
        {episode.latestReassessment ? (
          <>
            Evaluated by professional: {episode.latestReassessment.evaluatedByProfessional ? "Yes" : "No"}
            {episode.latestReassessment.evaluatedByProfessional && <>, Cleared: {clearedText}</>}
          </>
        ) : (
          "No reassessment submitted yet"
        )}
      </p>
      {episode.release && (
        <p className="text-gray-700">
          {formatReleasePathLabel(episode.release.releasePath)} on {formatLastSessionLabel(episode.release.releasedAt, now)}
        </p>
      )}
    </div>
  );
}
