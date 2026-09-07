"use client";

// Shown IMMEDIATELY when a pop is reported — before any ordinary response
// collection. Safety messaging first, data completion second. Deliberately
// static (no server round-trip needed to know pop => Level 5) and does not
// use universal "immobilize" language.
export function Level5Screen({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="max-w-md mx-auto px-4 py-10 text-center">
      <div className="bg-red-50 border-2 border-red-200 rounded-xl p-6">
        <h1 className="text-xl font-bold text-red-900">Stop Loading</h1>
        <p className="text-sm text-red-800 mt-3">Do not continue Achilles exercises.</p>
        <p className="text-sm text-red-800 mt-2">Protect and offload the affected leg.</p>
        <p className="text-sm text-red-800 mt-2 font-semibold">Seek prompt medical evaluation.</p>
      </div>
      <button
        type="button"
        onClick={onContinue}
        className="mt-6 w-full px-4 py-3.5 bg-brand-600 text-white text-base font-semibold rounded-lg"
      >
        Continue
      </button>
    </div>
  );
}
