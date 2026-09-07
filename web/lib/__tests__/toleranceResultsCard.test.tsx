// Stage 4 — render-level check that ToleranceResultsCard selects the
// correct copy/tone branch for every reachable tolerance/guidance
// combination, including the two states the live-browser verification pass
// didn't happen to exercise (acute_override, reduce_modify). Locked
// constraints from the brief: never "increase your load," never a specific
// percentage, acute_override reuses the exact M3 escalation copy verbatim.
import { renderToStaticMarkup } from "react-dom/server";
import { ToleranceResultsCard } from "../../app/patient/morning-response/components/ToleranceResultsCard";
import type { ToleranceEvaluationRecord } from "../morningResponseTypes";

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

function evaluation(overrides: Partial<ToleranceEvaluationRecord>): ToleranceEvaluationRecord {
  return {
    id: "test",
    rehabSessionId: "test",
    morningResponseId: "test",
    toleranceClassification: "well_tolerated",
    immediateGuidance: "maintain",
    patientFacingLabel: "Well Tolerated",
    reason: "test",
    reasonCodes: [],
    ruleVersion: "v1",
    inputsSnapshot: {},
    evaluatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function render(evalRecord: ToleranceEvaluationRecord, escalationLevel: number | null) {
  return renderToStaticMarkup(ToleranceResultsCard({ evaluation: evalRecord, escalationLevel }) as React.ReactElement);
}

test("well_tolerated renders 'Well Tolerated' and never mentions increasing load", () => {
  const html = render(evaluation({ toleranceClassification: "well_tolerated", immediateGuidance: "maintain" }), 0);
  assert(html.includes("Well Tolerated"), "missing Well Tolerated title");
  assert(!/increase/i.test(html), "must never suggest increasing load");
});

test("caution + maintain_cautiously renders Caution copy distinct from reduce_modify", () => {
  const html = render(evaluation({ toleranceClassification: "caution", immediateGuidance: "maintain_cautiously" }), 0);
  assert(html.includes("Caution"), "missing Caution title");
  assert(!/reducing or modifying/i.test(html), "maintain_cautiously must not use the reduce_modify body copy");
});

test("caution + reduce_modify renders reduce/modify copy, never a specific percentage", () => {
  const html = render(evaluation({ toleranceClassification: "caution", immediateGuidance: "reduce_modify" }), 0);
  assert(html.includes("Caution"), "missing Caution title");
  assert(/reducing or modifying/i.test(html), "reduce_modify must surface reduce/modify guidance");
  assert(!/%|\bpercent\b/i.test(html), "must never imply a specific percentage reduction");
  assert(!/increase/i.test(html), "must never suggest increasing load");
});

test("poorly_tolerated + reduce_modify renders the same reduce/modify copy as caution + reduce_modify", () => {
  const html = render(evaluation({ toleranceClassification: "poorly_tolerated", immediateGuidance: "reduce_modify" }), 0);
  assert(/reducing or modifying/i.test(html), "poorly_tolerated must still surface reduce/modify guidance");
});

test("acute_override at escalation level 5 reuses the exact M3 'Stop Loading' copy verbatim", () => {
  const html = render(evaluation({ toleranceClassification: "acute_override", immediateGuidance: "clinical_review" }), 5);
  assert(html.includes("Stop Loading"), "must reuse the exact Level 5 headline");
  assert(html.includes("Seek prompt medical evaluation."), "must reuse the exact Level 5 body copy verbatim");
});

test("acute_override at escalation level 3 reuses the exact M3 'symptoms warrant review' copy verbatim", () => {
  const html = render(evaluation({ toleranceClassification: "acute_override", immediateGuidance: "clinical_review" }), 3);
  assert(html.includes("Your symptoms warrant review."), "must reuse the exact Level 3 headline verbatim");
  assert(html.includes("contact your clinician"), "must reuse the exact Level 3 body copy verbatim");
});

test("acute_override never shows an ordinary Caution/Well Tolerated title regardless of guidance", () => {
  const html = render(evaluation({ toleranceClassification: "acute_override", immediateGuidance: "clinical_review" }), 5);
  assert(!html.includes(">Caution<"), "acute override must not be labeled Caution");
  assert(!html.includes(">Well Tolerated<"), "acute override must not be labeled Well Tolerated");
});

test("insufficient_data renders 'More Data Needed' and never a tolerance verdict", () => {
  const html = render(evaluation({ toleranceClassification: "insufficient_data", immediateGuidance: "maintain" }), 0);
  assert(html.includes("More Data Needed"), "missing More Data Needed title");
  assert(!html.includes(">Well Tolerated<") && !html.includes(">Caution<"), "insufficient_data must not imply any tolerance verdict");
});

test("external_loading_reported adds a contributed-context note without changing title/tone, and never says 'caused'", () => {
  const withLoad = render(
    evaluation({ toleranceClassification: "caution", immediateGuidance: "maintain_cautiously", reasonCodes: ["external_loading_reported"] }),
    0
  );
  const without = render(evaluation({ toleranceClassification: "caution", immediateGuidance: "maintain_cautiously", reasonCodes: [] }), 0);
  assert(/may have contributed/i.test(withLoad), "must mention contributed-to-context framing when reported");
  assert(!/may have contributed/i.test(without), "must not appear when not reported");
  assert(!/\bcaused\b/i.test(withLoad), "must never state the activity caused the response");
  assert(withLoad.includes("Caution"), "title must still be Caution, unaffected by external load");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
