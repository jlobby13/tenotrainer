"use client";

// C5.6E — an integer 0-10 picker. Two rows on phones (0-5 / 6-10) so every
// option stays a comfortable tap target; one row from `sm` up. No value is
// preselected: nothing is ever submitted unless the patient picks it.
export function ScoreScale({
  name,
  label,
  value,
  onChange,
  disabled = false,
}: {
  name: string;
  // PEC — the patient-facing accessible name of the whole scale.
  label: string;
  value: number | null;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-6 gap-2 sm:grid-cols-11" data-score-scale={name}>
      {Array.from({ length: 11 }, (_, n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          disabled={disabled}
          onClick={() => onChange(n)}
          className={`min-h-11 rounded-xl border text-base font-semibold transition-colors disabled:opacity-40 ${
            value === n ? "border-teal-300 bg-teal-400 text-slate-950" : "border-slate-700 bg-slate-950/60 text-slate-200 hover:border-teal-400/60"
          }`}
        >
          {n}
        </button>
      ))}
    </div>
  );
}
