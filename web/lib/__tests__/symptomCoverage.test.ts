// Milestone 6, Stage 3B — coverage tests. Founder decision: formal
// session-completion / complete-response coverage is NOT computed in Stage
// 3B (no authoritative "eligible prescribed loading opportunities"
// denominator exists) — this module only ever returns a "not_computable"
// status plus raw, non-ratio counts. Plain, dependency-free script (see
// morningEligibility.test.ts's header note). Run with `npx tsx <this file>`.
import { buildCoverageContext, FORMAL_COVERAGE_UNAVAILABLE_REASON } from "../symptomCoverage";

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
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

test("formal coverage is ALWAYS reported not_computable — never a numeric ratio, regardless of input", () => {
  const ctx = buildCoverageContext({
    attemptedPrescriptionInstanceIds: ["i1", "i2", "i3"],
    completedPrescriptionInstanceIds: ["i1", "i2"],
    blockedOnlyPrescriptionInstanceIds: [],
    completeResponseEpisodeCount: 1,
  });
  assertEqual(ctx.sessionCompletionCoverage, "not_computable", "session completion coverage status");
  assertEqual(ctx.completeResponseCoverage, "not_computable", "complete-response coverage status");
  assert(ctx.reason === FORMAL_COVERAGE_UNAVAILABLE_REASON && ctx.reason.length > 0, "a real explanatory reason is present");
});

test("session-completion and complete-response remain conceptually separate raw counts (never collapsed)", () => {
  const ctx = buildCoverageContext({
    attemptedPrescriptionInstanceIds: ["i1", "i2", "i3"],
    completedPrescriptionInstanceIds: ["i1", "i2"], // 2 of 3 sessions actually completed
    blockedOnlyPrescriptionInstanceIds: [],
    completeResponseEpisodeCount: 1, // only 1 of the 3 had a complete M4 response
  });
  assertEqual(ctx.rawCounts.completedSessionCount, 2, "completed session count");
  assertEqual(ctx.rawCounts.completeResponseEpisodeCount, 1, "complete-response episode count — a distinct fact from session completion");
});

test("a safety hold is preserved as its own raw count, never folded into a noncompletion tally", () => {
  const ctx = buildCoverageContext({
    attemptedPrescriptionInstanceIds: ["i1"],
    completedPrescriptionInstanceIds: ["i1"],
    blockedOnlyPrescriptionInstanceIds: ["i2"], // blocked by acute-safety brake, never attempted
    completeResponseEpisodeCount: 1,
  });
  assertEqual(ctx.rawCounts.safetyBlockedOnlyCount, 1, "blocked-only count captured separately");
  assertEqual(ctx.rawCounts.completedSessionCount, 1, "the real completion count is unaffected by the hold");
});

test("same-opportunity retry does not inflate the attempted-session raw count (dedup by prescription_instance_id)", () => {
  const ctx = buildCoverageContext({
    attemptedPrescriptionInstanceIds: ["i1", "i1", "i1"], // hypothetical duplicate rows for the same instance
    completedPrescriptionInstanceIds: ["i1"],
    blockedOnlyPrescriptionInstanceIds: [],
    completeResponseEpisodeCount: 1,
  });
  assertEqual(ctx.rawCounts.attemptedSessionCount, 1, "deduplicated to a single opportunity");
});

test("a blocked id that also has a real attempted session is not double-counted as a separate raw count", () => {
  const ctx = buildCoverageContext({
    attemptedPrescriptionInstanceIds: ["i1"],
    completedPrescriptionInstanceIds: ["i1"],
    blockedOnlyPrescriptionInstanceIds: ["i1"], // defensive: shouldn't happen structurally, but must not inflate if it does
    completeResponseEpisodeCount: 1,
  });
  assertEqual(ctx.rawCounts.attemptedSessionCount, 1, "attempted takes precedence");
  assertEqual(ctx.rawCounts.safetyBlockedOnlyCount, 0, "not also counted as blocked-only");
});

test("zero attempted and zero blocked -> zero raw counts, still not_computable (no fabricated denominator masquerading as '0/0 coverage')", () => {
  const ctx = buildCoverageContext({
    attemptedPrescriptionInstanceIds: [],
    completedPrescriptionInstanceIds: [],
    blockedOnlyPrescriptionInstanceIds: [],
    completeResponseEpisodeCount: 0,
  });
  assertEqual(ctx.rawCounts.attemptedSessionCount, 0, "no opportunities recorded");
  assertEqual(ctx.sessionCompletionCoverage, "not_computable", "still not_computable, not an implied 0/0 or 100%");
});

test("the returned shape carries no numeric 'eligibleOpportunities' or ratio field at all", () => {
  const ctx = buildCoverageContext({
    attemptedPrescriptionInstanceIds: ["i1"],
    completedPrescriptionInstanceIds: ["i1"],
    blockedOnlyPrescriptionInstanceIds: [],
    completeResponseEpisodeCount: 1,
  });
  assert(!("eligibleOpportunities" in ctx), "no top-level eligibleOpportunities field");
  assert(typeof ctx.sessionCompletionCoverage === "string", "sessionCompletionCoverage is a plain status string, not an object with a denominator");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
