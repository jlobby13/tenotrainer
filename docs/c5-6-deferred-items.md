# C5.6 — deferred items and launch constraints

Recorded at C5.6D founder review (2026-10-15). Nothing here is implemented.

## Launch constraint

- **`C5_PATIENT_RUNTIME_ENABLED` must stay OFF** (server env, default off) until
  C5.6E delivers the downstream safety/escalation evaluation. Until then a
  patient-reported in-session safety fact (Stop sheet) correctly closes the
  session as `stopped_acute` and pre-fills only that fact on the immediate
  response, but no escalation is evaluated and no clinician is alerted.

## Patient experience follow-ups (C5 session)

| Item | Priority | Constraint |
|---|---|---|
| Exercise guidance panel | Reconsider before production (higher priority usability) | Must not reuse legacy stage/irritability clinical-state logic |
| Rest timer | Desirable | Same |
| "Last time" figures | Wait for the design of historical C5 performance presentation | Same |
| C5 dashboard: feedback cards / previous-session panel | Reconsider once the full C5 clinical data loop runs | Current scope: Today's Rehab, Progress, Settings |

## Data-provenance debt: erroneous performance units

Today (C5.6C, authoritative): a recorded unit can be **edited**
(`c5_edit_performance`, sets `was_edited`) but a completed unit can never
become a skip or be removed. No client-side delete or completed→skip
workaround may be added.

Future requirement — an explicit correction model distinguishing:

1. **Edit** — "I performed this unit, but entered its values incorrectly."
2. **Void / erroneous entry** — "This unit was recorded accidentally and did
   not occur."

A void must preserve provenance (the original recorded fact, who voided it,
when, why) rather than silently deleting it, and must define how a session
whose only completed unit is voided is represented (C5 sessions require at
least one performed unit). Requires a lifecycle change — not part of C5.6D.
