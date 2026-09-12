# M6 Stage 3B — 5+5 Longitudinal Symptom Engine

Stage 3B implements the first real classifier on top of Stage 3A's storage
architecture: a deterministic, rule-based short-window (5+5) comparison of
P (peak session pain), MP (next-morning pain), MS (next-morning stiffness
intensity), and MSD (next-morning stiffness duration, ordinal). Capacity and
Training Response are explicitly **not** implemented here.

## Response episodes

The atomic unit (`web/lib/responseEpisode.ts`) is exactly the locked
definition: a completed rehab session + actual performance (set outcomes) +
a *finalized* M4 morning response (`submitted_at` not null — a progressively
saved draft is never a fact) + a persisted tolerance evaluation. All four
conditions are checked independently (`isBaseResponseEpisode`), not inferred
from `rehab_sessions.status` alone.

A base episode's eligibility for the *symptom analysis specifically* is a
second, separate check: P, MP, and MS must all be non-null, and — the
locked UNKNOWN != ZERO rule — MS > 0 with a null stiffness duration makes
the episode incomplete, while MS = 0 is a legitimate complete value
regardless of whether the duration column holds `'not_applicable'` or is
still null.

## The 5+5 algorithm

`web/lib/responseEpisode.ts`'s `selectShortWindows` takes eligible episodes
sorted newest-first and returns exactly the most recent 5 ("recent") and the
5 immediately before them ("previous"), or `null` when fewer than 10 exist.
No calendar-day substitution, no padding with incomplete episodes.

For each core domain, `web/lib/symptomClassifier.ts`'s `classifyCoreDomain`:

1. Computes the previous window's median (`symptomStatistics.ts`).
2. Classifies each of the 5 recent values as lower/similar/higher against
   that median using the 1-point operational boundary
   (`relativeDirection`, `DIRECTIONAL_BOUNDARY_POINTS = 1`).
3. **Frequency is primary**: `classifyFrequencyPattern` requires ≥60% (3 of
   5) on one side (`DIRECTIONAL_FREQUENCY_THRESHOLD = 0.6`) to call a
   favorable or unfavorable pattern at all.
4. **Median is corroborating only**: a favorable/unfavorable frequency
   pattern only becomes `improving`/`trending_higher` if the recent-window
   median actually moved the same direction. If frequency says one thing and
   the median doesn't confirm it, the result is `stable` — never forced.
5. **IQR is descriptive only**: `interquartileRange` is computed and stored
   in `resultDetail` for context; nothing in the classifier branches on it.
   Arithmetic mean is never computed anywhere in this module.

A mathematical/implementation characteristic of this v1 method — **not a
clinical rule** — discovered while writing the test suite and confirmed by
exhaustive test (`symptomClassifier.test.ts`'s "PROPERTY" test, which
brute-forces all 11 previous-window medians × all 11^5 recent-value
combinations on the 0-10 scale, 1,771,561 cases): at exactly n=5 with a
1-point boundary, a ≥3/5 frequency pattern **provably always** produces a
corroborating median movement (pigeonhole: the 3+ "lower" values are
necessarily the smallest, so they occupy the sorted median position too).
Per explicit founder direction, this property does **not** justify removing
median corroboration from the architecture — frequency remains primary,
median remains corroborating, IQR remains descriptive-only, and the
classifier is not rewritten into a median-first system. Discordance is
structurally unreachable for the whole-window P/MP/MS comparison at n=5; it
only matters for MSD's ordinal comparison, where the qualifying (MS>0)
sample size can be smaller than 5 per window.

## Consistency — APPROVED (M6 v1)

Founder-approved mapping (`classifyConsistency` in `symptomClassifier.ts`),
catalogued as heuristic `m6_consistency_variable_vs_consistent`
(`supabase/migrations/20260912000002_m6_stage3b_consistency_and_msd_heuristics.sql`):

- **Variable**: the 5 recent relative-direction observations contain *both*
  at least one "lower" and at least one "higher" (genuinely opposing
  evidence).
- **Consistent**: otherwise — a one-sided mix of `lower + similar` with no
  `higher` (or `higher + similar` with no `lower`) is explicitly NOT
  automatically variable, since "similar" is neutral, not opposing.
- **insufficient_data**: when the formal 5+5 domain analysis itself is
  unavailable.

Direction and consistency remain fully separate outputs. IQR plays no role
in this decision, and no IQR threshold has been or will be introduced for
it. This is a TenoTrainer operational definition for M6 v1, not a validated
Achilles clinical threshold.

## MSD — ordinal only, ≥3 applicable observations per window (FOUNDER DECISION)

`classifyMsd` reuses `STIFFNESS_DURATION_ORDER` (now exported from
`progressCompare.ts` rather than duplicated) to rank the four real duration
buckets, filters out `not_applicable` (MS=0) episodes from the comparison
entirely, and reapplies the *same* frequency-primary/median-corroborating
hierarchy to those ranks — never converting a bucket to a fake minutes
value, never averaging. Its five-value vocabulary (shorter/stable/longer/
variable/insufficient_data) collapses direction and "no clean call" into one
axis, since MSD has no separate consistency output in the brief.

**Minimum sample size (founder decision, supersedes the earlier ≥1
proposal)**: a formal MSD direction requires at least
`MSD_MIN_APPLICABLE_OBSERVATIONS_PER_WINDOW = 3` applicable, known duration
observations in **each** of the previous and recent windows. An "applicable
MSD observation" is an episode where morning stiffness duration is actually
applicable and known (MS > 0 with a real bucket) — MS = 0 is legitimately
not applicable and does NOT make the response episode itself incomplete,
but it contributes no ordinal observation to this specific sub-analysis.
Below the floor in either window, MSD direction is `insufficient_data`; raw
MSD history remains available, and core P/MP/MS classification proceeds
normally, entirely unaffected (see "Overall Symptoms summary" below).
Catalogued as heuristic `m6_msd_min_3_applicable_per_window`
(`20260912000002_...sql`) — a TenoTrainer operational heuristic for v1, not
a validated biological/clinical threshold.

## Overall Symptoms summary

`classifyOverallSymptoms` reads only the three core domains' directions
(never MSD, never consistency, no numerical weighting) and applies the
locked mapping exactly as specified, checked in this priority order:

1. ≥2 improving AND 0 higher → **Symptoms Improving**
2. exactly 1 improving AND 0 higher → **Symptoms Trending Better**
3. ≥1 improving AND ≥1 higher → **Mixed Symptom Response**
4. ≥2 higher AND 0 improving → **Symptoms Trending Higher**
5. otherwise → **Symptoms Stable**
6. any core domain `insufficient_data` → **More Data Needed** (checked
   first, short-circuits the above)

`classifyOverallSymptoms`'s signature only accepts `{ P, MP, MS }` — it has
no parameter through which MSD could influence it even by accident. MSD
insufficiency (now common under the stricter ≥3-per-window floor above)
therefore never forces `more_data_needed`: verified live by
`verifyM6Stage3bSymptomEngine.mjs`'s scenario C, which has 0 applicable MSD
observations in both windows (MS=0 throughout) yet still resolves to a real
`mixed_symptom_response` overall state from P/MP/MS alone. No numerical
weighting exists anywhere in this function.

## Coverage — FORMAL COMPUTATION DEFERRED (founder decision)

Section 10 of the brief requires session-completion coverage and
complete-response coverage, denominated by "eligible prescribed loading
opportunities" (never calendar days). An earlier pass here used an interim
proxy denominator; **the founder rejected that proxy**: it cannot detect a
prescribed opportunity that was never attempted and left no trace at all
(no session, no safety block), so it would systematically **overstate**
coverage.

**Founder decision: formal coverage is not calculated or persisted at all
in Stage 3B.** `web/lib/symptomCoverage.ts`'s `buildCoverageContext` was
rewritten to remove the ratio-producing code path entirely — there is no
`eligibleOpportunities` field, no denominator, no ratio anywhere in its
output. It returns:

```ts
{
  sessionCompletionCoverage: "not_computable",
  completeResponseCoverage: "not_computable",
  reason: "...", // explains why, references the missing denominator
  rawCounts: {
    attemptedSessionCount, completedSessionCount,
    completeResponseEpisodeCount, safetyBlockedOnlyCount,
  },
}
```

`rawCounts` preserves the underlying facts (session/episode counts, kept
separate per the locked distinction) so an authoritative-denominator pass
later doesn't have to re-derive them — but these are plain counts, never
presented as a ratio, and never surfaced to a patient or clinician. This
`not_computable` status is verified to be actually **persisted** (not just
returned in-memory) in `result_detail.coverageContext` by the live
verification script. The 5+5 symptom classifier itself is unaffected — it
still operates on the 10 most recent eligible complete response episodes
regardless of coverage's availability.

Authoritative "eligible prescribed loading opportunities" reconstruction
(a real schedule/cadence primitive — `rehab_days_of_week` is null for every
patient today, see `rehabSchedule.ts`) is **required before formal coverage
interpretation of any kind**, and is explicitly deferred to a future stage.
No replacement denominator was invented in this pass.

## Reason codes actually generated this pass

Only codes with an unambiguous, non-threshold trigger are auto-generated:

- `mixed_symptom_directions` — direct categorical mapping from the overall
  state being `mixed_symptom_response`.
- `recent_prescription_change` — reuses `comparePrescriptionVersions` from
  `progressCompare.ts` across the 10-episode window; no new comparator.
- `external_loading_context_present` — existence check only (any recent
  episode has a non-`'none'` `session_load_observations` category); never
  changes the classifier itself, per the brief.

**Deferred by explicit founder decision, not merely unimplemented:**

- `limited_coverage` — depends on formal coverage, which is not computed
  (see above). No threshold has been invented. Remains in the Stage 3A
  reason-code vocabulary for future use once coverage is authoritative.
- `high_response_variability` — the domain-level Consistency output
  (`consistent`/`variable`) already covers this need; no additional
  IQR/distribution threshold has been invented to independently trigger
  this code. Remains available in the vocabulary for future use.

`limited_comparable_exposures` and `capacity_response_mismatch` are also not
emitted this pass (the former wasn't named as relevant for Stage 3B; the
latter is a Capacity-specific code, out of scope).

## Heuristic provenance

Six heuristic catalog rows now exist, across two migrations (the first
already applied and never edited; the second added post-founder-review):

`supabase/migrations/20260912000001_m6_stage3b_symptom_heuristics_seed.sql`:
the 5+5 window design, the ≥60% directional-frequency rule, the 1-point
directional boundary, and the overall Symptoms summary logic.

`supabase/migrations/20260912000002_m6_stage3b_consistency_and_msd_heuristics.sql`
(new, additive — neither row supersedes an existing one, so the Stage 3A
supersession chain doesn't apply here): the approved consistency mapping
(`m6_consistency_variable_vs_consistent`) and the MSD ≥3-per-window floor
(`m6_msd_min_3_applicable_per_window`).

Keys are mirrored in `web/lib/symptomHeuristics.ts`, looked up at runtime by
`getHeuristicByKey`, never hardcoded UUIDs — a fully-computed interpretation
links all 6. Each row states plainly that it is a TenoTrainer operational
choice, not a validated Achilles biological threshold, and none links a
fabricated evidence citation.

## Persistence

One row per run in `m6_longitudinal_interpretations`, `domain =
'symptoms_short_window'` (one of the exact illustrative values the Stage 3A
migration's own header anticipated), `ruleset_version =
LONGITUDINAL_RULESET_VERSION` (`"m6_longitudinal_v1"`, reused from
`longitudinalInterpretationTypes.ts` — no new version constant was
created). `window_definition` explicitly lists which rehab-session ids
occupy the previous and recent window slots, so membership is reproducible
without re-deriving it. `result_detail` carries the full per-domain
direction/consistency/median/IQR/frequency detail, the MSD result, and the
coverage context (`not_computable` status + raw counts — see "Coverage"
above). Every provenance table from Stage 3A
(`m6_interpretation_rehab_sessions`/`morning_responses`/
`tolerance_evaluations`/`prescription_versions`/`heuristics`, plus
`m6_interpretation_reason_codes`) is populated from the real episode set.
A future ruleset version is a new row; nothing here ever rewrites a past
interpretation — verified live (see the acceptance report) by generating a
real interpretation, then inserting a simulated later-ruleset-version row
and re-reading the original unchanged.

## Explicitly out of scope

Capacity classifier, Training Response classifier, 2-of-4 capacity
confirmation, long-term 6/8/12-week comparison, rehab-plan causality,
patient-facing Progress redesign, clinician Agree/Disagree/Unsure,
composite scores, automated prescription progression, new acute-safety
logic, external-load causal inference. See the Stage 3B brief.
