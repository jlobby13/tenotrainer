# TenoTrainer Roadmap / Backlog

Living record of work intentionally deferred out of a closed milestone. Items
here are scoped decisions, not just ideas — each was explicitly considered
and placed here rather than folded into the milestone that raised it.

---

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
