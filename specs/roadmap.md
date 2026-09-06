# TenoTrainer Roadmap / Backlog

Living record of work intentionally deferred out of a closed milestone. Items
here are scoped decisions, not just ideas — each was explicitly considered
and placed here rather than folded into the milestone that raised it.

---

## Milestone 4 — Morning Response

**Stage 1 (data + timing foundation) — DONE.** `morning_responses` and
`tolerance_evaluations` tables, `profiles.timezone`/`morning_reminder_time`,
the timezone-aware `getScheduledMorningEligibility` utility (via
`date-fns-tz`), `ensureMorningResponseExists` (shared eager-creation +
lazy-backfill lifecycle, freezing `scheduled_eligible_at` once a real
timezone is known — never fabricated as UTC), and `getOldestOutstandingMorningResponse`.
No questionnaire, no session-start gating, no tolerance engine, no
clinician UI — those remain Stage 2+.

Known limitation, by design: pre-M4 `awaiting_morning_response` sessions
recovered via the lazy-backfill path never had a frozen historical
reminder/timezone snapshot — their `scheduled_eligible_at` reflects the
patient's timing preference at whatever moment they were first recovered,
not a true historical value (none was ever recorded, and none is fabricated).

Deferred to Stage 3 (session-start gating): retiring the legacy FastAPI
`/daily-log` patient workflow (`app/templates/dashboard.html`'s "Log Today's
Session" CTAs and the `/daily-log` GET+POST routes in `app/main.py`) — this
is the point where a real gate is enforced, so it's also the natural point
to close the parallel ungated path.

## Milestone 3 — Session Response & Completion

Durable, server-side ownership of what Milestone 2 currently only tracks
locally, plus the clinical-response collection Milestone 2 explicitly does
not perform.

- Durable real session persistence / data contract (replacing the
  `localStorage`-only `ActiveSessionState` as the source of truth)
- Prescription snapshot persistence, server-side
- Per-set completed/skipped performance persistence
- Structured problem-report persistence
- Early-session-ending persistence
- Peak Achilles pain during session
- Required Too Easy / About Right / Too Hard
- Pain-limiting follow-up (Milestone 2 already records that a pain-limiting
  report occurred and exposes `hasPainLimitingReport()`; Milestone 3 owns
  asking about it, once, at session completion)
- Safety escalation workflow (absolute 8–10 trigger, personalized
  abnormal-pain trigger, structured concerning-feature questions)
- Final session submission
- Correction of the vestigial `sessions` table / `daily_logs.session_id`
  architecture (currently mislabeled as storing `plan_id`, not a real
  workout/session identifier) — the real prescription/session-instance
  identifier that must replace Milestone 2's `prescriptionInstanceKey`
  stand-in (see `web/lib/activeSession.ts`) belongs here

## Blocking Before Milestone 4

- **Legacy zero-default rule-engine cleanup — DONE**, with one open decision
  below. Fixed: `daily_logs.pain_after`/`next_day_pain`/`morning_stiffness`
  are now nullable (were `NOT NULL`, structurally forcing 0 for unanswered
  delayed responses) with existing rows conservatively backfilled to NULL
  wherever their follow-up was provably never completed; `daily_log_post`'s
  INSERT and Form defaults no longer fabricate 0; `classify_irritability` /
  `update_irritability_from_log` / `run_decision_engine` / `_check_pain_trend`
  / `evaluate_session_tolerance` / `evaluate_exercise_progression` all treat
  missing delayed-response data as genuinely unknown (never 0), and a new
  `insufficient_data` signal prevents a favorable GO/PROGRESS result from
  being fabricated out of incomplete data. `daily_log.html` updated to
  render that state honestly instead of crashing or mislabeling it.

  **Open product decision (not made here):** `run_decision_engine`'s stage-
  progression assessment is only ever invoked from `daily_log_post`, at the
  moment a session is first logged — the exact moment pain_after/next_day_pain
  are, by construction, never yet known. With the zero-fabrication bug fixed,
  that call now correctly always defers (STAY, "awaiting next-morning
  follow-up") rather than progressing on fake data — but nothing currently
  re-runs it once the follow-up actually completes (`followup_post` already
  re-evaluates `irritability` alone post-completion; it does not re-invoke
  `run_decision_engine`). Net effect: stage progression via this path is now
  dormant rather than unsafe. Deciding whether/how to re-trigger it (e.g.
  extending `followup_post`'s existing post-completion re-evaluation to also
  call `run_decision_engine`) is a workflow decision for Milestone 4, not
  something invented here.

## Milestone 4 — Delayed Response

- Next-morning Achilles pain
- Next-morning stiffness
- Morning check-in / reminder
- Missing-response handling
- Delayed response completion workflow

## Later Phases — Uncommitted to a Milestone Yet

- Clinician prescription controls (exercise selection, sets/reps/load/tempo/
  rest overrides, equipment/accessibility adaptations)
- Clinician visibility into completed/skipped sets and session events
- Decision on whether skipped sets ever require a reason — options on the
  table: never required, optional, requested only after repeated skipping,
  requested only in clinically meaningful contexts, or summarized once at
  session completion. Milestone 2 deliberately did not make this call; the
  data model (`SetOutcome`) is designed to carry an optional reason later
  without a breaking change.
- Exercise start/finish position images
- Exercise videos
- Automated exercise substitution (canonical metadata partially exists —
  `unilateral_or_bilateral`, `target_tissue`, `required_equipment`,
  `max_load_potential`, `difficulty_level`, `progression_options`/
  `regression_options` — but `knee_position`, `weight_bearing_status`, and
  `movement_complexity` as explicit fields do not)
- Canonical-library metadata expansion (the fields above, plus whatever a
  real substitution engine ends up needing)
- Retirement/migration of the legacy `app/data/exercises.py` source (a
  second, thinner exercise data path still imported by
  `app/engine/rules.py`, independent of the canonical `exercises` table/
  `exercise_library.json` that Milestones 1 and 2 exclusively use)

---

## Closed milestones (for reference — see git history for detail)

- **Milestone 1 — Today's Rehab Foundation**: merged `v9.3.5.5` (PR #6).
- **Milestone 2 — Active Rehab Session**: merged `v9.3.5.6` (PR #7),
  including the founder-acceptance correction pass. Approved and closed.
