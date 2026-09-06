"use client";

import { useState } from "react";
import { normalizeMorningReminderTime } from "@/lib/morningEligibility";

function buildTimeOptions(): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 15, 30, 45]) {
      const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
      const hour12 = h % 12 === 0 ? 12 : h % 12;
      const period = h < 12 ? "AM" : "PM";
      const label = `${hour12}:${String(m).padStart(2, "0")} ${period}`;
      options.push({ value, label });
    }
  }
  return options;
}

const TIME_OPTIONS = buildTimeOptions();

// Full 24-hour range, 15-minute increments — the Stage 3 session-triggered
// gate (not built yet) is what actually enforces the clinical sequence
// regardless of this preference, so there's no need to restrict unusual
// sleep/work schedules here.
export function ReminderTimeSetting({ initialTime }: { initialTime: string }) {
  const [time, setTime] = useState(normalizeMorningReminderTime(initialTime));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(value: string) {
    setTime(value);
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/api/patient/reminder-time", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ morningReminderTime: value }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Failed to save");
      }
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <label htmlFor="morning-reminder-time" className="text-sm font-semibold text-gray-900">
        Morning Check-In Time
      </label>
      <p className="text-xs text-gray-500 mt-1 mb-3">
        This controls when TenoTrainer normally prompts and prioritizes your next-day tendon check-in. Changing it
        only affects future check-ins — it won&apos;t change one that&apos;s already scheduled.
      </p>
      <select
        id="morning-reminder-time"
        value={time}
        onChange={(e) => handleChange(e.target.value)}
        disabled={saving}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm disabled:opacity-60"
      >
        {TIME_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {saved && <p className="text-xs text-green-600 mt-2">Saved.</p>}
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}
