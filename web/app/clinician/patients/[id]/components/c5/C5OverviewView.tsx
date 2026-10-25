import Link from "next/link";
import type { C5Overview } from "@/lib/clinicianC5Server";
import {
  c5EligibilityLabel,
  formatLocalDate,
  formatPatientDateTime,
  morningStatusLabel,
  safetyProcessLabel,
  type C5RecoveryDecisionFact,
} from "@/lib/clinicianC5";
import { Card, ClinicianPatientShell, FactRow, ImmediateCell, StatusText } from "./C5Facts";

// M1 — concise C5 Overview: current program, pause, safety, eligibility,
// the latest session and its responses. Not a data dump: full history is
// under Sessions and Safety. No stage/irritability (a carried-forward legacy
// value is not a current C5 assessment — founder-locked decision 7).
export function C5OverviewView({
  patientId,
  displayName,
  overview,
  recoveryDecisions,
}: {
  patientId: string;
  displayName: string;
  overview: C5Overview;
  recoveryDecisions: C5RecoveryDecisionFact[];
}) {
  const { program, latestSession: s, eligibility, openEpisodes } = overview;
  const tz = overview.timezone;
  const weekly = eligibility.weekly;

  return (
    <ClinicianPatientShell patientId={patientId} displayName={displayName} active="overview" isC5>
      <Card title="Current program" testId="c5-overview-program">
        {program ? (
          <dl className="divide-y divide-gray-50">
            <FactRow label="Version">
              {program.versionNumber != null ? `Version ${program.versionNumber}` : "—"} · {program.schedulingMode === "calendar" ? "Calendar" : "Sequence"}
            </FactRow>
            <FactRow label="Published">{program.publishedAt ? formatPatientDateTime(program.publishedAt, tz) : "—"}</FactRow>
            <FactRow label="State">
              <span data-testid="c5-overview-pause">
                {program.paused ? `Paused${program.pausedSince ? ` since ${formatPatientDateTime(program.pausedSince, tz)}` : ""}` : "Active"}
              </span>
            </FactRow>
          </dl>
        ) : (
          <p className="text-sm text-gray-500">No published program.</p>
        )}
        <Link href={`/clinician/patients/${patientId}/prescription`} className="mt-2 inline-block text-sm font-medium text-brand-600">
          View program
        </Link>
      </Card>

      <Card title="Training now" testId="c5-overview-eligibility">
        <dl className="divide-y divide-gray-50">
          <FactRow label="Eligibility">
            <span data-c5-eligibility={eligibility.kind}>{c5EligibilityLabel(eligibility as { kind: string; gate?: string; recovery?: unknown })}</span>
          </FactRow>
          {weekly && (
            <FactRow label="This week (Mon–Sun, patient-local)">
              <span data-testid="c5-overview-weekly">
                {weekly.finishedSessions} of {weekly.target} sessions finished
              </span>
            </FactRow>
          )}
          <FactRow label="Safety">
            {openEpisodes.count === 0 ? (
              "No open safety episodes"
            ) : (
              <Link href={`/clinician/patients/${patientId}/safety`} className="font-medium text-brand-600 underline" data-testid="c5-overview-safety">
                {safetyProcessLabel(openEpisodes.clinicianReleaseRequired ? "clinician_release_required" : "safety_check_in_pending")}
                {openEpisodes.count > 1 ? ` (${openEpisodes.count} open episodes)` : ""}
              </Link>
            )}
          </FactRow>
        </dl>
      </Card>

      <Card title="Most recent session" testId="c5-overview-latest">
        {!s ? (
          <p className="text-sm text-gray-500">No sessions recorded yet.</p>
        ) : (
          <>
            <p className="text-sm font-semibold text-gray-900 break-words">
              {formatLocalDate(s.patientLocalDate)} · {s.workoutTitle}
            </p>
            <dl className="mt-2 divide-y divide-gray-50">
              <FactRow label="Status">
                <StatusText status={s.trainingStatus} />
              </FactRow>
              <FactRow label="Peak pain">
                <ImmediateCell fact={s.immediate} which="pain" />
              </FactRow>
              <FactRow label="Session RPE">
                <ImmediateCell fact={s.immediate} which="rpe" />
              </FactRow>
              <FactRow label="Morning check-in">{morningStatusLabel(s.morning)}</FactRow>
            </dl>
            <div className="mt-2 flex flex-wrap gap-4 text-sm">
              <Link href={`/clinician/patients/${patientId}/sessions/${s.id}`} className="font-medium text-brand-600">
                Session detail
              </Link>
              <Link href={`/clinician/patients/${patientId}/sessions`} className="font-medium text-brand-600">
                All sessions
              </Link>
            </div>
          </>
        )}
      </Card>

      {recoveryDecisions.length > 0 && (
        <Card title="Recent recovery choices (advisory guidance)" testId="c5-overview-recovery">
          <ul className="space-y-1 text-sm text-gray-700">
            {recoveryDecisions.map((d, i) => (
              <li key={i}>
                {formatLocalDate(d.decisionLocalDate)}: {d.decision === "continue" ? "continued with training" : "took a recovery day"} — recommended{" "}
                {d.recommendedRecoveryDays} day{d.recommendedRecoveryDays === 1 ? "" : "s"} after {formatLocalDate(d.anchorStartLocalDate)}, {d.restDaysCompleted} rest day
                {d.restDaysCompleted === 1 ? "" : "s"} completed
              </li>
            ))}
          </ul>
        </Card>
      )}
    </ClinicianPatientShell>
  );
}
