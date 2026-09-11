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

// M6 Stage 2 write-path finding: reps_or_hold_time spans at least four
// distinct semantics across the current exercise library — a plain rep
// count (int), a rep RANGE given as a string ("8-12"), a hold duration
// ("45s hold", "30-45s hold"), and a free-form cardio duration/activity
// description ("20 min total (1 min jog : 2 min walk)"). set_outcomes.
// prescribed_reps is a single NUMERIC column — it can only losslessly hold
// the first case. Parsing any of the string forms (as getPrescribedSet() in
// lib/activeSession.ts once did, before the M6 Stage 2 founder-acceptance
// patch fixed it to use this exact helper) would silently misrepresent a
// hold-time or range as a rep count. This helper deliberately does NOT do
// that: it mirrors the value only when it is already a plain number,
// otherwise returns null — an honest "not representable in this column"
// rather than a fabricated one. See lib/progressServer.ts's Loading History
// assembly for how the non-numeric case instead reads the full dosage
// object straight from that session's own prescription_snapshot.
export function safePrescribedReps(dosage: Record<string, unknown>): number | null {
  const v = dosage.reps_or_hold_time;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// No exercise in the current library's dosage_defaults carries any load
// field at all (verified against app/data/exercise_library.json — every
// loading_profile category is bodyweight-only today). load_kg/load already
// exist as typed, numeric-only fields on PrescriptionSnapshotExercise.dosage
// for a future clinician-prescribed external load; mirroring it here (only
// when it is already a plain number) costs nothing today (always null) and
// requires no schema change if that day comes.
export function safePrescribedLoad(dosage: Record<string, unknown>): number | null {
  const v = dosage.load_kg ?? dosage.load;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
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
