// Milestone 6, Stage 3B — response-episode construction/eligibility tests.
// Plain, dependency-free script matching the existing convention (see
// morningEligibility.test.ts's header note). Run with `npx tsx <this file>`.
import { buildResponseEpisode, buildResponseEpisodes, isBaseResponseEpisode, selectShortWindows, SHORT_WINDOW_SIZE, type RawResponseEpisodeInput } from "../responseEpisode";

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
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function baseRaw(overrides: Partial<RawResponseEpisodeInput> = {}): RawResponseEpisodeInput {
  return {
    rehabSessionId: "sess-1",
    userId: "user-1",
    patientLocalDate: "2026-09-01",
    prescriptionVersionId: "presc-1",
    prescriptionInstanceId: "presc-1:2026-09-01",
    sessionStatus: "response_complete",
    hasSetOutcomes: true,
    morningResponseId: "morning-1",
    morningResponseSubmittedAt: "2026-09-02T08:00:00Z",
    nextMorningPain: 3,
    nextMorningStiffness: 2,
    stiffnessDuration: "lt_5_min",
    toleranceEvaluationId: "tol-1",
    peakSessionPain: 4,
    externalLoadObservations: [],
    hasAcuteSafetyContext: false,
    ...overrides,
  };
}

// --- Episode eligibility ---

test("full episode is eligible", () => {
  const episode = buildResponseEpisode(baseRaw());
  assert(episode.eligibleForSymptomAnalysis, "expected eligible");
  assertEqual(episode.symptomIneligibilityReasons, [], "no ineligibility reasons");
});

test("missing MP (next-morning pain) -> incomplete", () => {
  const episode = buildResponseEpisode(baseRaw({ nextMorningPain: null }));
  assert(!episode.eligibleForSymptomAnalysis, "expected ineligible");
  assert(episode.symptomIneligibilityReasons.includes("missing_next_morning_pain"), "reason present");
});

test("missing MS (next-morning stiffness) -> incomplete", () => {
  const episode = buildResponseEpisode(baseRaw({ nextMorningStiffness: null, stiffnessDuration: null }));
  assert(!episode.eligibleForSymptomAnalysis, "expected ineligible");
  assert(episode.symptomIneligibilityReasons.includes("missing_next_morning_stiffness"), "reason present");
});

test("MS > 0 with missing MSD -> incomplete (UNKNOWN != ZERO)", () => {
  const episode = buildResponseEpisode(baseRaw({ nextMorningStiffness: 3, stiffnessDuration: null }));
  assert(!episode.eligibleForSymptomAnalysis, "expected ineligible");
  assert(episode.symptomIneligibilityReasons.includes("missing_stiffness_duration_with_nonzero_stiffness"), "reason present");
});

test("MS = 0 with MSD = not_applicable -> complete (legitimate zero)", () => {
  const episode = buildResponseEpisode(baseRaw({ nextMorningStiffness: 0, stiffnessDuration: "not_applicable" }));
  assert(episode.eligibleForSymptomAnalysis, "expected eligible");
});

test("MS = 0 with MSD null is still complete — absence of duration doesn't independently disqualify a true zero", () => {
  const episode = buildResponseEpisode(baseRaw({ nextMorningStiffness: 0, stiffnessDuration: null }));
  assert(episode.eligibleForSymptomAnalysis, "expected eligible");
});

test("explicit symptom zero (P=0) remains a valid, eligible zero", () => {
  const episode = buildResponseEpisode(baseRaw({ peakSessionPain: 0 }));
  assert(episode.eligibleForSymptomAnalysis, "expected eligible");
  assertEqual(episode.peakSessionPain, 0, "zero preserved, not null");
});

test("NULL never becomes zero — missing peak pain is null, not 0, and is ineligible", () => {
  const episode = buildResponseEpisode(baseRaw({ peakSessionPain: null }));
  assertEqual(episode.peakSessionPain, null, "peakSessionPain stays null");
  assert(!episode.eligibleForSymptomAnalysis, "expected ineligible");
  assert(episode.symptomIneligibilityReasons.includes("missing_peak_session_pain"), "reason present");
});

// --- Base response-episode gate ---

test("isBaseResponseEpisode requires status=response_complete", () => {
  assert(!isBaseResponseEpisode(baseRaw({ sessionStatus: "awaiting_morning_response" })), "expected false");
});

test("isBaseResponseEpisode requires actual performance (set outcomes)", () => {
  assert(!isBaseResponseEpisode(baseRaw({ hasSetOutcomes: false })), "expected false");
});

test("isBaseResponseEpisode requires a FINALIZED morning response (submitted_at not null)", () => {
  assert(!isBaseResponseEpisode(baseRaw({ morningResponseSubmittedAt: null })), "expected false — draft-only response is not a fact yet");
});

test("isBaseResponseEpisode requires a persisted tolerance evaluation", () => {
  assert(!isBaseResponseEpisode(baseRaw({ toleranceEvaluationId: null })), "expected false");
});

test("buildResponseEpisodes excludes rows that never became base response episodes at all", () => {
  const episodes = buildResponseEpisodes([baseRaw({ rehabSessionId: "a" }), baseRaw({ rehabSessionId: "b", sessionStatus: "in_progress" })]);
  assertEqual(episodes.length, 1, "only one base episode");
  assertEqual(episodes[0].rehabSessionId, "a", "the complete one survives");
});

// --- 5+5 window selection ---

function makeEligibleEpisodes(n: number, startDate = "2026-09-01") {
  const start = new Date(startDate + "T00:00:00Z");
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    return buildResponseEpisode(baseRaw({ rehabSessionId: `s${i}`, patientLocalDate: dateStr }));
  });
}

test("fewer than 10 eligible episodes -> insufficient (null windows)", () => {
  const episodesNewestFirst = makeEligibleEpisodes(9).reverse();
  assertEqual(selectShortWindows(episodesNewestFirst), null, "expected null");
});

test("exactly 10 eligible episodes works", () => {
  const episodesNewestFirst = makeEligibleEpisodes(10).reverse();
  const windows = selectShortWindows(episodesNewestFirst);
  assert(windows !== null, "expected non-null windows");
  assertEqual(windows!.previous.length, SHORT_WINDOW_SIZE, "previous window size");
  assertEqual(windows!.recent.length, SHORT_WINDOW_SIZE, "recent window size");
});

test("more than 10 eligible episodes uses only the most recent 10", () => {
  const episodesNewestFirst = makeEligibleEpisodes(14).reverse(); // s0..s13, s13 newest
  const windows = selectShortWindows(episodesNewestFirst)!;
  const allIds = [...windows.previous, ...windows.recent].map((e) => e.rehabSessionId).sort();
  assertEqual(allIds, ["s10", "s11", "s12", "s13", "s4", "s5", "s6", "s7", "s8", "s9"].sort(), "only the 10 most recent used");
});

test("incomplete episodes never enter the eligible 5+5 window (caller must pre-filter)", () => {
  const eligible = makeEligibleEpisodes(10);
  const incomplete = buildResponseEpisode(baseRaw({ rehabSessionId: "incomplete", patientLocalDate: "2026-09-20", nextMorningPain: null }));
  assert(!incomplete.eligibleForSymptomAnalysis, "sanity: fixture is actually ineligible");
  // Simulate the engine's real filter step: only eligibleForSymptomAnalysis episodes are ever passed in.
  const filtered = [incomplete, ...eligible].filter((e) => e.eligibleForSymptomAnalysis).sort((a, b) => b.patientLocalDate.localeCompare(a.patientLocalDate));
  const windows = selectShortWindows(filtered)!;
  const allIds = [...windows.previous, ...windows.recent].map((e) => e.rehabSessionId);
  assert(!allIds.includes("incomplete"), "incomplete episode must never occupy a window slot");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
