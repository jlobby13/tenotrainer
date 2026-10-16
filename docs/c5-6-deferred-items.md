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

## C5.6E — response loop follow-ups (recorded 2026-10-15)

- **Response correction semantics.** Submitted immediate and morning
  responses are immutable (C5.6B guards; the C5.6E RPCs replay or refuse a
  changed resubmission). No correction model exists for a mistaken pain /
  RPE / morning value or a safety answer. A future model may let a patient or
  clinician APPEND a clarification/correction, preserving provenance; a
  positive acute-safety fact (including one reported at Stop) is an
  authoritative historical report and must never be destructively rewritten.
- **Reminder delivery.** No push/email/scheduled reminder infrastructure
  exists. The morning obligation becomes due by its frozen `due_at` and is
  surfaced in the app; delivering the configured reminder is deferred.
- **Clinician presentation.** C5 responses are stored in
  `session_immediate_responses` (pain, Session RPE, safety facts) and
  `morning_responses` (resolution, values, reference morning, submitted_at),
  with escalation in `escalation_evaluations` / `acute_safety_episodes`.
  Clinician pages do not yet read `session_immediate_responses`; the
  presentation-only RPE descriptor mapping belongs there.
- **Derived interpretation.** The legacy M4 tolerance evaluation and M6
  longitudinal interpretation are not run for C5 responses (they assume the
  legacy Difficulty field / tolerability item). Deciding how C5 data feeds
  them is a later milestone.
- **C5 Level 1 semantics (unresolved clinical design).** C5 safety
  evaluation v1 yields Level 0, 3 or 5 under the established rules; the
  legacy Level 1 inputs (pain-limiting events, "ended early for symptoms")
  are not captured by C5. Any future C5 Level 1 must be deliberately defined
  and approved — it must NOT be derived from peak pain, Session RPE, morning
  pain/stiffness, incomplete performance, skipped work or any other
  unapproved proxy.
