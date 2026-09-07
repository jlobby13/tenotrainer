"use client";

import { useState } from "react";

// Three independent structured observations — never merged into one
// checkbox/string. A missing answer stays null (unanswered), never false.
// popKnownTrue: when the patient already explicitly reported a pop during
// M2, that answer is shown as already-recorded rather than re-asked.
export function AcuteQuestionsScreen({
  popKnownTrue,
  onSubmit,
}: {
  popKnownTrue: boolean;
  onSubmit: (result: { suddenOrSharpPain: boolean; newFunctionalDifficulty: boolean; popFeltOrHeard: boolean }) => void;
}) {
  const [sudden, setSudden] = useState<boolean | null>(null);
  const [pop, setPop] = useState<boolean | null>(popKnownTrue ? true : null);
  const [functional, setFunctional] = useState<boolean | null>(null);

  const canContinue = sudden !== null && pop !== null && functional !== null;

  function YesNo({
    value,
    onChange,
    disabled,
  }: {
    value: boolean | null;
    onChange: (v: boolean) => void;
    disabled?: boolean;
  }) {
    return (
      <div className="flex gap-2 mt-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(true)}
          className={`flex-1 px-4 py-2.5 rounded-lg border-2 text-sm font-semibold disabled:opacity-60 ${
            value === true ? "border-brand-600 bg-brand-50 text-brand-700" : "border-gray-200 text-gray-700"
          }`}
        >
          Yes
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(false)}
          className={`flex-1 px-4 py-2.5 rounded-lg border-2 text-sm font-semibold disabled:opacity-60 ${
            value === false ? "border-brand-600 bg-brand-50 text-brand-700" : "border-gray-200 text-gray-700"
          }`}
        >
          No
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto px-4 py-10">
      <h1 className="text-xl font-bold text-gray-900">A few important questions</h1>

      <div className="mt-6">
        <p className="text-sm font-semibold text-gray-900">Did you feel sudden or sharp pain?</p>
        <YesNo value={sudden} onChange={setSudden} />
      </div>

      <div className="mt-6">
        <p className="text-sm font-semibold text-gray-900">Did you feel or hear a pop?</p>
        {popKnownTrue && <p className="text-xs text-amber-700 mt-0.5">Already recorded during your session.</p>}
        <YesNo value={pop} onChange={setPop} disabled={popKnownTrue} />
      </div>

      <div className="mt-6">
        <p className="text-sm font-semibold text-gray-900">Are you having new difficulty with function?</p>
        <p className="text-xs text-gray-400 mt-0.5">Walking, stairs, or other normal daily activities.</p>
        <YesNo value={functional} onChange={setFunctional} />
      </div>

      <button
        type="button"
        disabled={!canContinue}
        onClick={() =>
          canContinue &&
          onSubmit({ suddenOrSharpPain: sudden!, popFeltOrHeard: pop!, newFunctionalDifficulty: functional! })
        }
        className="mt-8 w-full px-4 py-3.5 bg-brand-600 text-white text-base font-semibold rounded-lg disabled:opacity-40"
      >
        Continue
      </button>
    </div>
  );
}
