# C5.6 — deferred items and launch constraints

Recorded at C5.6D founder review (2026-10-15); updated through M1 (2026-10-24). Items are deferred unless a section marks them resolved.

## Launch constraint

- **`C5_PATIENT_RUNTIME_ENABLED` stays OFF** (server env, default off), and so
  does `C5_PRESCRIPTION_PUBLISH_ENABLED`. The product is not production-ready.
- C5.6E is no longer the outstanding condition: the safety/escalation
  evaluation exists (C5.6E), and M1 (2026-10-24) added clinician visibility of
  C5 sessions/responses/safety and the explicit clinician release of
  professional-review holds (see the M1 section below).
- Production cutover still requires the remaining pre-cutover roadmap AND
  explicit founder approval. Outstanding dependencies: native onboarding and
  clinician–patient assignment (M2, which also removes the FastAPI/SQLite
  dependency from authorization); required notification delivery (clinician
  alerts for Level 3/5 and effective >= 4 holds; in-app pause/resume/new-version
  notices); patient-experience completion (exercise guidance); production
  environment and release readiness (hosting, auth URLs, release gate,
  observability); and final cutover verification.

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

## C5.6F — frequency / recovery follow-ups (recorded 2026-10-15)

- **Clinician presentation of adherence and recovery facts.** Weekly progress
  is derived (`c5_weekly_progress`: FINISHED sessions per Mon–Sun local week;
  each session's snapshot keeps the target in force when it was trained) and
  patient decisions are stored in `c5_recovery_decisions`. No clinician page
  shows them yet.
- **Reminder / notification of the next recommended training day** — none
  (no delivery infrastructure; see Reminder delivery above).
- Recovery guidance remains advisory; any future "hard" recovery restriction
  would be a new founder decision, not a configuration of this one.

## M1 — C5 integrity, clinician visibility and safety review (recorded 2026-10-24)

Resolved in M1 (no longer deferred):

- **Clinician presentation** of C5 sessions, responses (incl. the derived
  Session-RPE descriptor), safety, weekly progress and recovery decisions —
  Overview | Program | Sessions | Safety for C5 patients.
- **Snapshot-shape defects**: every legacy reader of `prescription_snapshot`
  handles the C5 object explicitly (`legacySnapshotExercises`); patient
  Progress for a C5 patient is a minimal factual history.
- **Edit provenance**: `set_outcome_edits` keeps OLD -> NEW for every
  in-session correction (Void remains deferred — see above).
- **Professional-review release** (founder-locked D1/D2): any effective
  level >= 4 or professionally-held episode is released only by an explicit
  clinician release (required note, database time, immutable). Database-
  enforced for every writer; applies to legacy and C5 episodes alike. The old
  "patient-reported clearance + newer prescription" path no longer releases.

Still deferred / new debt:

- **M2 REMOVAL REQUIREMENT — FastAPI in the release path.** The clinician
  release uses `verifyHighConsequenceAuthorization`, which still calls the
  legacy FastAPI/SQLite supervisor check and fails closed. M2 must replace it
  with the native Postgres assignment authority. Production cutover must NOT
  depend on FastAPI being available for a clinician to release a
  professional-review hold.
- **Clinician notification** for Level 3 / Level 5 (and effective >= 4)
  episodes — state is visible on the roster/Overview/Safety, but nothing is
  delivered (M3). With Level 5 now clinician-released, delivery is a launch
  requirement.
- **Exercise guidance** (Patient Experience Completion, before cutover):
  consider freezing canonical `setup_instructions`, `execution_cues` and the
  `media_url` reference into the session snapshot so later library edits
  never change what a started session instructed. Not changed in M1.
- **Clinician pause/resume controls** — M2 (Overview shows pause read-only).
- **Safety page query shape**: one `acute_episode_review_state` call per
  episode (parallel). Fine at current volumes; a set-returning variant can
  replace it if episode history grows.
- **Legacy suites** `verifyStage4Loop.mjs` / `verifyStage4ScheduleAuthority.mjs`
  predated the 2026-09-14 morning-eligibility enforcement (064ecf6) and
  finalized the morning response same-day. Fixed at M1 closeout: their
  fixture now moves the persisted `scheduled_eligible_at` into the past (the
  064ecf6 precedent); the gate itself stays asserted by
  `verifyM6Stage4GeneratorWiring.mjs`. Both retire with the legacy runtime (M4).
