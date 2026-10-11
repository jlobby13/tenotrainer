// C5.4D — the finished-program presentation shared by Review and the
// read-only published view. Display only: no hooks, no editing controls, no
// client state (renders as a server component in both places). Every value
// shown comes from the snapshot it is given — a published version's
// snapshot is loaded from that version's own immutable rows, never from the
// current draft.

import {
  countExercises,
  describeDosage,
  focusLabel,
  formatWeekdays,
  phaseLabel,
  workoutDisplayLabel,
  workoutLetter,
  WEEKDAY_ORDER,
  type ProgramExercise,
  type ProgramSnapshot,
  type ReviewIssue,
} from "@/lib/prescriptionProgram";

export function ProgramView({ program, issues = [] }: { program: ProgramSnapshot; issues?: ReviewIssue[] }) {
  const exerciseIssues = new Map<string, string[]>();
  const workoutIssues = new Map<string, string[]>();
  for (const issue of issues) {
    if (issue.exerciseId) exerciseIssues.set(issue.exerciseId, [...(exerciseIssues.get(issue.exerciseId) ?? []), issue.message]);
    else if (issue.workoutId && issue.workoutLabel) workoutIssues.set(issue.workoutId, [...(workoutIssues.get(issue.workoutId) ?? []), issue.message]);
  }

  return (
    <div className="space-y-5">
      <ProgramSummary program={program} />
      {program.workouts.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-500">No workouts in this prescription.</p>
      ) : (
        program.workouts.map((workout, index) => (
          <WorkoutCard
            key={workout.id}
            program={program}
            index={index}
            exerciseIssues={exerciseIssues}
            workoutIssues={workoutIssues.get(workout.id) ?? []}
          />
        ))
      )}
    </div>
  );
}

function ProgramSummary({ program }: { program: ProgramSnapshot }) {
  const exerciseTotal = countExercises(program);
  return (
    <section className="bg-white rounded-xl shadow border border-gray-100 p-4 sm:p-5 space-y-4" data-testid="program-summary">
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 text-sm">
        {program.phase && <SummaryItem label="Phase" value={phaseLabel(program.phase)} testId="summary-phase" />}
        <SummaryItem
          label="Schedule"
          value={program.schedulingMode === "sequence" ? "Sequence" : program.schedulingMode === "calendar" ? "Calendar" : "Not set"}
          testId="summary-schedule-mode"
          muted={program.schedulingMode === null}
        />
        <SummaryItem label="Workouts" value={String(program.workouts.length)} testId="summary-workout-count" />
        <SummaryItem label="Exercises" value={String(exerciseTotal)} testId="summary-exercise-count" />
        {program.performanceFocuses.length > 0 && (
          <div className="col-span-2 sm:col-span-4" data-testid="summary-focus">
            <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Performance Focus</dt>
            <dd className="mt-1 flex flex-wrap gap-1.5">
              {program.performanceFocuses.map((f) => (
                <span key={f} className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">
                  {focusLabel(f)}
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>
      <ScheduleSummary program={program} />
    </section>
  );
}

function SummaryItem({ label, value, testId, muted }: { label: string; value: string; testId: string; muted?: boolean }) {
  return (
    <div data-testid={testId}>
      <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className={`mt-0.5 font-semibold ${muted ? "text-gray-400" : "text-gray-900"}`}>{value}</dd>
    </div>
  );
}

// Sequence never implies weekdays; Calendar shows the actual week.
function ScheduleSummary({ program }: { program: ProgramSnapshot }) {
  const letters = program.workouts.map((_, i) => workoutLetter(i));
  if (program.schedulingMode === "sequence") {
    return (
      <div className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2.5 text-sm text-gray-700" data-testid="schedule-sequence">
        <p>
          {program.targetSessionsPerWeek != null ? (
            <span className="font-semibold text-gray-900" data-testid="schedule-target">
              {program.targetSessionsPerWeek} {program.targetSessionsPerWeek === 1 ? "session" : "sessions"} per week
            </span>
          ) : (
            <span className="font-semibold text-gray-400" data-testid="schedule-target">No sessions-per-week target set</span>
          )}
          {letters.length > 0 && (
            <>
              {" "}
              — workouts are completed in order ({letters.join(" → ")}), then repeat.
            </>
          )}
        </p>
        <p className="mt-0.5 text-xs text-gray-500">Not tied to specific weekdays. A missed workout remains next until completed.</p>
      </div>
    );
  }
  if (program.schedulingMode === "calendar") {
    const byDay = new Map<number, { letter: string; label: string }[]>();
    program.workouts.forEach((w, i) => {
      for (const d of w.daysOfWeek ?? []) byDay.set(d, [...(byDay.get(d) ?? []), { letter: workoutLetter(i), label: workoutDisplayLabel(w, i) }]);
    });
    return (
      <div data-testid="schedule-calendar">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500 mb-1.5">Weekly schedule</p>
        <ol className="grid grid-cols-7 gap-1">
          {WEEKDAY_ORDER.map((day) => {
            const assigned = byDay.get(day.value) ?? [];
            return (
              <li
                key={day.value}
                className={`rounded-lg border px-0.5 py-1.5 text-center ${assigned.length > 0 ? "border-brand-200 bg-brand-50" : "border-gray-100 bg-gray-50"}`}
                data-testid="calendar-day"
                data-day={day.short}
                data-workouts={assigned.map((a) => a.letter).join(",")}
              >
                <div className="text-[11px] font-medium text-gray-500">{day.short}</div>
                {assigned.length > 0 ? (
                  assigned.map((a) => (
                    <div key={a.letter} className="text-sm font-bold text-brand-700" title={a.label}>
                      {a.letter}
                    </div>
                  ))
                ) : (
                  <div className="text-[11px] text-gray-400">Rest</div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    );
  }
  return <p className="text-sm text-gray-400">No scheduling mode set.</p>;
}

function WorkoutCard({
  program,
  index,
  exerciseIssues,
  workoutIssues,
}: {
  program: ProgramSnapshot;
  index: number;
  exerciseIssues: Map<string, string[]>;
  workoutIssues: string[];
}) {
  const workout = program.workouts[index];
  const label = workoutDisplayLabel(workout, index);
  const days = formatWeekdays(workout.daysOfWeek);
  return (
    <section
      className={`bg-white rounded-xl shadow border p-4 sm:p-5 ${workoutIssues.length > 0 ? "border-red-200" : "border-gray-100"}`}
      data-testid="program-workout"
      data-workout-label={label}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white" aria-hidden="true">
          {workoutLetter(index)}
        </span>
        <h3 className="text-base font-semibold text-gray-900 min-w-0 break-words">{label}</h3>
        {program.schedulingMode === "calendar" && (
          <span className="flex flex-wrap gap-1" data-testid="workout-days">
            {days.length > 0 ? (
              days.map((d) => (
                <span key={d} className="rounded-md bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700">
                  {d}
                </span>
              ))
            ) : (
              <span className="rounded-md bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700">No weekday</span>
            )}
          </span>
        )}
        <span className="ml-auto text-xs text-gray-500">
          {workout.exercises.length} {workout.exercises.length === 1 ? "exercise" : "exercises"}
        </span>
      </header>
      {workoutIssues.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-sm text-red-700" data-testid="workout-issue">
          {workoutIssues.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      {workout.exercises.length > 0 && (
        <ol className="mt-3 divide-y divide-gray-100">
          {workout.exercises.map((exercise, i) => (
            <ExerciseRow key={exercise.id} exercise={exercise} number={i + 1} issues={exerciseIssues.get(exercise.id) ?? []} />
          ))}
        </ol>
      )}
    </section>
  );
}

function ExerciseRow({ exercise, number, issues }: { exercise: ProgramExercise; number: number; issues: string[] }) {
  const description = exercise.dosage ? describeDosage(exercise.dosage) : null;
  const instructions = exercise.instructions?.trim();
  return (
    <li className="py-3 first:pt-0 last:pb-0 flex gap-3" data-testid="program-exercise" data-exercise-name={exercise.name} data-has-issue={issues.length > 0 ? "true" : undefined}>
      <span className="w-5 shrink-0 pt-0.5 text-right text-sm font-semibold text-gray-400">{number}.</span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-gray-900 break-words" data-testid="program-exercise-name">
            {exercise.name}
          </span>
          {exercise.status === "paused" && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-600" data-testid="exercise-paused">
              Paused
            </span>
          )}
        </div>
        {description ? (
          <div className="text-sm text-gray-700 space-y-0.5" data-testid="program-dosage">
            {(description.headline || description.details.length > 0) && (
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                {description.headline && (
                  <span className="text-base font-semibold text-gray-900" data-testid="dosage-headline">
                    {description.headline}
                  </span>
                )}
                {description.details.map((d) => (
                  <span key={d} data-testid="dosage-detail" className="before:content-['·'] before:mr-2 before:text-gray-300 first:before:content-none first:before:mr-0">
                    {d}
                  </span>
                ))}
              </p>
            )}
            {description.modifiers.length > 0 && (
              <p className="flex flex-wrap gap-x-2 gap-y-0.5 text-gray-600">
                {description.modifiers.map((m) => (
                  <span key={m} data-testid="dosage-modifier" className="before:content-['·'] before:mr-2 before:text-gray-300 first:before:content-none first:before:mr-0">
                    {m}
                  </span>
                ))}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm font-medium text-red-700" data-testid="dosage-missing">
            No dosage saved
          </p>
        )}
        {instructions && (
          <p className="border-l-2 border-brand-200 pl-2.5 text-sm text-gray-700 whitespace-pre-line break-words" data-testid="program-instructions">
            {instructions}
          </p>
        )}
        {issues
          .filter((m) => !(description === null && m === "No dosage saved."))
          .map((m) => (
            <p key={m} className="text-sm text-red-700" data-testid="exercise-issue">
              {m}
            </p>
          ))}
      </div>
    </li>
  );
}
