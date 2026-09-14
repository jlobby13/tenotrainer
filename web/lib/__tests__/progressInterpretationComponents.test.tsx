// Milestone 6, Stage 4 — render-level checks that the Progress
// interpretation components select the correct patient-safe copy and never
// leak raw internal terminology (resultState, reason codes, heuristic
// keys, exId, loading-profile/performance-unit enum slugs). Mirrors
// toleranceResultsCard.test.tsx's convention. Run with
// `npx tsx lib/__tests__/progressInterpretationComponents.test.tsx`.
import { renderToStaticMarkup } from "react-dom/server";
import { SymptomsInterpretationCard } from "../../app/patient/progress/components/SymptomsInterpretationCard";
import { CapacityConstructSection } from "../../app/patient/progress/components/CapacityConstructSection";
import { TrainingResponseCard } from "../../app/patient/progress/components/TrainingResponseCard";
import { ProgressSummarySection } from "../../app/patient/progress/components/ProgressSummarySection";
import type { CapacityConstructSummary, ProgressInterpretationData } from "../progressInterpretationTypes";

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

const RAW_TERMS = [
  "more_comparable_data_needed",
  "capacity_building",
  "loading_pattern_variable",
  "symptoms_trending_higher",
  "mixed_symptom_response",
  "training_response_remains_unsettled",
  "limited_comparable_exposures",
  "heavy_slow_resistance",
  "eccentric_biased",
  "isotonic_slow",
  "unrepresentable_construct",
  "insufficient_total_history",
];

function assertNoRawTerminology(html: string, msg: string) {
  for (const term of RAW_TERMS) assert(!html.includes(term), `${msg}: leaked "${term}"`);
}

function capacityConstruct(overrides: Partial<CapacityConstructSummary>): CapacityConstructSummary {
  return {
    constructKey: "raw_ex_id_should_never_render::heavy_slow_resistance::reps",
    exId: "raw_ex_id_should_never_render",
    loadingProfile: "heavy_slow_resistance",
    performanceUnit: "reps",
    exerciseName: "Heavy calf raise",
    resultState: "loading_capacity_improving",
    moreDataNeededReason: null,
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// --- Symptoms card -----------------------------------------------------

test("SymptomsInterpretationCard renders the mapped label for a known state, not the raw resultState", () => {
  const html = renderToStaticMarkup(SymptomsInterpretationCard({ symptoms: { resultState: "symptoms_improving", generatedAt: "2026-01-01" } }) as React.ReactElement);
  assert(html.includes("Improving"), "missing mapped label");
  assertNoRawTerminology(html, "symptoms_improving card");
});

test("SymptomsInterpretationCard renders the no-interpretation-yet fallback when symptoms is null", () => {
  const html = renderToStaticMarkup(SymptomsInterpretationCard({ symptoms: null }) as React.ReactElement);
  assert(html.includes("More data needed"), "missing fallback label");
  assert(html.includes("We need a few more completed rehab responses"), "missing fallback sentence");
});

// --- Capacity section ----------------------------------------------------

test("CapacityConstructSection renders one card per construct — multiple constructs never collapse into one", () => {
  const html = renderToStaticMarkup(
    CapacityConstructSection({
      capacityConstructs: [
        capacityConstruct({ constructKey: "a", exId: "ex_a", exerciseName: "Heavy calf raise", resultState: "loading_capacity_improving" }),
        capacityConstruct({ constructKey: "b", exId: "ex_b", exerciseName: "Isometric hold", loadingProfile: "isometric", resultState: "capacity_building" }),
      ],
    }) as React.ReactElement
  );
  assert(html.includes("Heavy calf raise"), "missing first construct name");
  assert(html.includes("Isometric hold"), "missing second construct name");
  assert(html.includes("Improving"), "missing first construct label");
  assert(html.includes("Building"), "missing second construct label");
  assertNoRawTerminology(html, "multi-construct section");
  assert(!html.includes("ex_a") && !html.includes("ex_b"), "must never render a raw exId");
});

test("CapacityConstructSection never hides a construct solely because it's more_comparable_data_needed", () => {
  const html = renderToStaticMarkup(
    CapacityConstructSection({
      capacityConstructs: [capacityConstruct({ resultState: "more_comparable_data_needed", moreDataNeededReason: "recent_loading_lower" })],
    }) as React.ReactElement
  );
  assert(html.includes("Heavy calf raise"), "the construct must still render");
  assert(html.includes("Recent loading lower"), "missing the specific reason's label");
  assert(html.includes("not as a decline"), "missing the approved decline-disclaiming secondary sentence");
});

test("CapacityConstructSection with zero constructs shows the restrained section-empty message, not a blank section", () => {
  const html = renderToStaticMarkup(CapacityConstructSection({ capacityConstructs: [] }) as React.ReactElement);
  assert(html.includes("have a loading-capacity pattern"), "missing section-empty message");
});

test("CapacityConstructSection never derives or displays an overall Capacity score across constructs", () => {
  const html = renderToStaticMarkup(
    CapacityConstructSection({
      capacityConstructs: [
        capacityConstruct({ constructKey: "a", resultState: "loading_capacity_improving" }),
        capacityConstruct({ constructKey: "b", exId: "ex_b", exerciseName: "Isometric hold", loadingProfile: "isometric", resultState: "loading_pattern_variable" }),
      ],
    }) as React.ReactElement
  );
  assert(!/overall/i.test(html), "must never mention an 'overall' Capacity");
  assert(!/\d+%/.test(html), "must never show a percentage score");
});

// --- Training Response card ----------------------------------------------

test("TrainingResponseCard shows the patient-safe substitute for limited_comparable_exposures, never the slug", () => {
  const html = renderToStaticMarkup(
    TrainingResponseCard({
      trainingResponse: { resultState: "variable_training_response", hasInsufficientConstruct: true, overallLoadingDirection: "mixed", generatedAt: "2026-01-01" },
    }) as React.ReactElement
  );
  assert(html.includes("Some exercises do not yet have enough comparable loading history"), "missing substitute note");
  assertNoRawTerminology(html, "training response card");
});

test("TrainingResponseCard renders the no-interpretation-yet fallback when trainingResponse is null", () => {
  const html = renderToStaticMarkup(TrainingResponseCard({ trainingResponse: null }) as React.ReactElement);
  assert(html.includes("More data needed"), "missing fallback label");
});

// --- Progress Summary section ---------------------------------------------

test("ProgressSummarySection is always rendered (never conditionally collapsible/hidden) and states domains independently", () => {
  const data: ProgressInterpretationData = {
    symptoms: { resultState: "symptoms_improving", generatedAt: "2026-01-01" },
    capacityConstructs: [],
    trainingResponse: { resultState: "more_data_needed", hasInsufficientConstruct: false, overallLoadingDirection: "insufficient", generatedAt: "2026-01-01" },
  };
  const html = renderToStaticMarkup(ProgressSummarySection({ interpretationData: data }) as React.ReactElement);
  assert(html.includes("Progress Summary"), "missing summary heading");
  assert(!/<details|<button/i.test(html), "must not be collapsible (no <details>/<button> disclosure widget)");
  assert(/better direction/i.test(html), "must still show the improving Symptoms sentence");
  assert(/more comparable loading data/i.test(html), "must still show the Training Response more-data sentence");
});

test("ProgressSummarySection with one Capacity construct disambiguates using the shared labels helper (no exId)", () => {
  const data: ProgressInterpretationData = {
    symptoms: { resultState: "symptoms_stable", generatedAt: "2026-01-01" },
    capacityConstructs: [capacityConstruct({ exId: "should_not_appear_raw" })],
    trainingResponse: null,
  };
  const html = renderToStaticMarkup(ProgressSummarySection({ interpretationData: data }) as React.ReactElement);
  assert(html.includes("Heavy calf raise"), "must name the single exercise");
  assert(!html.includes("should_not_appear_raw"), "must never render a raw exId");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
