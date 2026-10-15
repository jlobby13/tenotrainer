// C5.6D — the C5 runtime's pure input shaping: which field a unit asks for
// (mirroring c5_performance_error's primary-quantity rule), that only an
// EXACT prescription is ever offered as a one-tap / default value (a range
// never becomes a fabricated number), unit counts, and the payload/display
// round trip (distance stored in metres, shown in the prescribed unit).
import { completedPayload, outcomeValue, payloadToOutcome, skippedPayload, unitCount, unitEntry } from "../c5RuntimeTypes";
import type { DosageInput } from "../prescriptionDraftTypes";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
}
function eq(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const reps: DosageInput = { dosageType: "repetition", sets: 3, repsMode: "exact", repsExact: 8, loadType: "external", loadMode: "exact", loadValueExact: 20, loadUnit: "kg" };
const repRange: DosageInput = { dosageType: "repetition", sets: 3, repsMode: "range", repsMin: 8, repsMax: 12, loadType: "not_applicable" };
const hold: DosageInput = { dosageType: "hold", sets: 2, holdDurationMode: "exact", holdDurationExactSeconds: 45, loadType: "bodyweight" };
const interval: DosageInput = { dosageType: "time", intervalWorkSeconds: 30, intervalRecoverySeconds: 30, intervalRounds: 6, loadType: "not_applicable" };
const contacts: DosageInput = { dosageType: "contact", sets: 4, contactsMode: "exact", contactsExact: 20, loadType: "not_applicable" };
const distance: DosageInput = { dosageType: "distance", distanceMode: "exact", distanceExactValue: 1.5, distanceUnit: "km", loadType: "not_applicable" };

test("unitCount = sets, else interval rounds, else 1", () => {
  eq([unitCount(reps), unitCount(interval), unitCount(distance)], [3, 6, 1]);
});

test("repetition: reps field, exact value offered, external load prefilled", () => {
  const e = unitEntry(reps);
  eq([e.field, e.prescribedExact, e.load], ["reps", 8, { unit: "kg", prescribedExact: 20 }]);
});

test("a rep RANGE never becomes a one-tap number", () => {
  eq(unitEntry(repRange).prescribedExact, null);
});

test("hold -> seconds; bodyweight has no load input", () => {
  const e = unitEntry(hold);
  eq([e.field, e.prescribedExact, e.load], ["duration", 45, null]);
});

test("interval time -> seconds, work interval as the exact value", () => {
  eq([unitEntry(interval).field, unitEntry(interval).prescribedExact], ["duration", 30]);
});

test("contacts -> actual_reps", () => {
  const p = completedPayload("ex", 0, unitEntry(contacts), 20, null);
  eq([p.actual_reps, p.actual_duration_seconds], [20, undefined]);
});

test("hold payload carries actual_duration_seconds only", () => {
  eq(completedPayload("ex", 1, unitEntry(hold), 40, null), { exercise_id: "ex", unit_index: 1, outcome: "completed", actual_duration_seconds: 40 });
});

test("load is sent with its unit, never without", () => {
  const p = completedPayload("ex", 0, unitEntry(reps), 8, 22.5);
  eq([p.actual_load, p.actual_load_unit], [22.5, "kg"]);
  const q = completedPayload("ex", 0, unitEntry(reps), 8, null);
  eq([q.actual_load, q.actual_load_unit], [undefined, undefined]);
});

test("distance: entered in the prescribed unit, stored in metres, shown back in that unit", () => {
  const e = unitEntry(distance);
  const p = completedPayload("ex", 0, e, 1.5, null);
  eq(p.actual_distance_m, 1500);
  eq(outcomeValue(e, payloadToOutcome(p)), 1.5);
});

test("a skip carries no quantities", () => {
  eq(skippedPayload("ex", 2), { exercise_id: "ex", unit_index: 2, outcome: "skipped" });
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
