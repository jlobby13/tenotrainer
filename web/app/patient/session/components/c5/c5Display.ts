// C5.6D — pure display helpers for the C5 runtime UI (no lifecycle logic).
import type { C5Snapshot, C5WorkoutOption } from "@/lib/c5RuntimeTypes";

export function c5WorkoutTitle(workout: C5Snapshot["workout"]): string {
  const label = workout.label?.trim();
  if (!label) return `Workout ${String.fromCharCode(65 + workout.orderIndex)}`;
  return label.length <= 2 ? `Workout ${label}` : label;
}

function shortDate(isoDate: string): string {
  // A patient-local calendar date (YYYY-MM-DD) — format without shifting it.
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}

export function c5OptionLabel(option: C5WorkoutOption): string {
  switch (option.key) {
    case "scheduled_today":
      return "Today's scheduled workout";
    case "make_up":
      return option.calendarScheduledDate ? `Make-up for ${shortDate(option.calendarScheduledDate)}` : "Make-up workout";
    case "repeat_previous":
      return "Repeat previous workout";
    case "advance_next":
      return "Move to next workout";
    case "first":
      return "First workout";
    default:
      return "Next workout";
  }
}

export function formatValue(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}
