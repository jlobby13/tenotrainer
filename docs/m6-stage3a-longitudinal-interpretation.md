# M6 Stage 3A — Longitudinal Clinical Interpretation: Architecture Notes

Stage 3A built durable storage/provenance only. No classifier, no thresholds,
no patient-facing states exist yet. This note explains the philosophy behind
the schema so future stages (and reviewers) don't have to reconstruct it
from migration comments alone.

## Clinical interpretation is not raw clinical truth

A row in `m6_longitudinal_interpretations` is a **derived, versioned
output** — the result of running some ruleset over a window of raw
observations at a point in time. It is not itself a clinical fact the way
`rehab_sessions.peak_session_pain` or `morning_responses.next_morning_pain`
are facts (the patient reported those numbers directly). The architecture
enforces this distinction structurally:

```
Prescription -> Session Prescription Snapshot -> Actual Performance ->
Patient Response -> Clinical Interpretation -> Clinician Review
```

Interpretation only ever *reads* the layers below it (via the provenance
join tables) and never mutates them. Nothing "upgrades" an interpretation
into a fact by writing it back onto a session or response row.

## Evidence vs. heuristic — not the same thing

- **`m6_evidence_sources`** catalogues external scientific literature —
  something a researcher published, with a citation, a population, a study
  design, and (critically) an explicit `does_not_establish` field. TenoTrainer
  did not create this knowledge; it is citing it.
- **`m6_heuristics`** catalogues rules TenoTrainer itself created — a rolling
  window size, a directional-frequency threshold, a coverage requirement.
  These may be *informed by* evidence (`m6_heuristic_evidence` links them),
  but a heuristic is an operational decision TenoTrainer made, not a finding
  someone else validated. `evidence_status` on each heuristic is where that
  distinction gets recorded per-rule (e.g. "evidence-informed" vs. "operational
  convenience") — deliberately free text for now, since locking that
  vocabulary is itself a product decision Stage 3A doesn't make.

Conflating the two — presenting an internal heuristic as if it carried the
same weight as a cited study — is the single most important thing this
architecture is designed to prevent once a "View model logic" surface exists.

## Historical immutability

Every table in this stage is append-only for `authenticated` users (RLS
default-denies INSERT/UPDATE/DELETE; only `service_role` writes — the same
trust tier as `escalation_evaluations`, `tolerance_evaluations`, and
`prescription_versions`). A future ruleset update — a new `ruleset_version`
string — produces **new rows**, never a rewrite of old ones. A patient's
interpretation history from three months ago must read identically
regardless of how many times the ruleset has changed since.

`m6_heuristics` extends the same idea to the rules themselves: a
substantive change to a heuristic is a new row with
`supersedes_heuristic_id` pointing at the one it replaces, not an edit of
the original row's `description`. `m6_evidence_sources` has the equivalent
`supersedes_evidence_source_id` chain for a substantive reinterpretation of
what a source `supports`/`does_not_establish`.

This is enforced, not just documented: a `BEFORE UPDATE` trigger on each
table (20260911000008) rejects any change to a heuristic's
`description`/`rationale`/`evidence_status`/`version_introduced`, or to an
evidence source's `supports`/`does_not_establish`, once that row has
actually been cited by a real interpretation (`m6_interpretation_heuristics`
for heuristics, `m6_heuristic_evidence` for evidence sources). Before first
use, cataloguing — including ordinary corrections like a typo or a clarified
rationale — stays a plain `UPDATE`. Harmless bibliographic metadata (DOI,
PMID, citation key, title, authors) is never locked, regardless of use — see
the migration's header comment for the full rationale.

## Transparency philosophy

The long-term goal (not built yet) is that every internally-created
operational rule affecting a patient's Progress view can eventually be
inspected — by a clinician, and possibly by the patient — showing:

- what the rule is (`m6_heuristics.description`)
- why it exists (`rationale`)
- what evidence informs it, if any (`m6_heuristic_evidence` -> `m6_evidence_sources`)
- what that evidence does *not* establish (`does_not_establish`)
- known limitations (`known_limitations`)
- version history (`version_introduced`, `supersedes_heuristic_id`, `status`)

`m6_interpretation_heuristics` is the per-interpretation half of this: given
one interpretation, trace exactly which catalogued heuristics produced it.

## Explicitly deferred research

Bookmarked, not implemented, not scheduled:

- categorical time-series methods for the actual classifier
- mixed-effects / hierarchical multinomial modeling
- clinician-algorithm agreement research
- external-load / symptom-response association analysis
- validation or refinement of any heuristic threshold (5+5, 60%, 65%, 4/6,
  2-of-4, etc. — none of these are implemented; they are named in the M6
  Stage 3 brief as the eventual contents of the catalog, not as decided values)

## Where things live

| Concern | Table(s) |
|---|---|
| Interpretation identity/result | `m6_longitudinal_interpretations` |
| Structured limitations | `m6_interpretation_reason_codes` |
| Provenance (raw observations) | `m6_interpretation_rehab_sessions`, `m6_interpretation_morning_responses`, `m6_interpretation_tolerance_evaluations`, `m6_interpretation_prescription_versions` |
| Provenance (rules applied) | `m6_interpretation_heuristics` |
| Heuristics catalog | `m6_heuristics` |
| Evidence catalog | `m6_evidence_sources`, `m6_heuristic_evidence` |

Server-only read access: `web/lib/longitudinalInterpretationServer.ts`,
`web/lib/heuristicsCatalogServer.ts`. No write path exists yet — see those
files' own header comments for why.
