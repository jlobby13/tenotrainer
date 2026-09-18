import {
  formatDifficultyLabel,
  formatExerciseOutcomeLabel,
  formatExternalLoadCategoryLabel,
  formatExternalLoadTimingLabel,
  formatImmediateGuidanceLabel,
  formatLoadObservationProvenanceLabel,
  formatPainLabel,
  formatSetActualLabel,
  formatSetPrescribedLabel,
  formatStiffnessDurationLabel,
  summarizeMorningResponse,
  type PrescribedVsActualExercise,
} from "@/lib/clinicianPatientOverview";
import { formatLastSessionLabel } from "@/lib/clinicianRoster";
import type { SessionOverviewEntry } from "@/lib/clinicianPatientOverviewServer";

// C2 — Patient Clinical Overview. A collapsed-by-default, independently
// expandable session card (LOCKED — Section 2 of the C2 brief: uniform
// cards, never auto-privileging the latest session). Uses the native
// <details>/<summary> element rather than a client component: expand/
// collapse is the only interactivity this page needs, and <details> gives
// it for free, server-rendered, with zero client JS — matching C1A/C1B's
// own "fully Next.js-native, nothing here needs client state" precedent.
export function RecentSessionCard({ session, now }: { session: SessionOverviewEntry; now: Date }) {
  const dateLabel = formatLastSessionLabel(session.startedAt, now);
  const sessionResponseLabel = session.tolerance ? session.tolerance.patientFacingLabel : "Not yet evaluated";

  return (
    <details className="group bg-white rounded-xl shadow border border-gray-100">
      {/* Collapsed summary — Section 3: a useful factual snapshot without
          expanding. UNKNOWN != ZERO throughout (each value below is already
          formatted that way by its own pure formatter). */}
      <summary className="cursor-pointer list-none px-4 py-3 flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="font-medium text-gray-900">{dateLabel}</span>
          <span className="text-xs text-gray-400 group-open:hidden">Show details</span>
          <span className="text-xs text-gray-400 hidden group-open:inline">Hide details</span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600">
          <span>{formatExerciseOutcomeLabel(session.exerciseOutcome)}</span>
          <span>Peak pain: {formatPainLabel(session.peakSessionPain)}</span>
          <span>Difficulty: {formatDifficultyLabel(session.difficulty)}</span>
          <span>{summarizeMorningResponse(session)}</span>
          <span>Session Response: {sessionResponseLabel}</span>
        </div>
      </summary>

      <div className="border-t border-gray-100 px-4 py-4 space-y-5">
        {/* A. Session outcome */}
        <section>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Session Outcome</h3>
          <p className="text-sm text-gray-700">
            {formatExerciseOutcomeLabel(session.exerciseOutcome)}
            {session.earlyEndReason ? ` — ${session.earlyEndReason}` : ""}
          </p>
        </section>

        {/* B. Prescribed vs Actual — one block per exercise, never one giant
            session-wide table (Section 9). */}
        <section>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Prescribed vs Actual</h3>
          {session.exercises.length === 0 ? (
            <p className="text-sm text-gray-500">No exercises recorded for this session.</p>
          ) : (
            <div className="space-y-4">
              {session.exercises.map((exercise) => (
                <ExerciseSetBlock key={exercise.exId} exercise={exercise} />
              ))}
            </div>
          )}
        </section>

        {/* C. Session response */}
        <section>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Session Response</h3>
          <p className="text-sm text-gray-700">Difficulty: {formatDifficultyLabel(session.difficulty)}</p>
          <p className="text-sm text-gray-700">Peak session pain: {formatPainLabel(session.peakSessionPain)}</p>
        </section>

        {/* D. Morning response */}
        <section>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Morning Response</h3>
          {session.morningResponse ? (
            <>
              <p className="text-sm text-gray-700">Next-morning pain: {formatPainLabel(session.morningResponse.nextMorningPain)}</p>
              <p className="text-sm text-gray-700">Stiffness intensity: {formatPainLabel(session.morningResponse.nextMorningStiffness)}</p>
              <p className="text-sm text-gray-700">
                Stiffness duration:{" "}
                {formatStiffnessDurationLabel(session.morningResponse.nextMorningStiffness, session.morningResponse.stiffnessDuration)}
              </p>
              {session.morningResponse.submittedAt === null && <p className="text-sm text-amber-700">{summarizeMorningResponse(session)}</p>}
            </>
          ) : (
            <p className="text-sm text-gray-700">Not yet recorded</p>
          )}
        </section>

        {/* E. Session Response interpretation — an EXISTING persisted
            single-session result, displayed verbatim, explicitly framed as
            this session's response, never a trajectory statement. */}
        <section>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Session Response (this session only)</h3>
          {session.tolerance ? (
            <>
              <p className="text-sm font-medium text-gray-900">{session.tolerance.patientFacingLabel}</p>
              <p className="text-sm text-gray-700">Guidance: {formatImmediateGuidanceLabel(session.tolerance.immediateGuidance)}</p>
              <p className="text-sm text-gray-500">{session.tolerance.reason}</p>
            </>
          ) : (
            <p className="text-sm text-gray-700">Not yet evaluated</p>
          )}
        </section>

        {/* F. External loading context — compact, factual, never scored. */}
        <section>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">External Loading Context</h3>
          {session.externalLoad.length === 0 ? (
            <p className="text-sm text-gray-700">Not asked</p>
          ) : (
            <ul className="text-sm text-gray-700 space-y-0.5">
              {session.externalLoad.map((obs, i) => (
                <li key={i}>
                  {formatExternalLoadCategoryLabel(obs.category)}
                  {obs.timing ? ` · ${formatExternalLoadTimingLabel(obs.timing)}` : ""}
                  {" · "}
                  <span className="text-gray-400">{formatLoadObservationProvenanceLabel(obs.capturedDuring)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* G. Acute event reference — restrained cross-reference only, no
            duplicated episode detail (that lives in Acute Safety History). */}
        {session.acuteEpisodeId && (
          <section>
            <p className="text-sm text-red-700">This session is linked to an entry in Acute Safety History below.</p>
          </section>
        )}
      </div>
    </details>
  );
}

// One exercise block, compact set-level grid inside. Desktop renders a
// small table (Set | Prescribed | Actual); mobile renders the same facts as
// vertical rows — never a giant session-wide table, never horizontal
// scrolling (Sections 9-10).
function ExerciseSetBlock({ exercise }: { exercise: PrescribedVsActualExercise }) {
  return (
    <div className="border border-gray-100 rounded-lg p-3">
      <p className="text-sm font-medium text-gray-900 mb-2">{exercise.name}</p>

      <table className="hidden md:table w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-500">
            <th className="pr-4 py-1 font-medium">Set</th>
            <th className="pr-4 py-1 font-medium">Prescribed</th>
            <th className="py-1 font-medium">Actual</th>
          </tr>
        </thead>
        <tbody>
          {exercise.sets.map((set) => (
            <tr key={set.setIndex} className="border-t border-gray-50">
              <td className="pr-4 py-1 text-gray-500">{set.setIndex}</td>
              <td className="pr-4 py-1 text-gray-700">{formatSetPrescribedLabel(set, exercise.loadingProfile)}</td>
              <td className="py-1 text-gray-700">
                {formatSetActualLabel(set, exercise.loadingProfile)}
                {set.wasEdited && set.outcome === "completed" && <span className="text-gray-400"> (edited)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="md:hidden space-y-2 text-sm">
        {exercise.sets.map((set) => (
          <div key={set.setIndex} className="border-t border-gray-50 pt-2 first:border-0 first:pt-0">
            <p className="text-gray-500">Set {set.setIndex}</p>
            <p className="text-gray-700">Prescribed: {formatSetPrescribedLabel(set, exercise.loadingProfile)}</p>
            <p className="text-gray-700">
              Actual: {formatSetActualLabel(set, exercise.loadingProfile)}
              {set.wasEdited && set.outcome === "completed" && <span className="text-gray-400"> (edited)</span>}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
