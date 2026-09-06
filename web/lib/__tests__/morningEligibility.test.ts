// Milestone 4, Stage 1 — pure-function regression tests for morningEligibility.ts.
// No test framework is wired up for the web/ package yet (only Playwright
// e2e exists) — this is a plain, dependency-free script matching the
// convention already used for M3's sessionResponseResume tests and the
// pre-M4 UNKNOWN != ZERO Python suite. Compile with tsc to plain JS and run
// with node (see the Stage 1 completion report for the exact commands used).

import {
  isValidMorningReminderTime,
  normalizeMorningReminderTime,
  isValidIanaTimezone,
  getScheduledMorningEligibility,
  isScheduledEligible,
  getMorningResponseState,
  DEFAULT_MORNING_REMINDER_TIME,
} from "../morningEligibility";

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
  if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`);
}

// --- B: reminder time validation -----------------------------------------

test("default reminder time (05:00:00) is valid", () => {
  assert(isValidMorningReminderTime(DEFAULT_MORNING_REMINDER_TIME), "default should be valid");
});

test("valid 15-minute increments accepted: 05:00, 05:15, 05:30, 05:45, 07:45, 08:00", () => {
  for (const t of ["05:00", "05:15", "05:30", "05:45", "07:45", "08:00"]) {
    assert(isValidMorningReminderTime(t), `${t} should be valid`);
  }
});

test("invalid minute increments rejected: 05:05, 05:10, 05:50", () => {
  for (const t of ["05:05", "05:10", "05:50"]) {
    assert(!isValidMorningReminderTime(t), `${t} should be rejected`);
  }
});

test("non-zero seconds rejected even on a 15-minute boundary", () => {
  assert(!isValidMorningReminderTime("05:00:30"), "05:00:30 should be rejected");
});

test("malformed strings rejected", () => {
  for (const t of ["5:00", "25:00", "05:60", "not-a-time", ""]) {
    assert(!isValidMorningReminderTime(t), `"${t}" should be rejected`);
  }
});

test("normalizeMorningReminderTime pads HH:MM to HH:MM:SS", () => {
  assertEqual(normalizeMorningReminderTime("07:15"), "07:15:00", "should append :00");
  assertEqual(normalizeMorningReminderTime("07:15:00"), "07:15:00", "already-normalized should pass through");
});

// --- IANA timezone validation ---------------------------------------------

test("valid IANA timezone accepted", () => {
  assert(isValidIanaTimezone("America/Denver"), "America/Denver should be valid");
  assert(isValidIanaTimezone("UTC"), "UTC should be valid");
});

test("invalid/unrecognized timezone rejected", () => {
  assert(!isValidIanaTimezone("Not/A_Real_Zone"), "should be rejected");
  assert(!isValidIanaTimezone(""), "empty string should be rejected");
});

// --- C: eligibility state ---------------------------------------------------

test("before reminder time: not scheduled-ready", () => {
  const eligibleAt = getScheduledMorningEligibility("2026-09-07", "America/Denver", "07:00");
  const before = new Date(eligibleAt.getTime() - 60_000); // 1 minute before
  assert(!isScheduledEligible(eligibleAt.toISOString(), before), "should not be eligible yet");
  assertEqual(
    getMorningResponseState({ scheduledEligibleAt: eligibleAt.toISOString(), submittedAt: null }, before),
    "pending",
    "state should be pending before eligibility"
  );
});

test("at reminder time: scheduled-ready", () => {
  const eligibleAt = getScheduledMorningEligibility("2026-09-07", "America/Denver", "07:00");
  assert(isScheduledEligible(eligibleAt.toISOString(), eligibleAt), "should be eligible exactly at the instant");
  assertEqual(
    getMorningResponseState({ scheduledEligibleAt: eligibleAt.toISOString(), submittedAt: null }, eligibleAt),
    "scheduled_ready",
    "state should be scheduled_ready at eligibility"
  );
});

test("after reminder time: scheduled-ready", () => {
  const eligibleAt = getScheduledMorningEligibility("2026-09-07", "America/Denver", "07:00");
  const after = new Date(eligibleAt.getTime() + 3600_000); // 1 hour after
  assert(isScheduledEligible(eligibleAt.toISOString(), after), "should still be eligible");
  assertEqual(
    getMorningResponseState({ scheduledEligibleAt: eligibleAt.toISOString(), submittedAt: null }, after),
    "scheduled_ready",
    "state should remain scheduled_ready after eligibility"
  );
});

test("submitted response is always 'submitted' regardless of timing", () => {
  const eligibleAt = getScheduledMorningEligibility("2026-09-07", "America/Denver", "07:00");
  const before = new Date(eligibleAt.getTime() - 60_000);
  assertEqual(
    getMorningResponseState({ scheduledEligibleAt: eligibleAt.toISOString(), submittedAt: new Date().toISOString() }, before),
    "submitted",
    "submitted should win over timing"
  );
});

test("unknown scheduled_eligible_at (null) is never scheduled-ready — pending, not fabricated", () => {
  assert(!isScheduledEligible(null, new Date()), "null eligibility should never be 'eligible'");
  assertEqual(
    getMorningResponseState({ scheduledEligibleAt: null, submittedAt: null }, new Date()),
    "pending",
    "unknown timing should be 'pending', not silently treated as due"
  );
});

// --- Eligibility is computed for the NEXT calendar day, not the session's own day ---

test("eligibility lands on the day AFTER patient_local_date, not the same day", () => {
  const eligibleAt = getScheduledMorningEligibility("2026-09-07", "America/Denver", "05:00");
  // Format back in the same zone to check the calendar date landed correctly.
  const isoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(eligibleAt);
  assertEqual(isoDate, "2026-09-08", "should be the next calendar day in the patient's zone");
});

// --- D: DST boundary -------------------------------------------------------
// America/Denver springs forward on 2027-03-14 (2:00 AM -> 3:00 AM MDT).
// A session on 2027-03-13 has its morning response due 2027-03-14 at the
// reminder time — that instant must reflect the POST-transition (MDT, UTC-6)
// offset, not the PRE-transition (MST, UTC-7) offset naively carried over.

test("DST spring-forward: scheduled eligibility uses the correct post-transition offset", () => {
  const reminderTime = "07:00";
  const eligibleAt = getScheduledMorningEligibility("2027-03-13", "America/Denver", reminderTime);

  // 07:00 MDT (UTC-6) on 2027-03-14 = 13:00 UTC.
  const expectedUtcHour = 13;
  assertEqual(eligibleAt.getUTCHours(), expectedUtcHour, "should be 13:00 UTC (07:00 MDT), not 14:00 UTC (the pre-DST MST offset)");

  // Round-trip: formatting this instant back in America/Denver must show 07:00.
  const wallClock = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(eligibleAt);
  assert(wallClock.startsWith("07:00") || wallClock === "07:00", `expected 07:00 local, got ${wallClock}`);
});

test("DST fall-back: scheduled eligibility uses the correct post-transition offset", () => {
  // America/Denver falls back on 2027-11-07 (2:00 AM MDT -> 1:00 AM MST).
  const eligibleAt = getScheduledMorningEligibility("2027-11-06", "America/Denver", "07:00");
  // 07:00 MST (UTC-7) on 2027-11-07 = 14:00 UTC.
  assertEqual(eligibleAt.getUTCHours(), 14, "should be 14:00 UTC (07:00 MST) after fall-back");
});

// --- Run ---------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
