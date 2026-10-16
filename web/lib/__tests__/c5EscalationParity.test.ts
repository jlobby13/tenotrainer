// C5.6E — the C5 response path records escalation with the SQL function
// c5_escalation_v1 (supabase/migrations/20261015000001), which must match the
// existing v1 rule in lib/escalation.ts for the inputs C5 captures (the three
// acute-safety answers; no legacy pain-limiting / early-termination events).
// Both are pinned to the same table: this test pins the TypeScript rule,
// web/scripts/verifyC5Stage6eResponses.sql pins the SQL function. Pain and
// RPE never change the level.
import { evaluateEscalation } from "../escalation";

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

// [sudden/sharp pain, pop, new functional difficulty] -> [level, reason]
const TABLE: [boolean, boolean, boolean, number, string][] = [
  [false, false, false, 0, "routine_loading_exposure"],
  [true, false, false, 3, "sudden_or_sharp_pain"],
  [false, false, true, 3, "new_functional_difficulty"],
  [true, false, true, 3, "sudden_or_sharp_pain_and_new_functional_difficulty"],
  [false, true, false, 5, "pop_felt_or_heard"],
  [true, true, false, 5, "pop_felt_or_heard"],
  [false, true, true, 5, "pop_felt_or_heard"],
  [true, true, true, 5, "pop_felt_or_heard"],
];

for (const [sudden, pop, difficulty, level, reason] of TABLE) {
  test(`sudden=${sudden} pop=${pop} difficulty=${difficulty} -> L${level} ${reason}`, () => {
    for (const pain of [0, 10]) {
      const r = evaluateEscalation({
        peakSessionPain: pain,
        suddenOrSharpPain: sudden,
        popFeltOrHeard: pop,
        newFunctionalDifficulty: difficulty,
        hasPainLimitingEvent: false,
        endedEarlyForSymptoms: false,
      });
      if (r.level !== level || r.reason !== reason || r.ruleVersion !== "v1") {
        throw new Error(`pain ${pain}: got L${r.level} ${r.reason} ${r.ruleVersion}`);
      }
    }
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
