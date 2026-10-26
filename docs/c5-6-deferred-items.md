# C5.6 — deferred items and launch constraints

Recorded at C5.6D founder review (2026-10-15); updated through PEC (2026-10-26). Items are deferred unless a section marks them resolved.

## Launch constraint

- **`C5_PATIENT_RUNTIME_ENABLED` stays OFF** (server env, default off), and so
  does `C5_PRESCRIPTION_PUBLISH_ENABLED`. The product is not production-ready.
- C5.6E is no longer the outstanding condition: the safety/escalation
  evaluation exists (C5.6E), and M1 (2026-10-24) added clinician visibility of
  C5 sessions/responses/safety and the explicit clinician release of
  professional-review holds (see the M1 section below).
- Production cutover still requires the remaining pre-cutover roadmap AND
  explicit founder approval. M2 (2026-10-25) delivered native onboarding,
  Postgres assignment authority, the FastAPI/SQLite removal from
  authorization, clinician pause/resume and in-app program notices (see the M2
  section). PEC (2026-10-26) completed the native patient experience (see the
  PEC section). Outstanding dependencies: required clinician notification
  delivery (alerts for Level 3/5 and effective >= 4 holds); production
  environment and release
  readiness (hosting, auth URLs, disabling public Supabase sign-ups, release
  gate, observability); and final cutover verification.

## Patient experience follow-ups (C5 session)

| Item | Priority | Constraint |
|---|---|---|
| ~~Exercise guidance panel~~ | Resolved in PEC (frozen snapshot v2 guidance) | — |
| Rest timer | Deferred (P2): optional patient-started countdown; PEC shows prescribed rest prominently, never enforced | Never alters session authority |
| ~~"Last time" figures~~ | Resolved in PEC (factual context, see below) | — |
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

- ~~M2 REMOVAL REQUIREMENT — FastAPI in the release path.~~ Resolved in M2:
  the release (and create/publish/pause/resume) authorize against Postgres
  only and are verified with FastAPI unreachable.
- **Clinician notification** for Level 3 / Level 5 (and effective >= 4)
  episodes — state is visible on the roster/Overview/Safety, but nothing is
  delivered (M3). With Level 5 now clinician-released, delivery is a launch
  requirement.
- **Exercise guidance** (Patient Experience Completion, before cutover):
  consider freezing canonical `setup_instructions`, `execution_cues` and the
  `media_url` reference into the session snapshot so later library edits
  never change what a started session instructed. Not changed in M1.
- ~~**Clinician pause/resume controls**~~ — resolved in M2 (Program page).
- **Safety page query shape**: one `acute_episode_review_state` call per
  episode (parallel). Fine at current volumes; a set-returning variant can
  replace it if episode history grows.
- **Legacy suites** `verifyStage4Loop.mjs` / `verifyStage4ScheduleAuthority.mjs`
  predated the 2026-09-14 morning-eligibility enforcement (064ecf6) and
  finalized the morning response same-day. Fixed at M1 closeout: their
  fixture now moves the persisted `scheduled_eligible_at` into the past (the
  064ecf6 precedent); the gate itself stays asserted by
  `verifyM6Stage4GeneratorWiring.mjs`. Both retire with the legacy runtime (M4).

## M2 — native onboarding, assignment authority & clinician controls (recorded 2026-10-25)

Founder decisions (locked): several active clinicians per patient within one
organization; a second same-organization invitation ADDS a clinician; a
different-organization invitation is refused (no automatic transfer); the
clinical record belongs to the patient (assignment changes never touch
programs, history, safety state, Started sessions or obligations); regular
clinicians invite, clinician_admin / super_user add and end assignments;
"Accept invitation" is the patient's confirmation; a minimal native admin
assignment page, not hand-written SQL.

Delivered:

- **Postgres is the assignment authority** (`supervisor_patients`, migrations
  `20261025000000` + `20261025000001`): organization + provenance
  (`created_by`, `source_invitation_id`, dismissal fields); one row per
  assignment period; active-only uniqueness per (organization, clinician,
  patient); ended periods are never reactivated (re-assignment is a new row);
  an active row's clinician must hold a clinician role in the row's
  organization, enforced by trigger, with a guard refusing membership changes
  that would break an active row. `clinician_patient_access()` is the one
  authorization primitive (`assertSupervises` /
  `verifyHighConsequenceAuthorization` both use it).
- **FastAPI/SQLite removed from authorization** for create draft, publish,
  pause, resume and professional-review release — not replaced by any
  fallback; proven with FastAPI unreachable (`verifyM2NativeOnboardingUi.mjs`).
- **Patient invitations**: type `PATIENT`, role fixed to `member` (by type, in
  the database), SHA-256 token hash only (plaintext column dropped for all
  invitations), atomic `accept_patient_invitation` (membership + assignment +
  accepted state in one transaction), native acceptance (never the FastAPI
  bridge).
- **Role-escalation fix**: direct client reads/writes of `invitations` removed;
  `invitations_role_matches_type` makes a super_user invitation impossible.
- **Grant hardening**: no client INSERT/UPDATE/DELETE/TRUNCATE on
  `supervisor_patients`, `organization_members`, `invitations`; no anon writes on
  `organizations` / `profiles`.
- **One redirect validator** (`lib/safeRedirect.ts`) for login, auth callback,
  invitation login handoff, admin `_redirect_base` and launch-dashboard `dest`.
- `/register` is not an onboarding path (redirects to login with
  invitation-required copy; the public sign-up action is deleted).
- Gate ON: every patient-role account is served by C5 ("No active program"
  when nothing is published) — no legacy fallback.
- Clinician Pause / Resume program (Program page, two-step confirmation with
  the locked semantics); patient program notices (paused / resumed / shared /
  updated, fixed copy, `read_at` dismissal).
- Legacy assignment sync writer retired (`/api/internal/supervisor-patients-sync`
  answers 410; `backfillSupervisorPatients.mjs --write` refuses).

Still deferred / new debt:

- **Legacy patient write grants (M3 cutover).** Still granted to
  `authenticated` because the gate-OFF legacy runtime uses them; no M2/C5
  feature depends on them: `rehab_sessions` INSERT/UPDATE, `set_outcomes`
  INSERT/UPDATE, `session_events` INSERT, `morning_responses` INSERT/UPDATE,
  EXECUTE on `create_rehab_session_if_allowed` and
  `reconcile_missing_acute_episodes`. Revoke at cutover. (`notifications`
  UPDATE(read_at) is intended and stays.)
- **Public Supabase sign-up** must be disabled in the production project (M3
  environment configuration). An orphan account reaches only "No active
  program" and has no clinician.
- **Cross-organization transfer** is not product-defined: unavailable in the
  normal UI (invitation refuses; admin page is single-organization).
- **Remaining FastAPI dependencies** (not authorization): legacy gate-OFF
  patient dashboard/session (`getPatientSummary`), Exercise Library /
  onboarding links via `launch-dashboard`, `/super/dashboard`
  (`getSuperOverview`), `/api/internal/prescription-versions`,
  validate-bridge. Removal belongs to cutover.
- **Admin tester/clinician-admin invitation** page still carries the one-time
  token in its post-create redirect URL (pre-M2 admin flow; tokens are now
  hashed at rest). The clinician patient-invitation flow returns the link in
  the action response instead.
- `getSessionInfo().memberships[0]` still drives page ROUTING (which dashboard
  a user lands on) for multi-organization users; it is no longer used for any
  clinician–patient authorization.
- Pause/resume controls are offered for C5 programs only (the C5 runtime is
  what enforces a pause); legacy patients keep the read-only banner.

### Test infrastructure (recorded at M2 closeout, 2026-10-25)

- **M6 Stage 3B/3C suites repaired, not retired.** They were written against
  a temporary dev-only route (`/api/internal/dev-verify-symptom-engine`) that
  was deleted before Stage 3B was finalized and never committed, so they
  had been unrunnable since 2026-09-12/13. They now call the same
  authoritative engine functions in-process via
  `web/scripts/lib/m6EngineHarness.mjs` (run with
  `node --conditions=react-server --experimental-strip-types …`); assertions
  unchanged. No dev endpoint was restored. The production wiring of those
  engines into the morning-response finalize route stays covered by
  `verifyM6Stage4GeneratorWiring.mjs`.
- **DEBT — fixture leakage (not acceptable as permanent behaviour).** The
  Builder suites `verifyC5Stage4aPrescriptionBuilder.mjs`,
  `verifyC5Stage4bDosageAuthoring.mjs` and `verifyC5Stage4cWorkoutScheduling.mjs`
  leave their owner clinician and (published-program) patient
  `@example.invalid` accounts behind after every run (observed on
  2026-10-10, 10-11, 10-16, 10-24 and 10-25; pre-dates M2). The Stage 4
  legacy suites (`verifyStage4Loop`, `verifyStage4ScheduleAuthority`) also
  leave `m5-stage4-*` users. Their teardowns need the same treatment as the
  M2 HttpLayer fix (delete notifications / prescription rows that block user
  deletion, and log teardown errors) in a dedicated test-infrastructure pass.

## PEC — Patient Experience Completion (recorded 2026-10-26)

Completed in PEC:

- **Frozen patient exercise guidance** — session snapshot version 2
  (`20261026000001`): per exercise `patient_guidance { explanation, setup,
  cues, watch_for, media_url }` copied from the library when the snapshot is
  built. The pre-start preview shows the current library; the snapshot frozen
  at first confirmed performance is the only source afterwards. Version-1
  snapshots are not backfilled and show no guidance (never a live fallback).
  Clinician-only content (`contraindications_or_cautions`, `clinician_notes`)
  is never copied. The clinician's own note is shown separately ("Note from
  your clinician").
- **Pre-start review → Begin workout** — the workout opens read-only; Begin
  is UI state only (no write, no session, nothing persisted); the session
  still Starts only at the first confirmed performance. No Finish control
  exists before Start.
- **Last time** — factual context only: the most recent closed (Finished or
  Stopped) C5 session with at least one completed unit of the same library
  exercise and the same primary quantity; any prescription version; current
  (corrected) values; per-set listing whenever loads differ; nothing when
  there is no compatible history. No comparison or advice.
- **Rest** — prescribed rest shown prominently ("Rest 90 sec between sets",
  and before the next set). No timer; never enforced.
- **Patient dosage wording** — RPE / RIR / ROM / side shown in plain language
  (display only; prescriptions unchanged). "Bout" retired.
- **Progress** — "done · skipped · left" from server-recorded units only.
- **Upcoming morning check-in** — "Morning check-in opens tomorrow at 7:00 AM."
  from the authoritative `scheduled_eligible_at` (due semantics unchanged),
  after the post-session check-in and on the dashboard while not yet due.
- **Paused + safety hold** — while paused, an open safety hold is shown as a
  secondary card ("Clinician release required" for professional review)
  linking to the safety check-in. Presentation only; eligibility order
  unchanged.
- **Notices** below the primary state card.
- **Accessibility** — meaningful accessible names for the 0–10 scales; Stop
  sheet initial focus, focus containment, Escape and focus return.
- **Safety wording** — the Level 5 hold title "Stop Loading" became "Pause
  your rehab exercises" (state and algorithm unchanged; the legacy M3 copy
  that still says "Stop Loading" is legacy-runtime only).

Deferred:

- Exercise media content and hosting (`media_url` is frozen; nothing renders
  while it is null).
- Optional patient-started rest countdown (P2).
- **Distance actual-performance entry (P2).** A distance-primary
  prescription (`dosage_type = 'distance'`) is recorded by the UI. A distance
  dimension that is SECONDARY to another primary quantity (possible when a
  time prescription keeps its earlier type after distance is added) is
  displayed but cannot be recorded. No current prescription uses distance
  (0 dosage rows); only 3 library exercises offer it (as interval-time +
  distance, where distance takes precedence and is recordable).
- Theme consistency (Settings and the shared safety check-in page use the
  legacy light theme).
- Production observability (M3).
- M6 symptom/capacity/training-response interpretation for C5 data.
- A separate patient Exercise Library (not needed for the daily workflow).
- P2/P3 polish: arrow-key navigation inside 0–10 radio groups, a sticky
  progress counter, "current session unaffected" wording on update notices,
  no-program copy refinement.
