# M6 Stage 3C — Capacity + Training Response

Implements the founder-approved Stage 3C design (through round 3 of
founder review): Capacity ("what level of loading can the patient
repeatedly demonstrate", construct-specific, never a universal score) and
Training Response ("how does the tendon respond to the loading performed",
combining Stage 3B's Overall Symptoms with a loading comparison). Capacity
and Training Response are independent axes and can disagree, as designed.

**Round 3 status**: Capacity is now **fully deterministic** — every branch
resolves to a real state, no pending-decision branch remains. Training
Response's window-level loading-aggregation rule remains an **explicit,
unapproved review gate** — see below.

## Capacity: one row per (patient × construct × triggering episode)

Persisted as `domain = 'capacity_series'`, one `m6_longitudinal_interpretations`
row per comparable construct, generated **episode-scoped** (see below) —
never a single per-patient array of unrelated exercise results. Construct
identity and the exact rehab-session provenance used live in
`window_definition`/`result_detail` and the existing Stage 3A provenance
join tables.

### Comparable construct

`web/lib/capacityConstruct.ts` — exact-match triple `(ex_id, loading_profile,
performance_unit)`, read from each session's own frozen `prescription_snapshot`.
A prescription-version change never breaks this (the type doesn't even have
a version field). **Documented technical limitation**: `ex_id` is a frozen
string with no live, FK-enforced exercise catalog behind it (the Postgres
`exercises` table is dead/unused) — this trusts string equality, not
referential integrity. Not redesigned in this pass.

### Performance unit

`derivePerformanceUnit`: isometric + numeric dosage → `hold_seconds`; any
other loading profile + numeric dosage → `reps`; non-numeric dosage (a
range like `"8-12"`, a string like `"45s hold"`, free text) → `unrepresentable`,
never parsed into an invented number. This formalizes an existing implicit
convention (previously only a code comment on `rehabSessionTypes.ts`'s
`actualReps` field) rather than inventing a new one. No `set_outcomes.unit`
migration was created in this pass — documented as future structured-
performance-model technical debt (`m6_reps_vs_hold_unit_resolution`
heuristic).

Exercises whose dosage is `unrepresentable` remain visible factually
(`capacityExposure.ts` still constructs their exposure — completed/skipped
sets are real data) but never receive a formal quantitative Capacity trend
(`capacityClassifier.ts` returns `more_comparable_data_needed` immediately
for them).

### Set-level performance — REAL, ordered, never collapsed (round 3)

**Round 2's min-across-sets aggregation was audited and REJECTED in round
3** — it could systematically understate demonstrated loading (e.g. actual
`[12,12,12,8]` read as `8`, hiding that three sets exceeded any prior
level). It is **not replaced with median-across-sets either** — no
aggregate of any kind collapses a session's sets.

`web/lib/capacityTypes.ts`'s `ExposureSetVector` is an ordered array of
`SetObservation { setIndex, outcome, amount, load }` — the REAL per-set
demonstrated (or prescribed) performance, one entry per prescribed set,
never summed/averaged/min'd/median'd. `amount` is reps or hold-seconds
depending on `performanceUnit` (same convention as before, just no longer
collapsed); `load` is that SAME set's own external resistance — sets are
atomic observations, so a set's reps are never re-paired with another
set's load. A skipped set keeps `outcome: "skipped"` and `amount: null`
(never `0`).

### Structural/partial-order comparison — set-vector vs. set-vector (round 3)

`web/lib/capacityLoadingComparison.ts`'s `compareSetVectors(candidate, baseline)`
replaces round 2's dimension-collapsing `compareLoadingDimensions`. Exact
behavior, reproducing every founder-given worked example:

| Candidate vs. baseline | Result |
|---|---|
| `[12,12,12,12]` vs `[10,10,10,10]` | `higher` |
| `[10,10,10,10]` vs `[10,10,10,10]` | `equal` |
| `[8,8,8,8]` vs `[10,10,10,10]` | `lower` |
| `[12,12,12,8]` vs `[10,10,10,10]` | `non_dominating` — **never** "higher" by majority-of-sets |
| `3×12` vs `4×10` (unequal set count) | `non_dominating` — **always**, no partial-credit logic attempted; never an invented exchange rate between set count and per-set amount |

Within one set, `amount` and `load` moving in different directions is
itself `non_dominating` (never resolved by weighting one over the other).
A dimension unknown on either side of a given set (skipped, or never
recorded) is excluded from just that set's comparison, never coerced to 0.
Comparisons only ever happen between two REAL exposures — there is no
synthetic aggregate anywhere in Capacity's comparison path.

### 2-of-4 confirmation

`web/lib/capacityClassifier.ts`'s `classifyCapacity`: a candidate exposure
must structurally dominate a **baseline** (the exposure immediately
preceding the most recent 4 comparable recorded prescribed opportunities —
a minimum of 5 total exposures, mirroring Stage 3B's own "N + comparison"
window shape) to count as a qualifying-higher demonstration. `≥2` such
demonstrations among the most recent 4 satisfies the locked 2-of-4 rule
(`m6_capacity_comparable_demonstrations_2_of_4`). A single higher exposure
never counts as confirmation by itself.

"Comparable recorded prescribed opportunity" (brief section 6) = a
legitimately created rehab session whose snapshot contains the construct —
deliberately **not** a claim about a schedule-derived denominator, and
never reused for adherence or formal coverage (Stage 3B's coverage stays
`not_computable`).

### Successful exposure qualification (locked)

`isSuccessfulCapacityExposure` (`capacityExposure.ts`):
`well_tolerated+maintain` or `caution+maintain` qualify;
`caution+maintain_cautiously`, `caution+reduce_modify`,
`acute_override/clinical_review`, and the `insufficient_data` placeholder do
not. Tolerance is session-level, so every exercise performed in a session
shares that session's qualification.

### Capacity state mapping — round 3: fully deterministic, zero pending branches

| State | Condition |
|---|---|
| `more_comparable_data_needed` | Insufficient total history (`moreDataNeededReason: "insufficient_total_history"`), an unrepresentable construct (`"unrepresentable_construct"`), OR consistently lower recorded mechanical loading with no opposing higher evidence (`"recent_loading_lower"` — **APPROVED round 3 resolution**, see below). |
| `capacity_building` | Exactly 1 qualifying-higher demonstration (under confirmation), OR 2-of-4 IS mechanically confirmed but the Well-Tolerated-majority test doesn't justify the stronger label. |
| `loading_capacity_improving` | 2-of-4 confirmed AND `wellToleratedQualifyingCount > cautionMaintainQualifyingCount` among the qualifying demonstrations. Caution+Maintain still counts fully toward the 2-of-4 mechanical confirmation — this rule affects the LABEL only. Catalogued as a TenoTrainer operational **labeling** heuristic, explicitly not evidence of biological tendon adaptation. |
| `loading_pattern_variable` | Genuine opposing MECHANICAL evidence only — at least one exposure mechanically higher AND at least one mechanically lower (ignoring tolerance entirely), or a single exposure whose own set-vector comparison is `non_dominating`. |
| `loading_capacity_stable` | Mechanically at-or-above baseline throughout (no lower, no opposing evidence) — **regardless of tolerance mix** (round 3: Capacity is mechanical-only end to end; tolerance/symptom-response variability belongs to Training Response, never to Capacity). |

**Round 3 closes every gap that remained after round 2.** Two decisions
resolved the last ambiguities:

1. **Mechanically stable + mixed tolerance is still `loading_capacity_stable`** (not gated by tolerance at all anymore) — this resolved the earlier open question about whether "all at-or-above baseline" needed "all successful" too. It doesn't.
2. **Consistently lower mechanical loading (no opposing higher evidence) is `more_comparable_data_needed`**, never `loading_pattern_variable`, `loading_capacity_stable`, or any "declining" state — Capacity has **no decline state** by design. The exact rule: any mechanically-lower exposure present among the recent 4, with zero mechanically-higher ones (so not opposing), routes here — a clean binary condition with no invented majority/count threshold. The approved factual phrasing "Recent loading has been lower." is attached via `recentLoadingLowerThanPriorNote`; no inference about why, about physiological capacity, or about regression is ever made.

### Episode-scoped generation (round 3 — replaces "currently prescribed" scoping)

**Round 2's "most recent session overall" scoping was audited and
REJECTED in round 3** — it under-included constructs on a rotating
program (e.g. an A/B split) that simply didn't appear in the single most
recent session.

`generateCapacityInterpretations(userId, rehabSessionId?)` now
(re)evaluates/persists an interpretation **only for the construct(s)
present in the specific triggering episode** (`rehabSessionId`) — not
"whatever the most recent session across the account contains." When
construct A's episode completes, only A is touched; when construct B's
episode completes later, only B is touched, and A's already-persisted row
is left completely alone. This naturally supports any rotation without
inventing a most-recent-N-session window. Verified live: generating B's
episode leaves A's interpretation byte-for-byte unchanged, and exactly one
row exists per construct, never a duplicate.

This engine is still architecturally a per-call batch fetch (it re-reads a
patient's full recent history every invocation, matching every other
module in this codebase — there's no event/queue infrastructure to hook
into yet). The smallest change that produces the required *semantic* is
accepting an explicit `rehabSessionId` naming the triggering episode and
scoping construct selection to that episode's own snapshot; omitting it
defaults to the patient's own most recent base episode, a convenience for
ad-hoc/manual invocation, not the intended production trigger shape.

`getLatestCapacityInterpretationsByConstruct(userId)` is the read-side
counterpart: since a given run only touches its triggering episode's
construct(s), "the current Capacity picture" is assembled by taking the
**latest row per construct**, never the latest row overall (which would
only reflect whichever construct was trained most recently). Historical
rows are never erased — Stage 3A's append-only model is unchanged.

### Lower recent loading — factual only, never inferred

`recentLoadingLowerThanPrior` (single most-recent-exposure fact) and the
broader `moreDataNeededReason: "recent_loading_lower"` (the approved
round-3 state resolution) are both plain, factual fields — paired with the
approved phrasing "Recent loading has been lower." No state name in this
codebase's vocabulary ever uses "declining" language, and no
`capacity_declining`/`loading_capacity_declining` state exists or will —
verified by explicit tests.

### Patient-selected extra dose

Not given special handling beyond the ordinary structural/2-of-4
mechanism: if a patient performs more than prescribed, that's simply a
higher `actual` exposure like any other, subject to the same qualification
and confirmation rules — no bonus, no congratulatory copy is generated
anywhere in this engine (no patient-facing text is generated by Stage 3C at
all; that belongs to a later integration pass).

## Training Response

Persisted as `domain = 'training_response_series'`. Consumes Stage 3B's
Overall Symptoms directly (`trainingResponseInterpretationEngine.ts` calls
`generateShortWindowSymptomInterpretation` first) — no new symptom
hierarchy. P/MP/MS remain the core domains; MSD remains conditional/
enriching, unchanged from Stage 3B.

### Window alignment (locked)

Training Response **always** analyzes loading over the exact same 10
rehab-session IDs as the Stage 3B interpretation it consumes — the engine
takes `previousWindowRehabSessionIds`/`recentWindowRehabSessionIds` directly
from the Symptoms engine's return value rather than re-deriving its own
window. Verified live: the Training Response row's persisted window IDs
are byte-for-byte identical to the Symptoms row's.

### FINAL LOCKED mechanism (round 4): boundary-adjacent one-to-one pairing

Two prior mechanisms were audited and rejected before this one: round 2's
per-dimension median aggregation (could synthesize a combination no real
session ever demonstrated) and round 3's single-real-reference-exposure
approach (collapsed an entire previous half to one arbitrarily-chosen
session). **Neither survives.**

`trainingResponseClassifier.ts`'s `pairBoundaryAdjacent`, per comparable
construct: order that construct's previous-half real exposures
chronologically and its recent-half real exposures chronologically, then
pair **outward from the window boundary** — the most-recent previous
exposure with the earliest recent exposure, the second-most-recent
previous with the second-earliest recent, and so on until the shorter side
is exhausted. Every real exposure appears in **at most one** pair; no
exposure is ever reused, synthesized, or averaged. Real exposures left over
on the longer side are preserved in provenance (`unmatchedPrevious/RecentRehabSessionIds`)
but do not enter that run's paired comparison. Verified live and by
dedicated unit tests reproducing the founder's exact P1/P2/P3 vs R1/R2/R3
example.

**Minimum evidence**: a construct needs **≥2 usable** paired comparisons
(a comparison whose result isn't itself `"insufficient"`) before it may
contribute a formal direction — 0 or 1 usable pair means that construct's
result is `"insufficient"` (the pair, if any, stays visible in provenance).
A TenoTrainer operational *sufficiency* heuristic
(`m6_training_response_minimum_paired_exposures`) — not a validated
biological threshold, MCID, or statistical confidence threshold.

**Construct-level direction** (from usable pairs' `higher`/`equal`/`lower`/
`non_dominating` results only —
`m6_training_response_loading_direction_mapping`):

| Direction | Condition |
|---|---|
| `increased` | ≥1 `higher`, zero `lower`, zero `non_dominating` (`equal` may coexist) |
| `decreased` | ≥1 `lower`, zero `higher`, zero `non_dominating` (`equal` may coexist) |
| `maintained` | every usable pair is `equal` |
| `mixed` | (≥1 `higher` AND ≥1 `lower`) OR any `non_dominating` pair — a single opposing or non-dominating real comparison is intentionally enough to withhold a clean directional claim |

No 60%, majority voting, 2-of-4, mean, median, or weighted scoring appears
anywhere in this step.

**Insufficient constructs are never silently dropped.** Every relevant
construct is represented in provenance as one of increased/maintained/
decreased/mixed/insufficient, with its exposure counts, every pair, and
unmatched IDs. A construct with insufficient data never votes toward the
overall direction, but its presence alongside a usable construct attaches
`limited_comparable_exposures` (this codebase's existing, already-approved
Stage 3A reason code — reused deliberately rather than adding a new
CHECK-constrained enum value for a schema change this pass wasn't asked to
make; the brief described the concept as "limited_comparable_constructs",
flagged here as a disclosed substitution, not a silent one).

**Multi-construct aggregation**: usable constructs vote; all agree → that
value; disagreement, or any usable construct itself `mixed` → overall
`mixed`; zero usable constructs → overall `insufficient`. Never averaged,
never a universal score.

Capacity and Training Response remain fully distinct throughout: this
mechanism never interprets `[higher, equal]` (or any pattern) as Capacity
confirmation — Capacity is governed entirely and only by
`capacityClassifier.ts`'s own independent 2-of-4/qualification/labeling
rules.

### Training Response state mapping (final locked v1)

Implemented exactly as the literal AND-conditions given, checked in
priority order; anything matching none of them falls to `more_data_needed`
by construction:

- `loading_tolerance_improving`: Overall Symptoms ∈ {improving,
  trending_better} **AND** loading ∈ {maintained, increased}.
- `stable_training_response`: Overall Symptoms = stable **AND** loading =
  maintained.
- `variable_training_response`: Overall Symptoms = mixed **AND** loading ∈
  {increased, maintained, **mixed**}. `mixed` loading is included here on
  founder decision: Mixed Symptom Response already represents observed
  symptom variability, not missing information, so mechanical loading
  variability does not erase it — no claim is made that loading *caused*
  the symptom variability, only that both are independently visible.
  `decreased` is deliberately excluded: a material deload means a formal
  longitudinal loading-tolerance interpretation isn't justified, so that
  combination falls to `more_data_needed` below, with Mixed Symptom
  Response remaining independently visible.
- `training_response_remains_unsettled`: Overall Symptoms = trending_higher
  **AND** loading ∈ {maintained, increased}.
- `more_data_needed`: Symptoms insufficient, OR no construct has ≥2 usable
  pairs (loading = `insufficient`), OR everything else not covered above.
  This is a fixed priority chain — loading being mechanically `mixed` never
  promotes any OTHER symptom state (stable, improving, trending_higher)
  into a positive Training Response state; each of those keeps its own
  stricter loading requirement and falls through to `more_data_needed`
  when loading is `mixed`. Only Stage 3B's own `mixed_symptom_response`
  determination qualifies for the `variable_training_response` branch
  above.

**A documented, faithful-to-the-letter consequence, not a bug**: some
symptom/loading combinations the brief didn't explicitly award a positive
state to — e.g. stable symptoms with *increased* loading, or
trending-higher symptoms with *decreased* loading — resolve to
`more_data_needed` rather than an invented sixth bucket. Symptoms improving
after decreased loading never becomes `loading_tolerance_improving`, and no
claim is ever made that the lower loading caused the symptom improvement —
the favorable Symptoms result remains independently visible.

### If symptoms improve after a meaningful deload

`loading_tolerance_improving` requires loading maintained-or-increased —
a `"decreased"` verdict (once the aggregation rule exists) never reaches
that branch, so a deload-driven symptom improvement always falls through
to `more_data_needed` at the Training Response layer. The favorable
Symptoms interpretation itself (Stage 3B's `symptoms_improving`) remains
fully intact and readable separately — Training Response never overwrites
or hides it, and no claim is ever made that the deload *caused* the
improvement.

## External loading

Unchanged from Stage 3B's pattern: `external_loading_context_present` may
be attached to either a Capacity or Training Response interpretation as an
existence-only reason code. Never numerically weighted, never added to
prescribed/actual load, never able to alter a Capacity or Training
Response state — structurally guaranteed, since neither classifier's
function signature accepts external-load data at all.

## Safety

Neither engine queries acute-safety tables at all — a safety event never
automatically breaks a Capacity series or retroactively alters historical
interpretations (both are append-only, matching Stage 3A's immutability
model). If a safety-related plan change alters the exercise/loading-profile/
performance-unit, the *ordinary* comparable-construct rule already creates
a new series — no bespoke safety-specific rule was needed. Whether a
persistent L4/L5 brake should force a series boundary even when construct
identity is technically unchanged remains an open question, surfaced but
not implemented.

## Multi-construct `mixed` (APPROVED, final)

Exists **only** in Training Response's loading-comparison layer, never as
a Capacity state (Capacity has no "mixed" — each construct gets its own
fully independent row). Per-construct results stay a separate array
(`constructResults`, one entry per construct, each carrying its own full
pair list) — `mixed` is a categorical summary of disagreement among usable
constructs, never a numerical average, and the summary never hides the
individual per-construct results, which remain in `result_detail`
regardless of what the overall verdict becomes.

## Heuristic catalog

Ten rows total across three migrations, all additive — no applied
migration is ever edited:

`20260913000001_m6_stage3c_capacity_training_response_heuristics_seed.sql`:
`m6_capacity_comparable_series_definition`,
`m6_partial_order_loading_comparison`, `m6_capacity_comparable_demonstrations_2_of_4`,
`m6_successful_capacity_exposure_qualification`, `m6_capacity_state_mapping`,
`m6_training_response_state_mapping`, `m6_reps_vs_hold_unit_resolution`.

`20260913000002_m6_stage3c_set_level_structural_comparison_update.sql`
**plain-UPDATEs** three of those rows' description/`known_limitations`
text to reflect the round-3 set-level mechanism. Confirmed safe before
writing it: zero `m6_interpretation_heuristics` rows reference any of these heuristics in
the live database (nothing has used them for real yet), so the Stage 3A
supersession guard permits a plain update rather than requiring a
supersession chain.

`20260913000003_m6_stage3c_training_response_window_heuristics_seed.sql`
(round 4, additive): `m6_training_response_window_pairing` (boundary-adjacent
pairing), `m6_training_response_minimum_paired_exposures` (the ≥2-usable-pairs
sufficiency floor), `m6_training_response_loading_direction_mapping` (the
construct-level and multi-construct combination rules).

None of the ten heuristics link a fabricated evidence citation; every
`evidence_status` is `operational_convenience`.

## Provenance

Both engines reuse `persistInterpretation` (generalized from Stage 3B's
Symptoms-only helper to accept an explicit `domain` and plain ID arrays),
so both get the exact same provenance mechanism Stage 3A/3B already
established: linked `rehab_sessions`/`tolerance_evaluations`/
`prescription_versions`/`heuristics`/`reason_codes` rows, immutable once
written, a new row per ruleset version rather than a rewrite. Capacity's
`result_detail` preserves, per relevant session: the construct identity,
the qualifying/mechanical-evidence session IDs, both Well-Tolerated and
Caution+Maintain counts, the `moreDataNeededReason` when applicable, and
the **full real set-level vectors** (`prescribedSets`/`actualSets`, never
discarded after classification) alongside tolerance outcome. Training
Response's `result_detail` carries the exact Overall Symptoms state
consumed, the overall loading direction, whether any construct was
insufficient, and the full per-construct breakdown (exposure counts, every
pair and its comparison, unmatched exposure IDs, direction, insufficiency
reason) — never discarded, regardless of what the overall verdict is.

## Explicitly out of scope

No Capacity or Training Response inference existed before this pass, and
this pass does not touch the Stage 3B symptom engine's own classification
logic, the Progress page, or any patient-facing UI. **Both Capacity and
Training Response are now fully deterministic — zero pending branches
remain in either.** The symptoms=mixed + loading=mixed combination was
explicitly surfaced and resolved by founder decision to
`variable_training_response` — see "Training Response state mapping"
above.

---

## SUPERSEDED — earlier rejected mechanisms (kept for history, not current)

Two Training Response window mechanisms were proposed and rejected before
the final one above was locked — neither is implemented anywhere in the
current code:

1. **Per-dimension median window aggregation** (round 2): aggregated each
   half's exposures into a synthetic vector via independent per-dimension
   medians. Rejected because the audit proved this can synthesize a
   `(completedSets, perSetAmount)` combination that no real session ever
   demonstrated (each dimension's median can come from a *different*
   underlying session).
2. **Single real previous-half reference exposure** (round 3): compared
   every recent-half exposure against just the one most-recent previous-half
   exposure. Rejected because it collapsed an entire previous window down to
   one arbitrarily-chosen session, discarding the rest of that half's real
   observations entirely, with no founder-approved rationale for why that
   particular exposure was the right one to trust.
   A proposal to reuse Stage 3B's ≥60% frequency mechanism on top of that
   reference approach was also considered and explicitly **not** adopted —
   the founder held that Stage 3B's threshold was approved for a
   structurally different construct (fixed N=5 integer symptom domains) and
   reusing it here would itself be a new, unapproved operational heuristic.
