import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClinicianAuth, assertSupervises } from "@/lib/clinicianAuth";
import { getPatientHeader, isC5Patient, listC5Sessions } from "@/lib/clinicianC5Server";
import { formatLocalDate, safetyProcessLabel } from "@/lib/clinicianC5";
import { Card, ClinicianPatientShell, ImmediateCell, MorningCell, StatusText } from "../components/c5/C5Facts";

export const metadata = { title: "Sessions — TenoTrainer" };

// M1 — the authoritative chronological C5 training record (newest first by
// patient-local date). Facts only: no conclusions, no performance judgment.
// Authorization: requireClinicianAuth -> assertSupervises -> notFound,
// before any patient data is read.
export default async function ClinicianSessionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id: patientId } = await params;
  const { page: pageParam } = await searchParams;
  const { clinicianId } = await requireClinicianAuth();
  if (!(await assertSupervises(clinicianId, patientId))) notFound();

  const page = Math.max(0, Number.parseInt(pageParam ?? "0", 10) || 0);
  const [header, c5, list] = await Promise.all([getPatientHeader(patientId), isC5Patient(patientId), listC5Sessions(patientId, page)]);
  if (!header) notFound();

  return (
    <ClinicianPatientShell patientId={patientId} displayName={header.displayName} active="sessions" isC5={c5}>
      <Card title="Sessions" testId="c5-sessions">
        {list.sessions.length === 0 ? (
          <p className="text-sm text-gray-500 py-4 text-center">No sessions recorded yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100" data-testid="c5-session-list">
            {list.sessions.map((s) => (
              <li key={s.id} data-c5-session={s.id}>
                <Link href={`/clinician/patients/${patientId}/sessions/${s.id}`} className="block py-3 hover:bg-gray-50 -mx-2 px-2 rounded-lg">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="text-sm font-semibold text-gray-900">
                      {formatLocalDate(s.patientLocalDate)} · <span className="break-words">{s.workoutTitle}</span>
                    </span>
                    <span className="text-sm text-gray-700">
                      <StatusText status={s.trainingStatus} />
                    </span>
                  </div>
                  <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600 sm:grid-cols-4">
                    <div>
                      <dt className="text-gray-400">Peak pain</dt>
                      <dd>
                        <ImmediateCell fact={s.immediate} which="pain" />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-gray-400">Session RPE</dt>
                      <dd>
                        <ImmediateCell fact={s.immediate} which="rpe" />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-gray-400">Morning</dt>
                      <dd>
                        <MorningCell fact={s.morning} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-gray-400">Safety</dt>
                      <dd data-c5-escalation={s.escalation?.level ?? "none"}>
                        {s.escalation && s.escalation.level >= 3 ? (s.escalation.episodeId ? "Safety episode raised" : "Safety report — being checked") : "—"}
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-1 text-xs text-gray-500">
                    Sets: {s.units.completed} completed{s.units.skipped ? ` · ${s.units.skipped} skipped` : ""} of {s.units.prescribed} prescribed
                    {s.units.edited ? ` · ${s.units.edited} corrected by patient` : ""}
                    {s.calendarScheduledDate && s.calendarScheduledDate !== s.patientLocalDate ? ` · make-up for ${formatLocalDate(s.calendarScheduledDate)}` : ""}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {(page > 0 || list.hasMore) && (
          <div className="mt-4 flex justify-between text-sm">
            {page > 0 ? (
              <Link href={`/clinician/patients/${patientId}/sessions?page=${page - 1}`} className="font-medium text-brand-600">
                Newer
              </Link>
            ) : (
              <span />
            )}
            {list.hasMore && (
              <Link href={`/clinician/patients/${patientId}/sessions?page=${page + 1}`} className="font-medium text-brand-600">
                Older
              </Link>
            )}
          </div>
        )}
      </Card>
      <p className="text-xs text-gray-500">
        Safety state for each episode, including any {safetyProcessLabel("clinician_release_required").toLowerCase()}, is on the{" "}
        <Link href={`/clinician/patients/${patientId}/safety`} className="font-medium text-brand-600 underline">
          Safety
        </Link>{" "}
        page.
      </p>
    </ClinicianPatientShell>
  );
}
