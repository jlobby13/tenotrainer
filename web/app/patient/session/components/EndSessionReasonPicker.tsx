"use client";

import { useState } from "react";
import type { EarlyEndReason } from "@/lib/activeSession";

const OPTIONS: { value: EarlyEndReason; label: string }[] = [
  { value: "finished_what_i_could", label: "Finished what I could" },
  { value: "ran_out_of_time", label: "Ran out of time" },
  { value: "equipment_unavailable", label: "Equipment unavailable" },
  { value: "pain_symptoms", label: "Pain/symptoms" },
  { value: "other", label: "Other" },
];

export function EndSessionReasonPicker({
  onConfirm,
  onCancel,
}: {
  onConfirm: (reason: EarlyEndReason) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<EarlyEndReason | null>(null);

  return (
    <div className="fixed inset-0 bg-black/30 flex items-end sm:items-center justify-center z-50">
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm p-5">
        <p className="text-sm font-semibold text-gray-900">End this session?</p>
        <p className="text-xs text-gray-500 mt-1">Let us know why — this helps your clinician follow up.</p>
        <div className="mt-3 space-y-2">
          {OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setSelected(opt.value)}
              className={`w-full text-left px-3 py-2.5 rounded-lg border text-sm font-medium ${
                selected === opt.value ? "border-brand-500 bg-brand-50 text-brand-700" : "border-gray-200 text-gray-700"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2 mt-4">
          <button
            type="button"
            disabled={!selected}
            onClick={() => selected && onConfirm(selected)}
            className="flex-1 px-4 py-2.5 bg-brand-600 text-white text-sm font-semibold rounded-lg disabled:opacity-40"
          >
            End Session
          </button>
          <button type="button" onClick={onCancel} className="px-4 py-2.5 text-sm font-medium text-gray-500">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
