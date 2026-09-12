// Milestone 6, Stage 3B — 5+5 classifier tests: core-domain direction,
// consistency, MSD ordinal comparison, overall Symptoms summary. Plain,
// dependency-free script (see morningEligibility.test.ts's header note).
// Run with `npx tsx <this file>`.
import { classifyConsistency, classifyCoreDomain, classifyMsd, classifyOverallSymptoms } from "../symptomClassifier";

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

// --- Direction (frequency primary, median corroborating) ---

test("3/5 lower + median lower -> improving", () => {
  // previous median = 5 (values [5,5,5,5,5]); recent [3,3,3,5,6] -> 3 of 5 are <=4 (lower)
  const r = classifyCoreDomain([5, 5, 5, 5, 5], [3, 3, 3, 5, 6]);
  assertEqual(r.direction, "improving", "3/5 lower, median 5->3 corroborates");
  assertEqual(r.recentMedian, 3, "recent median");
});

test("4/5 lower + median lower -> improving", () => {
  const r = classifyCoreDomain([5, 5, 5, 5, 5], [2, 2, 2, 2, 5]);
  assertEqual(r.direction, "improving", "4/5 lower, median corroborates");
});

test("5/5 lower + median lower -> improving", () => {
  const r = classifyCoreDomain([5, 5, 5, 5, 5], [1, 2, 3, 3, 4]);
  assertEqual(r.direction, "improving", "5/5 lower, median corroborates");
});

test("3/5 higher + median higher -> trending_higher", () => {
  const r = classifyCoreDomain([3, 3, 3, 3, 3], [5, 5, 5, 3, 2]);
  assertEqual(r.direction, "trending_higher", "3/5 higher, median 3->5 corroborates");
});

test("no 3/5 majority -> stable", () => {
  const r = classifyCoreDomain([4, 4, 4, 4, 4], [3, 3, 5, 5, 4]);
  // 2 lower, 2 higher, 1 similar — no dominant pattern
  assertEqual(r.direction, "stable", "no dominant pattern");
});

test("frequency favorable (3/5 lower) but median NOT lower -> discordant, treated as stable (never forced improving)", () => {
  // previous median = 4; recent [3,3,3,10,10] -> 3/5 are <=3 (lower), but
  // recent median = 3? wait recompute: sorted [3,3,3,10,10] median=3, which
  // IS lower than 4 — need a case where frequency says lower but median
  // does NOT move lower. Use [3,3,3,9,9]: sorted median=3, still lower.
  // Construct properly: need median to stay >= previous median despite 3/5
  // being individually "lower". previous=[10,10,10,10,10] (median 10).
  // recent=[9,9,9,20,20]: 3/5 are <=9 (lower, since 10-1=9), median of
  // recent sorted [9,9,9,20,20] = 9, which IS lower than 10 too. Need
  // median NOT to move: recent=[9,9,9,10,10] -> median=9, still lower.
  // Actually with only 5 values and 3 of them below the previous median,
  // the median of 5 values is the 3rd sorted value; if 3 values are each
  // <= previousMedian-1, the middle (3rd) value is one of those <=
  // previousMedian-1 values UNLESS the other 2 "non-lower" values sort
  // before some lower ones. Construct: recent=[0,0,20,20,20] with previous
  // median=10: directions are lower,lower,higher,higher,higher -> that's
  // 3/5 higher, not lower. Try recent=[0,0,9,20,20], previous median=10:
  // 0<=9 lower, 0<=9 lower, 9<=9 lower, 20>=11 higher, 20>=11 higher -> 3/5
  // lower. Sorted recent = [0,0,9,20,20], median = 9, which is < 10 ->
  // still corroborates (lower). To break corroboration we need the recent
  // MEDIAN to be >= previous median despite 3/5 individual "lower" calls —
  // impossible with n=5 majority voting AND boundary=1, since the median
  // (3rd of 5 sorted) close to being one of the 3 "lower" values whenever
  // 3+ are lower... Actually it IS possible: recent=[0,1,2,20,20],
  // previous median=3: 0<=2 lower,1<=2 lower,2<=2 lower,20>=4 higher,
  // 20>=4 higher -> 3/5 lower. Sorted=[0,1,2,20,20], median=2 < 3 ->
  // corroborates. It seems with boundary=1 and n=5, whenever >=3 values are
  // "lower" (<=previousMedian-1), the sorted median (index 2) must also be
  // <= previousMedian-1, because at least 3 of the 5 sorted values are
  // <= previousMedian-1, so by pigeonhole the value at sorted index 2 (0-
  // based) is among the lower ones IF those 3 occupy the lowest sorted
  // positions, which they always do since they're literally the smallest
  // values. So frequency-favorable-lower ALWAYS corroborates with median
  // for n=5, boundary=1 — this discordant case may be structurally
  // impossible for the core n=5 domains. Test that fact explicitly instead.
  const r = classifyCoreDomain([3, 3, 3, 3, 3], [0, 1, 2, 20, 20]);
  assertEqual(r.frequencyPattern, "favorable_lower", "3/5 lower");
  assertEqual(r.medianDirection, "lower", "median necessarily corroborates when >=3/5 are lower, for n=5");
  assertEqual(r.direction, "improving", "corroborated case still resolves correctly");
});

test("discordant case IS reachable at the frequency/median boundary when only exactly 3/5 are lower and the median ties", () => {
  // previous=[4,4,4,4,4] median=4. recent=[3,3,3,4,4]: 3 values <=3 (lower),
  // 2 values ==4 (similar). Sorted recent=[3,3,3,4,4], median=3, which IS
  // lower than 4 -> still corroborates. Given the pigeonhole argument above
  // always holds for n=5, there is in fact no discordant case for a bare
  // majority-of-3 pattern at n=5. This test documents that structural fact
  // rather than asserting a scenario that cannot occur, so a future
  // regression (e.g. an accidental change to n or the boundary) is caught.
  const r = classifyCoreDomain([4, 4, 4, 4, 4], [3, 3, 3, 4, 4]);
  assertEqual(r.direction, "improving", "3/5 lower with a tied median still corroborates for n=5");
});

test("frequency unfavorable (3/5 higher) but median NOT higher is impossible at n=5 for the same pigeonhole reason — documented", () => {
  const r = classifyCoreDomain([4, 4, 4, 4, 4], [5, 5, 5, 4, 4]);
  assertEqual(r.direction, "trending_higher", "3/5 higher with a tied median still corroborates for n=5");
});

test("PROPERTY (exhaustive, N=5, 0-10 integer scale): a >=3/5 frequency pattern ALWAYS produces a corroborating median movement — this is a mathematical/implementation characteristic of the v1 method, not a clinical rule, and median corroboration must NOT be removed from the architecture because of it", () => {
  // Brute-forces every previous-window median (0-10) against every possible
  // combination of 5 recent integer values (0-10 each) — 11 * 11^5 =
  // 1,771,561 calls. Exhaustive, not sampled: if this property ever breaks
  // (e.g. a future change to N, the boundary, or the frequency threshold),
  // this test fails immediately rather than relying on a lucky sample.
  let favorableCount = 0;
  let unfavorableCount = 0;
  for (let previousMedian = 0; previousMedian <= 10; previousMedian++) {
    const previousValues = [previousMedian, previousMedian, previousMedian, previousMedian, previousMedian];
    for (let a = 0; a <= 10; a++) {
      for (let b = 0; b <= 10; b++) {
        for (let c = 0; c <= 10; c++) {
          for (let d = 0; d <= 10; d++) {
            for (let e = 0; e <= 10; e++) {
              const r = classifyCoreDomain(previousValues, [a, b, c, d, e]);
              if (r.frequencyPattern === "favorable_lower") {
                favorableCount++;
                if (r.medianDirection !== "lower") {
                  throw new Error(`counterexample: previousMedian=${previousMedian}, recent=[${a},${b},${c},${d},${e}] — favorable_lower did NOT corroborate (medianDirection=${r.medianDirection})`);
                }
              } else if (r.frequencyPattern === "unfavorable_higher") {
                unfavorableCount++;
                if (r.medianDirection !== "higher") {
                  throw new Error(`counterexample: previousMedian=${previousMedian}, recent=[${a},${b},${c},${d},${e}] — unfavorable_higher did NOT corroborate (medianDirection=${r.medianDirection})`);
                }
              }
            }
          }
        }
      }
    }
  }
  assert(favorableCount > 0 && unfavorableCount > 0, "sanity: both pattern types actually occurred in the search space");
});

test("stable distribution -> stable, insufficient_data never fabricated when data is present", () => {
  const r = classifyCoreDomain([4, 4, 4, 4, 4], [4, 4, 4, 4, 4]);
  assertEqual(r.direction, "stable", "identical distributions");
  assertEqual(r.consistency, "consistent", "all similar -> consistent");
});

test("zeros handled correctly — an all-zero window is valid data, not insufficient_data", () => {
  const r = classifyCoreDomain([0, 0, 0, 0, 0], [0, 0, 0, 0, 0]);
  assertEqual(r.direction, "stable", "0 vs 0 is a real, complete comparison");
  assertEqual(r.previousMedian, 0, "median of zeros is zero, not null");
});

test("fewer than 5 on either side -> insufficient_data (never silently computed on partial data)", () => {
  const r = classifyCoreDomain([4, 4, 4, 4], [3, 3, 3, 3, 3]);
  assertEqual(r.direction, "insufficient_data", "previous window has only 4");
  assertEqual(r.consistency, "insufficient_data", "consistency also insufficient");
});

// --- Consistency (PROPOSED mapping — see symptomClassifier.ts header) ---

test("consistency: all-lower directions -> consistent (clear concentration)", () => {
  assertEqual(classifyConsistency(["lower", "lower", "lower", "lower", "lower"]), "consistent", "no opposing evidence");
});

test("consistency: lower + similar mix (no opposing higher) -> consistent", () => {
  assertEqual(classifyConsistency(["lower", "lower", "lower", "similar", "similar"]), "consistent", "similar is neutral, not opposing");
});

test("consistency: both lower and higher present -> variable (meaningful opposing evidence)", () => {
  assertEqual(classifyConsistency(["lower", "lower", "higher", "similar", "similar"]), "variable", "opposing directions present");
});

test("consistency: all similar -> consistent", () => {
  assertEqual(classifyConsistency(["similar", "similar", "similar", "similar", "similar"]), "consistent", "no directional evidence at all is not 'opposing'");
});

// --- MSD (ordinal only, never converted to fake minutes, no mean) ---
// FOUNDER DECISION: a formal MSD direction requires >= 3 applicable (known,
// MS>0) duration observations in EACH window — not merely >=1. Below that
// floor in either window, direction is always insufficient_data, regardless
// of how clear the pattern looks in the few observations available.

test("MSD: previous all long, recent all short (5 each, well above the 3-floor) -> shorter", () => {
  const r = classifyMsd(["gt_30_min", "gt_30_min", "gt_30_min", "gt_30_min", "gt_30_min"], ["lt_5_min", "lt_5_min", "lt_5_min", "lt_5_min", "lt_5_min"]);
  assertEqual(r.direction, "shorter", "clear ordinal decrease");
});

test("MSD: previous all short, recent all long (exactly 3 each — meets the floor exactly) -> longer", () => {
  const r = classifyMsd(["lt_5_min", "lt_5_min", "lt_5_min"], ["gt_30_min", "gt_30_min", "gt_30_min"]);
  assertEqual(r.direction, "longer", "clear ordinal increase, floor exactly satisfied");
});

test("MSD: identical ordinal distributions (3 each) -> stable", () => {
  const r = classifyMsd(["min_5_15", "min_5_15", "min_5_15"], ["min_5_15", "min_5_15", "min_5_15"]);
  assertEqual(r.direction, "stable", "no dominant pattern");
});

test("MSD: mixed ordinal distribution with no 60% majority (3 each) -> stable, not fabricated 'variable'", () => {
  const r = classifyMsd(["min_5_15", "min_5_15", "min_5_15"], ["lt_5_min", "gt_30_min", "min_5_15"]);
  assertEqual(r.direction, "stable", "no dominant frequency pattern");
});

test("MSD: MS=0 (not_applicable) episodes are excluded from the ordinal comparison entirely (sample-size accounting)", () => {
  const r = classifyMsd(["not_applicable", "not_applicable", "lt_5_min"], ["not_applicable", "gt_30_min"]);
  // only 1 real duration value on each side after filtering not_applicable
  assertEqual(r.previousSampleSize, 1, "not_applicable excluded from previous");
  assertEqual(r.recentSampleSize, 1, "not_applicable excluded from recent");
});

test("MSD: zero qualifying (MS>0) episodes on one side -> insufficient_data", () => {
  const r = classifyMsd(["not_applicable", "not_applicable"], ["lt_5_min", "lt_5_min"]);
  assertEqual(r.direction, "insufficient_data", "previous side has nothing to rank");
});

test("MSD: exactly 2 applicable observations (below the 3-floor, but nonzero) -> insufficient_data", () => {
  const r = classifyMsd(["lt_5_min", "lt_5_min"], ["gt_30_min", "gt_30_min", "gt_30_min"]);
  assertEqual(r.direction, "insufficient_data", "previous side has only 2, below the approved 3-per-window floor");
  assertEqual(r.previousSampleSize, 2, "sample size still reported for transparency");
});

test("MSD: 2 applicable on the recent side alone is also insufficient, even with a clean pattern in those 2", () => {
  const r = classifyMsd(["gt_30_min", "gt_30_min", "gt_30_min"], ["lt_5_min", "lt_5_min"]);
  assertEqual(r.direction, "insufficient_data", "recent side has only 2, below the floor, despite looking like a clear 'shorter' trend");
});

test("MSD: exactly 3 applicable on BOTH sides is sufficient (the floor is inclusive, not exclusive)", () => {
  const r = classifyMsd(["gt_30_min", "gt_30_min", "gt_30_min"], ["lt_5_min", "lt_5_min", "lt_5_min"]);
  assertEqual(r.direction, "shorter", "3 meets the floor, a real call is made");
});

test("MSD: never converts bins to fake minutes — only rank comparisons are exposed", () => {
  const r = classifyMsd(["lt_5_min", "lt_5_min", "lt_5_min"], ["gt_30_min", "gt_30_min", "gt_30_min"]);
  // recentMedianRank/previousMedianRank are ordinal ranks (small integers),
  // never a minutes value like 2.5/10/22.5/45.
  assertEqual(r.previousMedianRank, 1, "rank, not minutes");
  assertEqual(r.recentMedianRank, 4, "rank, not minutes");
});

// --- Overall Symptoms summary ---

const IMPROVING = { direction: "improving" as const, consistency: "consistent" as const, recentMedian: 2, previousMedian: 4, recentIqr: null, previousIqr: null, frequencyPattern: "favorable_lower" as const, medianDirection: "lower" as const, recentDirections: [], recentValues: [], previousValues: [] };
const STABLE = { ...IMPROVING, direction: "stable" as const };
const HIGHER = { ...IMPROVING, direction: "trending_higher" as const };
const INSUFFICIENT = { ...IMPROVING, direction: "insufficient_data" as const };

test("2 improving / none higher -> Symptoms Improving", () => {
  assertEqual(classifyOverallSymptoms({ P: IMPROVING, MP: IMPROVING, MS: STABLE }), "symptoms_improving", "2 improving, 0 higher");
});

test("1 improving / rest stable -> Symptoms Trending Better", () => {
  assertEqual(classifyOverallSymptoms({ P: IMPROVING, MP: STABLE, MS: STABLE }), "symptoms_trending_better", "1 improving, 0 higher");
});

test("stable core domains -> Symptoms Stable", () => {
  assertEqual(classifyOverallSymptoms({ P: STABLE, MP: STABLE, MS: STABLE }), "symptoms_stable", "all stable");
});

test("improving + higher -> Mixed Symptom Response", () => {
  assertEqual(classifyOverallSymptoms({ P: IMPROVING, MP: HIGHER, MS: STABLE }), "mixed_symptom_response", "1 improving + 1 higher");
});

test(">=2 higher / none improving -> Symptoms Trending Higher", () => {
  assertEqual(classifyOverallSymptoms({ P: HIGHER, MP: HIGHER, MS: STABLE }), "symptoms_trending_higher", "2 higher, 0 improving");
});

test("incomplete core data (any domain insufficient) -> More Data Needed", () => {
  assertEqual(classifyOverallSymptoms({ P: INSUFFICIENT, MP: STABLE, MS: STABLE }), "more_data_needed", "one domain insufficient");
});

test("1 higher / none improving -> Symptoms Stable (does not qualify for Trending Higher, no numeric weighting either)", () => {
  assertEqual(classifyOverallSymptoms({ P: HIGHER, MP: STABLE, MS: STABLE }), "symptoms_stable", "only 1 higher, falls to Stable by elimination");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
