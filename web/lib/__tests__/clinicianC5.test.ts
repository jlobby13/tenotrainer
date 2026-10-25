// M1 — pure clinician C5 display helpers. Run: compile with tsc, then node.
import {
  RPE_DESCRIPTORS,
  c5EligibilityLabel,
  daysBetween,
  episodeProcessState,
  formatRpe,
  formatScore,
  morningStatusLabel,
  rpeDescriptor,
  safetyProcessLabel,
  scoreFact,
  trainingStatusLabel,
} from "../clinicianC5";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${e instanceof Error ? e.message : String(e)}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---- RPE descriptor: the locked 0–10 table ----
const LOCKED: [number, string][] = [
  [0, "At rest"],
  [1, "Very easy"],
  [2, "Somewhat easy"],
  [3, "Moderate"],
  [4, "Somewhat hard"],
  [5, "Hard"],
  [6, "Hard"],
  [7, "Very hard"],
  [8, "Very hard"],
  [9, "Very hard"],
  [10, "Very, very hard"],
];
for (const [n, label] of LOCKED) {
  test(`RPE ${n} -> "${label}"`, () => eq(rpeDescriptor(n), label, `rpe ${n}`));
}
test("RPE table has exactly 11 entries (0–10)", () => eq(RPE_DESCRIPTORS.length, 11, "length"));
test('formatRpe(7) is "7 · Very hard" — the number is never changed', () => eq(formatRpe(7), "7 · Very hard", "format"));
test("RPE outside 0–10 or non-integer is rejected (never smoothed)", () => {
  for (const bad of [-1, 11, 6.5, Number.NaN]) {
    let threw = false;
    try {
      rpeDescriptor(bad);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`accepted ${bad}`);
  }
});

// ---- UNKNOWN != ZERO ----
test("a recorded 0 is the value 0", () => eq(scoreFact(0, false), { kind: "value", value: 0 }, "zero"));
test("unable to recall is unknown, never 0", () => {
  eq(scoreFact(null, true), { kind: "unable_to_recall" }, "utr");
  eq(formatScore(scoreFact(null, true)), "Unknown (unable to recall)", "utr text");
});
test("not yet submitted is distinct from unknown", () => eq(formatScore(scoreFact(null, false)), "Not yet submitted", "pending"));
test("RPE 0 renders as '0 · At rest', not as unknown", () => eq(formatScore(scoreFact(0, false), formatRpe), "0 · At rest", "rpe0"));

// ---- morning timing: intended morning != submitted_at ----
test("morning submitted later than the intended morning states the delay", () => {
  const label = morningStatusLabel({
    kind: "answered", pain: 2, stiffness: 1, stiffnessDuration: "lt_5_min", note: null,
    dueAt: "2026-10-20T09:00:00Z", referenceLocalDate: "2026-10-20", submittedAt: "2026-10-22T13:00:00Z", daysAfterReference: 2,
  });
  eq(label, "Submitted (2 days after the intended morning)", "late");
});
test("on-time morning is just 'Submitted'", () =>
  eq(morningStatusLabel({ kind: "answered", pain: 0, stiffness: 0, stiffnessDuration: null, note: null, dueAt: null, referenceLocalDate: "2026-10-20", submittedAt: "2026-10-20T10:00:00Z", daysAfterReference: 0 }), "Submitted", "on time"));
test("due vs not yet due vs unable to recall are distinct", () => {
  eq(morningStatusLabel({ kind: "due", dueAt: null, referenceLocalDate: null }), "Due — not yet submitted", "due");
  eq(morningStatusLabel({ kind: "not_yet_due", dueAt: null, referenceLocalDate: null }), "Not yet due", "nyd");
  eq(morningStatusLabel({ kind: "unable_to_recall", dueAt: null, referenceLocalDate: null, submittedAt: "x", daysAfterReference: 0 }), "Submitted — unable to recall", "utr");
});
test("daysBetween counts calendar days", () => eq([daysBetween("2026-10-20", "2026-10-22"), daysBetween("2026-12-31", "2027-01-01")], [2, 1], "days"));

// ---- status / safety language ----
test("Stopped Acute is never labelled like Stopped Early or Finished", () => {
  const labels = (["finished", "stopped_early", "stopped_pause", "stopped_acute", "started"] as const).map(trainingStatusLabel);
  eq(new Set(labels).size, 5, "distinct");
  eq(trainingStatusLabel("stopped_acute"), "Stopped for a safety concern", "acute");
});
test("process language: release required / check-in pending / released", () => {
  eq(episodeProcessState({ released: false, requiresClinicianRelease: true }), "clinician_release_required", "req");
  eq(episodeProcessState({ released: false, requiresClinicianRelease: false }), "safety_check_in_pending", "pending");
  eq(episodeProcessState({ released: true, requiresClinicianRelease: true }), "released", "released");
  eq(safetyProcessLabel("clinician_release_required"), "Clinician release required", "label");
});
test("no L3/L4/L5 in primary safety labels", () => {
  for (const s of ["clinician_release_required", "safety_check_in_pending", "released"] as const) if (/level|L[345]/i.test(safetyProcessLabel(s))) throw new Error(s);
});
test("eligibility: a professional-review hold reads as clinician release; recovery stays advisory", () => {
  eq(c5EligibilityLabel({ kind: "acute_blocked", gate: "acute_safety_professional_review_required" }), "Training hold active — clinician release required", "hold");
  eq(c5EligibilityLabel({ kind: "available", recovery: {} }), "Eligible to train (advisory recovery guidance shown)", "recovery");
  eq(c5EligibilityLabel({ kind: "available" }), "Eligible to train", "plain");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
