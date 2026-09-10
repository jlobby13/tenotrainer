// Milestone 5, Stage 4 closure patch — regression coverage for the
// rehab-day scheduling eligibility primitive (Section 13 of the brief).
import { deriveRehabDayEligibility } from "../rehabSchedule";

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
function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// 2026-09-09 is a Wednesday (day 3).
const WEDNESDAY = "2026-09-09";
// 2026-09-06 is a Sunday (day 0).
const SUNDAY = "2026-09-06";
// 2026-09-12 is a Saturday (day 6).
const SATURDAY = "2026-09-12";

test("A. null rehabDaysOfWeek -> unknown, regardless of date", () => {
  assertEqual(deriveRehabDayEligibility(null, WEDNESDAY), "unknown", "null must never be treated as a schedule");
  assertEqual(deriveRehabDayEligibility(null, SUNDAY), "unknown", "null must never be treated as a schedule");
});

test("B. today's day-of-week included -> scheduled", () => {
  assertEqual(deriveRehabDayEligibility([1, 3, 5], WEDNESDAY), "scheduled", "Wed=3 is in [Mon,Wed,Fri]");
});

test("C. today's day-of-week NOT included -> not_scheduled", () => {
  assertEqual(deriveRehabDayEligibility([1, 3, 5], SUNDAY), "not_scheduled", "Sun=0 is not in [Mon,Wed,Fri]");
  assertEqual(deriveRehabDayEligibility([1, 3, 5], SATURDAY), "not_scheduled", "Sat=6 is not in [Mon,Wed,Fri]");
});

test("D. empty array is a distinct, legitimate 'never scheduled' value, not unknown", () => {
  assertEqual(deriveRehabDayEligibility([], WEDNESDAY), "not_scheduled", "explicit empty array must never collapse into unknown");
});

test("E. daily schedule (all 7 days) -> scheduled every day", () => {
  for (const d of [0, 1, 2, 3, 4, 5, 6]) {
    assertEqual(deriveRehabDayEligibility([0, 1, 2, 3, 4, 5, 6], `2026-09-0${6 + d}`), "scheduled", `day ${d} of a daily schedule`);
  }
});

test("F. Sunday (day 0) resolves correctly — not silently miscomputed as day 7 or -1", () => {
  assertEqual(deriveRehabDayEligibility([0], SUNDAY), "scheduled", "explicit Sunday-only schedule on a Sunday");
  assertEqual(deriveRehabDayEligibility([1, 2, 3, 4, 5, 6], SUNDAY), "not_scheduled", "every day except Sunday, evaluated on a Sunday");
});

test("G. order/duplicates in rehabDaysOfWeek do not affect the result", () => {
  assertEqual(deriveRehabDayEligibility([5, 3, 3, 1], WEDNESDAY), "scheduled", "unordered/duplicated array still matches");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
