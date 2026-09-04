// Pure display-formatting helpers for canonical exercise/dosage data.
// Formats existing values only — never invents category names, cues, or units
// that aren't present in the canonical exercise-library data.

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

// Canonical dosage_defaults uses "reps_or_hold_time" — its value may be a plain
// number (15) or a descriptive string ("45s hold", "30-45s hold"). Display it
// as-given for a string (never force it through numeric parsing, which would
// silently drop "hold"/range qualifiers and misrepresent the prescription).
export function repsOrHoldLabel(dosage: Record<string, unknown>): string | null {
  const v = dosage.reps_or_hold_time;
  if (v == null || v === "") return null;
  return typeof v === "number" ? `${v} reps` : String(v);
}

export function dosageSummary(dosage: Record<string, unknown>): string {
  const parts: string[] = [];
  if (dosage.sets != null) parts.push(`${dosage.sets} sets`);
  const reps = repsOrHoldLabel(dosage);
  if (reps) parts.push(reps);
  const load = dosage.load_kg ?? dosage.load;
  if (load != null) parts.push(`${load} kg`);
  return parts.join(" · ");
}

// Per-set label (no "sets" count — that's implied by which row is showing).
export function prescribedSetLabel(dosage: Record<string, unknown>): string {
  const reps = repsOrHoldLabel(dosage);
  const load = dosage.load_kg ?? dosage.load;
  const parts: string[] = [];
  if (reps) parts.push(reps);
  if (load != null) parts.push(`${load} kg`);
  return parts.join(" · ") || "—";
}

export function tempoLabel(dosage: Record<string, unknown>): string | null {
  const tempo = dosage.tempo;
  return tempo == null || tempo === "" ? null : String(tempo);
}

export function restSeconds(dosage: Record<string, unknown>): number | null {
  const rest = dosage.rest;
  if (rest == null) return null;
  const n = typeof rest === "number" ? rest : parseFloat(String(rest));
  return Number.isFinite(n) ? n : null;
}

export function previousPerformanceSummary(perf: {
  sets: number | string | null;
  reps: number | string | null;
  load: number | string | null;
} | null): string | null {
  if (!perf) return null;
  const parts: string[] = [];
  if (perf.sets != null) parts.push(`${perf.sets}`);
  if (perf.reps != null) parts.push(`${perf.reps}`);
  const summary = parts.length > 0 ? parts.join(" × ") : "";
  if (perf.load != null) return summary ? `${summary} · ${perf.load} kg` : `${perf.load} kg`;
  return summary || null;
}
