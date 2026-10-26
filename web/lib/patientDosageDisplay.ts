// PEC — PATIENT presentation of a prescribed dosage. A display
// transformation only: the stored prescription and the clinician-facing
// describeDosage() are unchanged. Clinician shorthand becomes plain
// language, and rest is pulled out so it can be shown prominently.
import { describeDosage, type DosageDescription } from "./prescriptionProgram";
import type { DosageInput } from "./prescriptionDraftTypes";

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// "Rest 90 sec", "Rest 2 min", "Rest 2 min 30 sec".
export function patientRestLabel(restSeconds: number | null | undefined): string | null {
  if (restSeconds == null || !(restSeconds > 0)) return null;
  if (restSeconds < 120) return `Rest ${trim(restSeconds)} sec`;
  const min = Math.floor(restSeconds / 60);
  const sec = Math.round(restSeconds % 60);
  return sec === 0 ? `Rest ${min} min` : `Rest ${min} min ${sec} sec`;
}

const PATIENT_SIDE_LABELS: Partial<Record<NonNullable<DosageInput["side"]>, string>> = {
  bilateral: "Both sides together",
  left: "Left side",
  right: "Right side",
  both_sides_separately: "Each side separately",
};

export type PatientDosageDescription = DosageDescription & { rest: string | null };

export function describePatientDosage(d: DosageInput): PatientDosageDescription {
  // Rebuild the clinician description without the dimensions we re-phrase.
  const base = describeDosage({ ...d, restSeconds: null, rpe: null, rir: null, rom: null, side: null });
  const modifiers = [...base.modifiers];
  if (d.rpe != null) modifiers.push(`Effort: about ${trim(d.rpe)} out of 10`);
  if (d.rir != null) modifiers.push(`Stop with about ${trim(d.rir)} ${d.rir === 1 ? "rep" : "reps"} left`);
  const rom = d.rom?.trim();
  if (rom) modifiers.push(`Range of motion: ${rom}`);
  const side = d.side ? PATIENT_SIDE_LABELS[d.side] : undefined;
  if (side) modifiers.push(side);
  return { headline: base.headline, details: base.details, modifiers, rest: patientRestLabel(d.restSeconds) };
}
