// C1B — Clinician Dashboard & Roster. Pure-function regression tests for
// clinicianRoster.ts. No test framework is wired up for the web/ package
// (only Playwright e2e exists) — this is a plain, dependency-free script
// matching the convention already used for M4's morningEligibility tests.

import {
  compareRosterEntries,
  deriveMorningResponseBadge,
  formatLastSessionLabel,
  formatRecentActivityLabel,
  formatStageLabel,
} from "../clinicianRoster";

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
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
function assertEqual<T>(actual: T, expected: T, msg: string) {
  const same = Array.isArray(actual) && Array.isArray(expected) ? JSON.stringify(actual) === JSON.stringify(expected) : actual === expected;
  if (!same) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const NOW = new Date("2026-09-16T12:00:00.000Z");

// --- deriveMorningResponseBadge -------------------------------------------

test("no outstanding responses -> no badge", () => {
  assertEqual(deriveMorningResponseBadge([], NOW), null, "empty list");
});

test("scheduled_eligible_at in the past -> due", () => {
  const result = deriveMorningResponseBadge([{ scheduledEligibleAt: "2026-09-16T05:00:00.000Z" }], NOW);
  assertEqual(result, "due", "past eligibility should be due");
});

test("scheduled_eligible_at exactly now -> due (inclusive boundary)", () => {
  const result = deriveMorningResponseBadge([{ scheduledEligibleAt: NOW.toISOString() }], NOW);
  assertEqual(result, "due", "eligible-at-now should be due, not pending or none");
});

test("scheduled_eligible_at in the future -> no badge (not yet due, never 'overdue')", () => {
  const result = deriveMorningResponseBadge([{ scheduledEligibleAt: "2026-09-17T05:00:00.000Z" }], NOW);
  assertEqual(result, null, "future eligibility should render no badge");
});

test("scheduled_eligible_at null (unknown eligibility) -> pending, never due, never none", () => {
  const result = deriveMorningResponseBadge([{ scheduledEligibleAt: null }], NOW);
  assertEqual(result, "pending", "unknown eligibility should be pending (UNKNOWN != ZERO)");
});

test("one future + one unknown -> pending (unknown wins over not-yet-due)", () => {
  const result = deriveMorningResponseBadge(
    [{ scheduledEligibleAt: "2026-09-20T05:00:00.000Z" }, { scheduledEligibleAt: null }],
    NOW
  );
  assertEqual(result, "pending", "unknown outstanding obligation must still surface as pending");
});

test("one unknown + one due -> due (due takes priority over pending)", () => {
  const result = deriveMorningResponseBadge(
    [{ scheduledEligibleAt: null }, { scheduledEligibleAt: "2026-09-16T00:00:00.000Z" }],
    NOW
  );
  assertEqual(result, "due", "due must take priority over pending when mixed");
});

// --- compareRosterEntries (alphabetical, case-insensitive, deterministic) --

test("case-insensitive alphabetical ordering", () => {
  const entries = [
    { displayName: "bob smith", patientId: "b" },
    { displayName: "Alice Jones", patientId: "a" },
  ];
  entries.sort(compareRosterEntries);
  assertEqual(entries.map((e) => e.displayName), ["Alice Jones", "bob smith"], "case-insensitive alpha order");
});

test("identical display names tie-break deterministically by patientId", () => {
  const entries = [
    { displayName: "Same Name", patientId: "zzz" },
    { displayName: "Same Name", patientId: "aaa" },
  ];
  entries.sort(compareRosterEntries);
  assertEqual(entries.map((e) => e.patientId), ["aaa", "zzz"], "patientId tie-break must be deterministic");
});

test("sort never depends on any field other than displayName/patientId", () => {
  // Type-level guarantee more than a runtime one, but exercised anyway: an
  // object with extra clinical-signal-shaped fields sorts identically.
  const entries = [
    { displayName: "Zed", patientId: "1", acuteReviewActive: true },
    { displayName: "Amy", patientId: "2", acuteReviewActive: false },
  ];
  entries.sort(compareRosterEntries);
  assertEqual(entries.map((e) => e.displayName), ["Amy", "Zed"], "acute status must never influence order");
});

// --- formatStageLabel -------------------------------------------------------

test("null stage -> 'No current prescription', never 'Stage 0'", () => {
  assertEqual(formatStageLabel(null), "No current prescription", "null stage label");
});

test("stage 3 -> 'Stage 3'", () => {
  assertEqual(formatStageLabel(3), "Stage 3", "numeric stage label");
});

// --- formatRecentActivityLabel ----------------------------------------------

test("zero sessions -> '0 sessions in last 14 days' (a valid factual zero)", () => {
  assertEqual(formatRecentActivityLabel(0), "0 sessions in last 14 days", "zero count");
});

test("singular grammar for exactly 1 session", () => {
  assertEqual(formatRecentActivityLabel(1), "1 session in last 14 days", "singular");
});

test("plural grammar for 2+ sessions", () => {
  assertEqual(formatRecentActivityLabel(5), "5 sessions in last 14 days", "plural");
});

// --- formatLastSessionLabel --------------------------------------------------

test("null lastSessionAt -> 'No sessions yet' (never 'No recent session')", () => {
  assertEqual(formatLastSessionLabel(null, NOW), "No sessions yet", "never-had-a-session label");
});

test("same UTC calendar day -> 'Today'", () => {
  assertEqual(formatLastSessionLabel("2026-09-16T01:00:00.000Z", NOW), "Today", "today");
});

test("previous UTC calendar day -> 'Yesterday'", () => {
  assertEqual(formatLastSessionLabel("2026-09-15T23:00:00.000Z", NOW), "Yesterday", "yesterday");
});

test("older date -> short month/day, no misleading year precision", () => {
  assertEqual(formatLastSessionLabel("2026-09-01T08:00:00.000Z", NOW), "Sep 1", "older date format");
});

// --- Run ---------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
