"use client";

// Final M3 screen. Never says Well Tolerated / GO / STAY / CAUTION — that
// classification waits for Milestone 4's next-morning data. Routine sessions
// (Level 0) get the neutral "recorded, pending" message; Levels 1-2 add light
// contextual/protective guidance; Level 3 gets its own proportionate
// "warrant review" message; Level 5 repeats the FULL locked stop-loading
// language verbatim (Level5Screen already showed it earlier in the flow —
// this is a recap for a screen the patient may return to, not a repeat in
// place of it, and it must not be diluted into the weaker Level-3 wording).
export function OutcomeScreen({
  escalationLevel,
  onDone,
}: {
  escalationLevel: number;
  onDone: () => void;
}) {
  return (
    <div className="max-w-md mx-auto px-4 py-10 text-center">
      <h1 className="text-xl font-bold text-gray-900">Session Recorded</h1>
      <p className="text-sm text-gray-500 mt-1">Morning response pending.</p>

      {escalationLevel === 5 && (
        <div className="mt-6 bg-red-50 border-2 border-red-200 rounded-xl p-4 text-left">
          <p className="text-sm text-red-900 font-bold">Stop Loading</p>
          <p className="text-sm text-red-800 mt-1">Do not continue your Achilles exercises.</p>
          <p className="text-sm text-red-800 mt-1">Protect and offload the affected leg.</p>
          <p className="text-sm text-red-800 mt-1 font-semibold">Seek prompt medical evaluation.</p>
        </div>
      )}

      {escalationLevel === 3 && (
        <div className="mt-6 bg-red-50 border border-red-200 rounded-xl p-4 text-left">
          <p className="text-sm text-red-800 font-semibold">Your symptoms warrant review.</p>
          <p className="text-sm text-red-700 mt-1">
            Avoid further Achilles loading today and contact your clinician for guidance.
          </p>
        </div>
      )}

      {escalationLevel >= 1 && escalationLevel <= 2 && (
        <div className="mt-6 bg-amber-50 border border-amber-200 rounded-xl p-4 text-left">
          <p className="text-sm text-amber-800">
            Consider avoiding unnecessary extra Achilles loading today, and keep an eye on how things feel.
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={onDone}
        className="mt-6 w-full px-4 py-3.5 bg-brand-600 text-white text-base font-semibold rounded-lg"
      >
        Done
      </button>
    </div>
  );
}
