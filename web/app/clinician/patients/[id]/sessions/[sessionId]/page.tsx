import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClinicianAuth, assertSupervises } from "@/lib/clinicianAuth";
import { getC5SessionDetail, getPatientHeader, isC5Patient } from "@/lib/clinicianC5Server";
import { describeDosage } from "@/lib/prescriptionProgram";
import {
  SAFETY_FACT_LABELS,
  SEQUENCE_CHOICE_LABELS,
  STIFFNESS_DURATION_LABELS,
  formatLocalDate,
  formatPatientDateTime,
  morningStatusLabel,
  yesNoUnknown,
  type C5UnitEdit,
  type C5UnitFact,
} from "@/lib/clinicianC5";
import { Card, ClinicianPatientShell, FactRow, Score, StatusText } from "../../components/c5/C5Facts";

export const metadata = { title: "Session — TenoTrainer" };

function quantity(value: number | null, label: string, load: number | null, loadUnit: string | null): string {
  const main = value == null ? "value not recorded" : `${Number.isInteger(value) ? value : Math.round(value * 100) / 100} ${label}`;
  return load != null ? `${main} · ${load} ${loadUnit ?? ""}`.trim() : main;
}

function editText(e: C5UnitEdit, label: string): string {
  const side = (x: C5UnitEdit["previous"]) => (x.outcome === "skipped" ? "skipped" : quantity(x.value, label, x.load, null));
  return `${side(e.previous)} → ${side(e.next)}`;
}

function UnitLine({ index, unit, label, tz }: { index: number; unit: C5UnitFact; label: string; tz: string }) {
  return (
    <li className="py-1.5 text-sm" data-c5-unit={unit.kind}>
      <span className="text-gray-500">Set {index + 1}: </span>
      {unit.kind === "not_recorded" ? (
        <span className="italic text-gray-500">Not recorded</span>
      ) : unit.kind === "skipped" ? (
        <span className="font-medium text-gray-900">Skipped</span>
      ) : (
        <span className="font-medium text-gray-900">{quantity(unit.value, label, unit.load, unit.loadUnit)}</span>
      )}
      {unit.kind !== "not_recorded" && unit.edits.length > 0 && (
        <ul className="mt-0.5 ml-4 text-xs text-gray-500" data-c5-edits={unit.edits.length}>
          {unit.edits.map((e, i) => (
            <li key={i}>
              Corrected by patient during the session: {editText(e, label)} ({formatPatientDateTime(e.editedAt, tz)})
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// M1 — one C5 session, every authoritative fact, no interpretation.
// The session id is read together with the authorized patient id; a
// session of any other patient is a 404.
export default async function ClinicianSessionDetailPage({ params }: { params: Promise<{ id: string; sessionId: string }> }) {
  const { id: patientId, sessionId } = await params;
  const { clinicianId } = await requireClinicianAuth();
  if (!(await assertSupervises(clinicianId, patientId))) notFound();

  const [header, c5, s] = await Promise.all([getPatientHeader(patientId), isC5Patient(patientId), getC5SessionDetail(patientId, sessionId)]);
  if (!header || !s) notFound();
  const tz = s.patientTimezone;

  return (
    <ClinicianPatientShell patientId={patientId} displayName={header.displayName} active="sessions" isC5={c5}>
      <Link href={`/clinician/patients/${patientId}/sessions`} className="text-sm font-medium text-brand-600">
        ← All sessions
      </Link>

      <Card title="Session" testId="c5-session-identity">
        <p className="text-lg font-semibold text-gray-900 break-words">
          {formatLocalDate(s.patientLocalDate)} · {s.workoutTitle}
        </p>
        <dl className="mt-3 divide-y divide-gray-50">
          <FactRow label="Status">
            <StatusText status={s.trainingStatus} />
          </FactRow>
          <FactRow label="Performed on (patient-local date)">{formatLocalDate(s.patientLocalDate)}</FactRow>
          {s.schedulingMode === "calendar" && (
            <FactRow label="Scheduled date">{s.calendarScheduledDate ? formatLocalDate(s.calendarScheduledDate) : "—"}</FactRow>
          )}
          {s.sequenceChoice && <FactRow label="Sequence choice">{SEQUENCE_CHOICE_LABELS[s.sequenceChoice] ?? s.sequenceChoice}</FactRow>}
          <FactRow label="Started">{formatPatientDateTime(s.startedAt, tz)}</FactRow>
          <FactRow label="Closed">{s.closedAt ? formatPatientDateTime(s.closedAt, tz) : "Not closed"}</FactRow>
          <FactRow label="Program version">
            {s.versionNumber != null ? `Version ${s.versionNumber}` : "—"} · {s.schedulingMode === "sequence" ? "Sequence" : "Calendar"}
          </FactRow>
          {s.schedulingMode === "sequence" && (
            <FactRow label="Weekly target in force">{s.targetSessionsPerWeek != null ? `${s.targetSessionsPerWeek} sessions per week (a target, not a quota)` : "None"}</FactRow>
          )}
          <FactRow label="Recommended recovery in force">
            {s.recoveryDays ? `${s.recoveryDays} day${s.recoveryDays === 1 ? "" : "s"} (advisory)` : "None"}
          </FactRow>
          {s.cautiousReturn && <FactRow label="Context">First session after a safety release</FactRow>}
        </dl>
      </Card>

      <Card title="Prescribed vs performed" testId="c5-session-performance">
        <p className="text-xs text-gray-500 mb-3">
          Prescribed values are from this session&apos;s frozen prescription. {s.units.completed} of {s.units.prescribed} sets completed
          {s.units.skipped ? `, ${s.units.skipped} skipped` : ""}.
        </p>
        <div className="space-y-4">
          {s.exercises.map((ex) => {
            const d = describeDosage(ex.dosage);
            return (
              <div key={ex.exerciseId} className="border-t border-gray-100 pt-3 first:border-0 first:pt-0" data-c5-exercise={ex.exerciseId}>
                <p className="text-sm font-semibold text-gray-900 break-words">{ex.name}</p>
                <p className="text-xs text-gray-600 mt-0.5">
                  Prescribed: {[d.headline, ...d.details, ...d.modifiers].filter(Boolean).join(" · ") || "—"}
                </p>
                {ex.additionalInstructions && <p className="text-xs text-gray-500 mt-0.5">Instructions: {ex.additionalInstructions}</p>}
                <ul className="mt-1">
                  {ex.units.map((u, i) => (
                    <UnitLine key={i} index={i} unit={u} label={ex.valueLabel} tz={tz} />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Post-session check-in" testId="c5-session-immediate">
        {s.immediate.kind === "none" ? (
          <p className="text-sm text-gray-500">The session is still open — no check-in yet.</p>
        ) : s.immediate.kind === "pending" ? (
          <p className="text-sm text-gray-600">Not yet submitted.</p>
        ) : (
          <dl className="divide-y divide-gray-50">
            <FactRow label="Peak pain during the session">
              <Score fact={s.immediate.peakPain} />
            </FactRow>
            <FactRow label="Session RPE">
              <Score fact={s.immediate.rpe} rpe />
            </FactRow>
            {(Object.keys(SAFETY_FACT_LABELS) as (keyof typeof SAFETY_FACT_LABELS)[]).map((k) => (
              <FactRow key={k} label={SAFETY_FACT_LABELS[k]}>
                {yesNoUnknown(s.immediate.kind === "submitted" ? s.immediate.safety[k] : null)}
              </FactRow>
            ))}
            <FactRow label="Submitted">{formatPatientDateTime(s.immediate.submittedAt, tz)}</FactRow>
          </dl>
        )}
      </Card>

      <Card title="Morning check-in" testId="c5-session-morning">
        {s.morning.kind === "none" ? (
          <p className="text-sm text-gray-500">The session is still open — no morning check-in yet.</p>
        ) : (
          <dl className="divide-y divide-gray-50">
            <FactRow label="Status">{morningStatusLabel(s.morning)}</FactRow>
            <FactRow label="Intended morning">{s.morning.referenceLocalDate ? formatLocalDate(s.morning.referenceLocalDate) : "—"}</FactRow>
            <FactRow label="Due from">{s.morning.dueAt ? formatPatientDateTime(s.morning.dueAt, tz) : "—"}</FactRow>
            {(s.morning.kind === "answered" || s.morning.kind === "unable_to_recall") && (
              <FactRow label="Submitted">{formatPatientDateTime(s.morning.submittedAt, tz)}</FactRow>
            )}
            {s.morning.kind === "unable_to_recall" && <FactRow label="Morning pain and stiffness">Unknown (unable to recall)</FactRow>}
            {s.morning.kind === "answered" && (
              <>
                <FactRow label="Morning pain">{s.morning.pain}/10</FactRow>
                <FactRow label="Morning stiffness">{s.morning.stiffness}/10</FactRow>
                <FactRow label="Stiffness duration">
                  {s.morning.stiffnessDuration ? STIFFNESS_DURATION_LABELS[s.morning.stiffnessDuration] : s.morning.stiffness === 0 ? "No stiffness" : "—"}
                </FactRow>
                <FactRow label="Note">{s.morning.note?.trim() ? s.morning.note : "None"}</FactRow>
              </>
            )}
          </dl>
        )}
      </Card>

      <Card title="Safety" testId="c5-session-safety">
        {!s.escalation ? (
          <p className="text-sm text-gray-500">No safety evaluation yet (it follows the post-session check-in).</p>
        ) : s.escalation.level >= 3 ? (
          <div className="text-sm">
            <p className="text-gray-900">
              A safety episode was raised from this session&apos;s check-in.{" "}
              <Link href={`/clinician/patients/${patientId}/safety`} className="font-medium text-brand-600 underline">
                View on the Safety page
              </Link>
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Provenance: escalation level {s.escalation.level} ({s.escalation.reason}), rule {s.escalation.ruleVersion}, evaluated{" "}
              {formatPatientDateTime(s.escalation.evaluatedAt, tz)}.
            </p>
          </div>
        ) : (
          <p className="text-sm text-gray-700">
            No safety concern reported. <span className="text-xs text-gray-500">(Provenance: escalation level {s.escalation.level}, rule {s.escalation.ruleVersion}.)</span>
          </p>
        )}
      </Card>

      {s.recoveryDecisions.length > 0 && (
        <Card title="Recovery guidance on this day" testId="c5-session-recovery">
          <ul className="space-y-2 text-sm">
            {s.recoveryDecisions.map((d, i) => (
              <li key={i}>
                <span className="font-medium text-gray-900">{d.decision === "continue" ? "Chose to continue" : "Chose to take a recovery day"}</span>{" "}
                <span className="text-gray-600">
                  — {formatPatientDateTime(d.decidedAt, tz)}. Recommended {d.recommendedRecoveryDays} recovery day
                  {d.recommendedRecoveryDays === 1 ? "" : "s"} after the session on {formatLocalDate(d.anchorStartLocalDate)} (earliest recommended day{" "}
                  {formatLocalDate(d.earliestRecommendedDate)}; {d.restDaysCompleted} rest day{d.restDaysCompleted === 1 ? "" : "s"} completed)
                  {d.weeklyTarget != null ? `; this week ${d.weeklyFinishedSessions ?? 0} of ${d.weeklyTarget} sessions` : ""}. Advisory only.
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </ClinicianPatientShell>
  );
}
