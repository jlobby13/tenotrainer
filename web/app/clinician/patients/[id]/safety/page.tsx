import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClinicianAuth, assertSupervises } from "@/lib/clinicianAuth";
import { getC5SafetyEpisodes, getPatientHeader, isC5Patient } from "@/lib/clinicianC5Server";
import {
  LEVEL4_REASON_LABELS,
  RELEASE_PATH_LABELS,
  SAFETY_FACT_LABELS,
  formatLocalDate,
  formatPatientDateTime,
  safetyProcessLabel,
  trainingStatusLabel,
  yesNoUnknown,
  type C5SafetyEpisode,
} from "@/lib/clinicianC5";
import { Card, ClinicianPatientShell } from "../components/c5/C5Facts";
import { ReleaseHoldForm } from "./ReleaseHoldForm";

export const metadata = { title: "Safety — TenoTrainer" };

function EpisodeCard({ e, patientId, tz }: { e: C5SafetyEpisode; patientId: string; tz: string | null }) {
  const reported = (Object.keys(SAFETY_FACT_LABELS) as (keyof typeof SAFETY_FACT_LABELS)[]).filter((k) => e.initialFacts[k]).map((k) => SAFETY_FACT_LABELS[k]);
  return (
    <div className="border-t border-gray-100 pt-4 first:border-0 first:pt-0" data-c5-episode={e.episodeId} data-c5-episode-state={e.processState}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-gray-900">{safetyProcessLabel(e.processState)}</p>
        <p className="text-xs text-gray-500">Raised {formatPatientDateTime(e.confirmedAt, tz)}</p>
      </div>
      <dl className="mt-2 space-y-1 text-sm">
        <div>
          <dt className="inline text-gray-500">Reported: </dt>
          <dd className="inline text-gray-900">{reported.length ? reported.join(", ") : "—"}</dd>
        </div>
        <div>
          <dt className="inline text-gray-500">From session: </dt>
          <dd className="inline text-gray-900">
            {e.sourceSession ? (
              e.sourceSession.isC5 ? (
                <Link href={`/clinician/patients/${patientId}/sessions/${e.sourceSession.id}`} className="font-medium text-brand-600 underline">
                  {formatLocalDate(e.sourceSession.patientLocalDate)}
                  {e.sourceSession.trainingStatus ? ` · ${trainingStatusLabel(e.sourceSession.trainingStatus)}` : ""}
                </Link>
              ) : (
                `${formatLocalDate(e.sourceSession.patientLocalDate)} (previous training system)`
              )
            ) : (
              "—"
            )}
          </dd>
        </div>
        {e.processState !== "released" && e.requiresClinicianRelease && (
          <p className="text-sm text-gray-700">
            Training stays on hold until a clinician releases it. The patient&apos;s own check-in answers are recorded below but do not release this hold.
          </p>
        )}
        {e.processState === "safety_check_in_pending" && (
          <p className="text-sm text-gray-700">Waiting for the patient&apos;s safety check-in, which can resolve this episode under the standard rules.</p>
        )}
      </dl>

      <div className="mt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Patient safety check-ins</p>
        {e.reassessments.length === 0 ? (
          <p className="text-sm text-gray-500">None submitted.</p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm text-gray-700">
            {e.reassessments.map((r, i) => (
              <li key={i}>
                {formatPatientDateTime(r.submittedAt, tz)}:{" "}
                {e.initialFacts.sudden_or_sharp_pain && `sharp pain resolved — ${yesNoUnknown(r.suddenOrSharpPainResolved)}; `}
                {e.initialFacts.new_functional_difficulty && `function difficulty resolved — ${yesNoUnknown(r.newFunctionalDifficultyResolved)}; `}
                evaluated by a professional — {r.evaluatedByProfessional ? "Yes" : "No"}
                {r.evaluatedByProfessional ? `; cleared — ${yesNoUnknown(r.clearedByProfessional)}` : ""} (patient report)
              </li>
            ))}
          </ul>
        )}
      </div>

      {e.release ? (
        <div className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-sm" data-testid="release-record">
          <p className="font-medium text-gray-900">
            {RELEASE_PATH_LABELS[e.release.releasePath] ?? e.release.releasePath}
            {e.release.releasedByName ? ` — ${e.release.releasedByName}` : ""}
          </p>
          <p className="text-xs text-gray-500">{formatPatientDateTime(e.release.releasedAt, tz)}</p>
          {e.release.releaseNote && <p className="mt-1 text-gray-700 whitespace-pre-line break-words">“{e.release.releaseNote}”</p>}
        </div>
      ) : (
        e.requiresClinicianRelease && <ReleaseHoldForm patientId={patientId} episodeId={e.episodeId} />
      )}

      <p className="mt-2 text-xs text-gray-400">
        Provenance: initial level {e.initialLevel}, effective level {e.effectiveLevel}
        {e.level4Reasons.length ? ` (${e.level4Reasons.map((r) => LEVEL4_REASON_LABELS[r] ?? r).join(", ")})` : ""}
        {e.professionallyHeld ? ", patient reported evaluated but not cleared" : ""}; blocked training attempts {e.blockedOpportunityCount}.
      </p>
    </div>
  );
}

// M1 — every safety episode for the patient (open AND released), each with
// its own authoritative state — never just the one the brake reports — so
// simultaneous episodes stay visible and are resolved independently.
export default async function ClinicianSafetyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: patientId } = await params;
  const { clinicianId } = await requireClinicianAuth();
  if (!(await assertSupervises(clinicianId, patientId))) notFound();

  const [header, c5, episodes] = await Promise.all([getPatientHeader(patientId), isC5Patient(patientId), getC5SafetyEpisodes(patientId)]);
  if (!header) notFound();
  const open = episodes.filter((e) => e.processState !== "released");
  const released = episodes.filter((e) => e.processState === "released");

  return (
    <ClinicianPatientShell patientId={patientId} displayName={header.displayName} active="safety" isC5={c5}>
      <Card title="Open safety episodes" testId="safety-open">
        {open.length === 0 ? (
          <p className="text-sm text-gray-500">No open safety episodes. Training is not on a safety hold.</p>
        ) : (
          <div className="space-y-4">
            {open.map((e) => (
              <EpisodeCard key={e.episodeId} e={e} patientId={patientId} tz={header.timezone} />
            ))}
          </div>
        )}
      </Card>
      <Card title="Resolved" testId="safety-resolved">
        {released.length === 0 ? (
          <p className="text-sm text-gray-500">No resolved episodes.</p>
        ) : (
          <div className="space-y-4">
            {released.map((e) => (
              <EpisodeCard key={e.episodeId} e={e} patientId={patientId} tz={header.timezone} />
            ))}
          </div>
        )}
      </Card>
    </ClinicianPatientShell>
  );
}
