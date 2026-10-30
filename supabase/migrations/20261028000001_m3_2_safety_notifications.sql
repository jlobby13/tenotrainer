-- =============================================================================
-- M3.2 — durable clinician safety notifications (in-app + email outbox).
-- Forward-only; no applied migration is edited.
--
-- Notifications REPORT authoritative safety state; they never create or
-- decide it. acute_episode_review_state() (M1) remains the ONLY derivation
-- of effective level, Level-4 reasons, professional hold, requires-clinician-
-- release and released: this migration maps its output to a notification
-- tier and never re-derives any of it (no recurrence window, no 48-hour
-- interval, no blocked-opportunity threshold appears here).
--
--   Episode tiers (one logical event per (episode, tier); upward only; the
--   highest CURRENT tier is created on first detection, lower tiers are not
--   back-filled):
--     safety_review            — ordinary Level 3; in-app only
--     clinician_review         — requires clinician release (effective
--                                Level >= 4 or professionally held); in-app
--                                + email
--     urgent_clinician_review  — effective Level 5; in-app + email
--
--   Acute-stop notice (founder D6): a SEPARATE, non-classifying, in-app-only
--   notice while an acute Stop's safety facts are recorded but the check-in
--   that classifies them is outstanding. It assigns no level, creates no
--   episode, sets no release requirement and sends no email. It resolves
--   when the check-in is submitted and is linked to the classified episode
--   event that replaces it.
--
-- Atomicity / isolation: AFTER-row triggers on the authoritative safety
-- tables create the notification in the SAME transaction as the safety
-- transition, inside an exception block — a notifier failure is recorded
-- as an operational alert and can never roll back the safety write (nor
-- leave reconcile_missing_acute_episodes stuck). safety_notifications_sweep()
-- (pg_cron, every minute) is the repair and time-based mechanism: orphan
-- L3/L5 facts (via the existing reconcile function), the >48 h escalation
-- (a pure time derivation with no write to hook), missing events / notices,
-- late recipients, stalled urgent delivery.
--
-- Recipients (hybrid snapshot): resolved in the database at creation and
-- stored as immutable responsibility history; eligibility is re-checked
-- (clinician_patient_access) at every delivery attempt and inbox read; new
-- eligible clinicians are added while the subject is open (late_assignment).
-- Fallback when no clinician is assigned: clinician_admins of the patient's
-- single organization; ambiguous / missing organization fails closed.
--
-- Email: a durable outbox written in the safety transaction; delivery is a
-- separate, retryable, leased, idempotent dispatch (server-only RPCs). No
-- provider call ever happens in a clinical transaction. Status names never
-- claim delivery or reading: provider_accepted is only provider acceptance.
--
-- Maintenance (founder D1): the database is mode-unaware by design; the
-- sweep, notification/outbox creation and dispatch bookkeeping are an
-- explicit, narrow operational exception. No clinical function changes.
--
-- Scheduling (founder D4): pg_cron runs the DATABASE sweep only. No HTTP
-- dispatch schedule, URL or secret is encoded here (M3.4).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Episode notification events
-- -----------------------------------------------------------------------------
CREATE TABLE safety_notification_events (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  acute_safety_episode_id UUID NOT NULL REFERENCES acute_safety_episodes(id),
  patient_id              UUID NOT NULL REFERENCES auth.users(id),
  tier                    TEXT NOT NULL CHECK (tier IN ('safety_review', 'clinician_review', 'urgent_clinician_review')),
  email_required          BOOLEAN NOT NULL,
  -- Snapshot of the authoritative review state at detection (secondary
  -- provenance; the UI leads with process language, never the number).
  effective_level         SMALLINT NOT NULL CHECK (effective_level IN (3, 4, 5)),
  review_reasons          TEXT[] NOT NULL DEFAULT '{}',
  professionally_held     BOOLEAN NOT NULL,
  episode_confirmed_at    TIMESTAMPTZ NOT NULL,
  organization_id         UUID NULL REFERENCES organizations(id),
  recipient_resolution    TEXT NOT NULL CHECK (recipient_resolution IN (
    'assigned_clinicians', 'fallback_clinician_admins',
    'failed_no_patient_organization', 'failed_ambiguous_patient_organization', 'no_eligible_recipients'
  )),
  detected_by             TEXT NOT NULL CHECK (detected_by IN ('transition', 'sweep')),
  detected_at             TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  superseded_by_event_id  UUID NULL REFERENCES safety_notification_events(id),
  resolved_at             TIMESTAMPTZ NULL,

  CONSTRAINT safety_notification_events_episode_tier_key UNIQUE (acute_safety_episode_id, tier),
  CONSTRAINT safety_notification_events_email_by_tier CHECK (email_required = (tier <> 'safety_review')),
  CONSTRAINT safety_notification_events_tier_consistency CHECK (
    (tier = 'urgent_clinician_review') = (effective_level = 5)
    AND (tier <> 'safety_review' OR (effective_level = 3 AND NOT professionally_held))
    AND (tier <> 'clinician_review' OR effective_level = 4 OR professionally_held)
  ),
  CONSTRAINT safety_notification_events_not_self_superseded CHECK (superseded_by_event_id IS DISTINCT FROM id)
);
CREATE INDEX idx_safety_notification_events_patient_open ON safety_notification_events (patient_id) WHERE resolved_at IS NULL;

COMMENT ON TABLE safety_notification_events IS
  'M3.2: one logical clinician notification per (acute safety episode, tier). Reports the authoritative acute_episode_review_state(); never decides it. Immutable except resolved_at (episode released) and superseded_by_event_id (a higher tier was detected), each set once.';

-- -----------------------------------------------------------------------------
-- 2. Acute-stop outstanding-check-in notices (non-classifying, founder D6)
-- -----------------------------------------------------------------------------
CREATE TABLE safety_acute_stop_notices (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_immediate_response_id UUID NOT NULL UNIQUE REFERENCES session_immediate_responses(id),
  rehab_session_id              UUID NOT NULL UNIQUE REFERENCES rehab_sessions(id),
  patient_id                    UUID NOT NULL REFERENCES auth.users(id),
  organization_id               UUID NULL REFERENCES organizations(id),
  recipient_resolution          TEXT NOT NULL CHECK (recipient_resolution IN (
    'assigned_clinicians', 'fallback_clinician_admins',
    'failed_no_patient_organization', 'failed_ambiguous_patient_organization', 'no_eligible_recipients'
  )),
  detected_by                   TEXT NOT NULL CHECK (detected_by IN ('transition', 'sweep')),
  detected_at                   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  resolved_at                   TIMESTAMPTZ NULL,
  resolution                    TEXT NULL CHECK (resolution IN ('check_in_submitted')),
  superseded_by_event_id        UUID NULL REFERENCES safety_notification_events(id),

  CONSTRAINT safety_acute_stop_notices_resolution_consistency CHECK ((resolved_at IS NULL) = (resolution IS NULL)),
  CONSTRAINT safety_acute_stop_notices_superseded_implies_resolved CHECK (superseded_by_event_id IS NULL OR resolved_at IS NOT NULL)
);
CREATE INDEX idx_safety_acute_stop_notices_patient_open ON safety_acute_stop_notices (patient_id) WHERE resolved_at IS NULL;

COMMENT ON TABLE safety_acute_stop_notices IS
  'M3.2 (D6): in-app-only, NON-classifying clinician notice — an acute Stop recorded safety facts and the check-in that classifies them is outstanding. Assigns no level, creates no episode, never requires release, never emails. Resolved (check_in_submitted) when the check-in is submitted; superseded_by_event_id links the classified episode event that replaces it.';

-- -----------------------------------------------------------------------------
-- 3. Recipients — immutable responsibility history (read_at set once)
-- -----------------------------------------------------------------------------
CREATE TABLE safety_notification_recipients (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              UUID NULL REFERENCES safety_notification_events(id),
  acute_stop_notice_id  UUID NULL REFERENCES safety_acute_stop_notices(id),
  recipient_user_id     UUID NOT NULL REFERENCES auth.users(id),
  organization_id       UUID NOT NULL REFERENCES organizations(id),
  basis                 TEXT NOT NULL CHECK (basis IN ('assigned_clinician', 'fallback_clinician_admin', 'late_assignment')),
  supervisor_patient_id UUID NULL REFERENCES supervisor_patients(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  read_at               TIMESTAMPTZ NULL,

  CONSTRAINT safety_notification_recipients_one_subject CHECK (num_nonnulls(event_id, acute_stop_notice_id) = 1),
  CONSTRAINT safety_notification_recipients_basis_provenance CHECK ((basis = 'fallback_clinician_admin') = (supervisor_patient_id IS NULL)),
  CONSTRAINT safety_notification_recipients_read_after_created CHECK (read_at IS NULL OR read_at >= created_at)
);
CREATE UNIQUE INDEX safety_notification_recipients_event_user ON safety_notification_recipients (event_id, recipient_user_id) WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX safety_notification_recipients_notice_user ON safety_notification_recipients (acute_stop_notice_id, recipient_user_id) WHERE acute_stop_notice_id IS NOT NULL;
CREATE INDEX idx_safety_notification_recipients_user ON safety_notification_recipients (recipient_user_id, created_at DESC);

COMMENT ON TABLE safety_notification_recipients IS
  'M3.2: who was notified and why (assigned_clinician | fallback_clinician_admin | late_assignment), with the assignment period. Permanent history: never deleted or reassigned. Visibility and email are re-checked against current authority (safety_notif_recipient_eligible); a former clinician''s row stays as history but is hidden and never emailed. read_at = the recipient opened it — never clinical review or release.';

-- -----------------------------------------------------------------------------
-- 4. Email outbox + append-only attempts + audited requeues
-- -----------------------------------------------------------------------------
CREATE TABLE safety_email_outbox (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id          UUID NOT NULL UNIQUE REFERENCES safety_notification_recipients(id),
  event_id              UUID NOT NULL REFERENCES safety_notification_events(id),
  tier                  TEXT NOT NULL CHECK (tier IN ('clinician_review', 'urgent_clinician_review')),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'claimed', 'provider_accepted', 'retry_scheduled', 'failed_permanent',
    'suppressed_episode_released', 'suppressed_recipient_ineligible'
  )),
  generation            SMALLINT NOT NULL DEFAULT 1 CHECK (generation >= 1),
  idempotency_key       TEXT NOT NULL UNIQUE,
  attempt_count         SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  next_attempt_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  claim_token           UUID NULL,
  claimed_until         TIMESTAMPTZ NULL,
  provider_message_id   TEXT NULL CHECK (provider_message_id IS NULL OR char_length(provider_message_id) BETWEEN 1 AND 200),
  last_error_code       TEXT NULL CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  provider_accepted_at  TIMESTAMPTZ NULL,
  terminal_at           TIMESTAMPTZ NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT safety_email_outbox_claim_consistency CHECK ((status = 'claimed') = (claim_token IS NOT NULL AND claimed_until IS NOT NULL)),
  CONSTRAINT safety_email_outbox_accepted_consistency CHECK ((status = 'provider_accepted') = (provider_accepted_at IS NOT NULL AND provider_message_id IS NOT NULL)),
  CONSTRAINT safety_email_outbox_terminal_consistency CHECK (
    (status IN ('provider_accepted', 'failed_permanent', 'suppressed_episode_released', 'suppressed_recipient_ineligible')) = (terminal_at IS NOT NULL)
  )
);
CREATE INDEX idx_safety_email_outbox_due ON safety_email_outbox (next_attempt_at) WHERE status IN ('pending', 'retry_scheduled');
CREATE INDEX idx_safety_email_outbox_leases ON safety_email_outbox (claimed_until) WHERE status = 'claimed';
CREATE INDEX idx_safety_email_outbox_event ON safety_email_outbox (event_id);

COMMENT ON TABLE safety_email_outbox IS
  'M3.2: one safety email intent per email-required recipient. provider_accepted means ONLY that the provider accepted the request (not inbox delivery, not reading). idempotency_key is stable for every attempt of one generation; an audited requeue starts a new generation. last_error_code is a code, never provider text or PHI.';

CREATE TABLE safety_email_attempts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id           UUID NOT NULL REFERENCES safety_email_outbox(id),
  generation          SMALLINT NOT NULL,
  attempt_no          SMALLINT NOT NULL CHECK (attempt_no BETWEEN 1 AND 8),
  claim_token         UUID NOT NULL UNIQUE,
  idempotency_key     TEXT NOT NULL,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  finished_at         TIMESTAMPTZ NULL,
  outcome             TEXT NULL CHECK (outcome IN (
    'provider_accepted', 'rejected_permanent', 'transient_error', 'timeout_ambiguous', 'abandoned_lease_expired'
  )),
  late_result         BOOLEAN NOT NULL DEFAULT false,
  http_status         SMALLINT NULL,
  provider_message_id TEXT NULL CHECK (provider_message_id IS NULL OR char_length(provider_message_id) BETWEEN 1 AND 200),
  error_code          TEXT NULL CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'),

  CONSTRAINT safety_email_attempts_number_key UNIQUE (outbox_id, generation, attempt_no),
  CONSTRAINT safety_email_attempts_finish_consistency CHECK ((finished_at IS NULL) = (outcome IS NULL))
);

COMMENT ON TABLE safety_email_attempts IS
  'M3.2: append-only provider attempt log. An attempt whose lease expired is closed as abandoned_lease_expired; a provider acceptance that arrives later is still recorded (late_result) because acceptance is evidence.';

CREATE TABLE safety_email_requeues (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id           UUID NOT NULL REFERENCES safety_email_outbox(id),
  requested_by        UUID NOT NULL REFERENCES auth.users(id),
  reason              TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  previous_status     TEXT NOT NULL,
  previous_generation SMALLINT NOT NULL,
  new_generation      SMALLINT NOT NULL,
  requeued_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- -----------------------------------------------------------------------------
-- 5. Operational alerts + heartbeats (founder D7: durable facts; no
--    external destination in M3.2)
-- -----------------------------------------------------------------------------
CREATE TABLE safety_notification_alerts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              TEXT NOT NULL CHECK (kind IN (
    'notification_hook_failed', 'recipient_resolution_failed', 'no_eligible_recipients',
    'urgent_delivery_stalled', 'delivery_failed_permanent', 'reconcile_failed',
    'orphan_fact_reconciled', 'sweep_step_failed'
  )),
  subject_key       TEXT NOT NULL CHECK (subject_key ~ '^[a-z_]+:[0-9a-z_-]+$'),
  detail_code       TEXT NULL CHECK (detail_code IS NULL OR detail_code ~ '^[A-Za-z0-9_]{1,64}$'),
  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_detected_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  occurrences       INTEGER NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  cleared_at        TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX safety_notification_alerts_one_open ON safety_notification_alerts (kind, subject_key) WHERE cleared_at IS NULL;

COMMENT ON TABLE safety_notification_alerts IS
  'M3.2: durable operational alert facts (codes and ids only, never PHI). One open row per (kind, subject); cleared by the mechanism that resolves the condition. orphan_fact_reconciled is historical (recorded already cleared).';

CREATE TABLE safety_notification_heartbeats (
  component         TEXT PRIMARY KEY CHECK (component IN ('sweep', 'dispatch')),
  last_started_at   TIMESTAMPTZ NULL,
  last_succeeded_at TIMESTAMPTZ NULL,
  last_failed_at    TIMESTAMPTZ NULL,
  last_error_code   TEXT NULL CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Za-z0-9_]{1,64}$'),
  last_summary      JSONB NULL
);
INSERT INTO safety_notification_heartbeats (component) VALUES ('sweep'), ('dispatch');

-- -----------------------------------------------------------------------------
-- 6. Immutability guards (history never deleted or rewritten)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_m32_safety_history_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SAFETY_NOTIFICATION_HISTORY_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF TG_TABLE_NAME = 'safety_notification_events' THEN
    IF (to_jsonb(NEW) - 'resolved_at' - 'superseded_by_event_id') IS DISTINCT FROM (to_jsonb(OLD) - 'resolved_at' - 'superseded_by_event_id')
       OR (OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS DISTINCT FROM OLD.resolved_at)
       OR (OLD.superseded_by_event_id IS NOT NULL AND NEW.superseded_by_event_id IS DISTINCT FROM OLD.superseded_by_event_id) THEN
      RAISE EXCEPTION 'SAFETY_NOTIFICATION_HISTORY_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
  ELSIF TG_TABLE_NAME = 'safety_acute_stop_notices' THEN
    IF (to_jsonb(NEW) - 'resolved_at' - 'resolution' - 'superseded_by_event_id') IS DISTINCT FROM (to_jsonb(OLD) - 'resolved_at' - 'resolution' - 'superseded_by_event_id')
       OR (OLD.resolved_at IS NOT NULL AND (NEW.resolved_at IS DISTINCT FROM OLD.resolved_at OR NEW.resolution IS DISTINCT FROM OLD.resolution))
       OR (OLD.superseded_by_event_id IS NOT NULL AND NEW.superseded_by_event_id IS DISTINCT FROM OLD.superseded_by_event_id) THEN
      RAISE EXCEPTION 'SAFETY_NOTIFICATION_HISTORY_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
  ELSIF TG_TABLE_NAME = 'safety_notification_recipients' THEN
    IF (to_jsonb(NEW) - 'read_at') IS DISTINCT FROM (to_jsonb(OLD) - 'read_at')
       OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) THEN
      RAISE EXCEPTION 'SAFETY_NOTIFICATION_HISTORY_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
  ELSIF TG_TABLE_NAME = 'safety_email_attempts' THEN
    -- Finish once; the only later change is a late provider acceptance on
    -- an attempt closed as abandoned_lease_expired.
    IF (to_jsonb(NEW) - 'finished_at' - 'outcome' - 'late_result' - 'http_status' - 'provider_message_id' - 'error_code')
         IS DISTINCT FROM (to_jsonb(OLD) - 'finished_at' - 'outcome' - 'late_result' - 'http_status' - 'provider_message_id' - 'error_code')
       OR (OLD.finished_at IS NOT NULL AND NOT (OLD.outcome = 'abandoned_lease_expired' AND NEW.outcome = 'provider_accepted' AND NEW.late_result)) THEN
      RAISE EXCEPTION 'SAFETY_NOTIFICATION_HISTORY_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
  ELSIF TG_TABLE_NAME = 'safety_email_requeues' THEN
    RAISE EXCEPTION 'SAFETY_NOTIFICATION_HISTORY_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_m32_safety_notification_events_guard BEFORE UPDATE OR DELETE ON safety_notification_events
  FOR EACH ROW EXECUTE FUNCTION trg_m32_safety_history_guard();
CREATE TRIGGER trg_m32_safety_acute_stop_notices_guard BEFORE UPDATE OR DELETE ON safety_acute_stop_notices
  FOR EACH ROW EXECUTE FUNCTION trg_m32_safety_history_guard();
CREATE TRIGGER trg_m32_safety_notification_recipients_guard BEFORE UPDATE OR DELETE ON safety_notification_recipients
  FOR EACH ROW EXECUTE FUNCTION trg_m32_safety_history_guard();
CREATE TRIGGER trg_m32_safety_email_attempts_guard BEFORE UPDATE OR DELETE ON safety_email_attempts
  FOR EACH ROW EXECUTE FUNCTION trg_m32_safety_history_guard();
CREATE TRIGGER trg_m32_safety_email_requeues_guard BEFORE UPDATE OR DELETE ON safety_email_requeues
  FOR EACH ROW EXECUTE FUNCTION trg_m32_safety_history_guard();
CREATE TRIGGER trg_m32_safety_email_outbox_no_delete BEFORE DELETE ON safety_email_outbox
  FOR EACH ROW EXECUTE FUNCTION trg_m32_safety_history_guard();

-- -----------------------------------------------------------------------------
-- 7. Operational helpers
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION safety_notif_raise_alert(p_kind TEXT, p_subject TEXT, p_code TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO safety_notification_alerts (kind, subject_key, detail_code)
  VALUES (p_kind, p_subject, p_code)
  ON CONFLICT (kind, subject_key) WHERE cleared_at IS NULL
  DO UPDATE SET last_detected_at = clock_timestamp(),
                occurrences = safety_notification_alerts.occurrences + 1,
                detail_code = EXCLUDED.detail_code;
  -- Structured operational log line (codes and ids only).
  RAISE LOG 'tenotrainer.safety_alert kind=% subject=% code=%', p_kind, p_subject, coalesce(p_code, '-');
END;
$$;

CREATE OR REPLACE FUNCTION safety_notif_clear_alert(p_kind TEXT, p_subject TEXT)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE safety_notification_alerts SET cleared_at = clock_timestamp()
  WHERE kind = p_kind AND subject_key = p_subject AND cleared_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION safety_notif_tier_rank(p_tier TEXT)
RETURNS INT LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE p_tier WHEN 'safety_review' THEN 1 WHEN 'clinician_review' THEN 2 WHEN 'urgent_clinician_review' THEN 3 END;
$$;

-- -----------------------------------------------------------------------------
-- 8. Recipient resolution and eligibility
-- -----------------------------------------------------------------------------
-- Primary: every ACTIVE assignment whose clinician holds a clinician /
-- clinician_admin role in the assignment's organization — exactly the
-- clinician_patient_access() predicate (M2). Fallback (no primary): the
-- clinician_admins of the patient's SINGLE patient-role organization.
-- Zero or several patient organizations fail closed (no recipient, no
-- cross-organization guess).
CREATE OR REPLACE FUNCTION safety_notif_resolve_recipients(
  p_patient_id UUID, OUT o_resolution TEXT, OUT o_organization_id UUID, OUT o_recipients JSONB)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_orgs UUID[];
BEGIN
  SELECT array_agg(DISTINCT m.organization_id) INTO v_orgs
  FROM organization_members m WHERE m.user_id = p_patient_id AND m.role IN ('member', 'tester');
  IF coalesce(array_length(v_orgs, 1), 0) = 1 THEN o_organization_id := v_orgs[1]; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'user_id', r.supervisor_id, 'organization_id', r.organization_id,
           'basis', 'assigned_clinician', 'supervisor_patient_id', r.id) ORDER BY r.supervisor_id), '[]'::jsonb)
    INTO o_recipients
  FROM (
    SELECT DISTINCT ON (sp.supervisor_id) sp.supervisor_id, sp.organization_id, sp.id
    FROM supervisor_patients sp
    JOIN organization_members m ON m.user_id = sp.supervisor_id AND m.organization_id = sp.organization_id
    WHERE sp.patient_id = p_patient_id AND sp.status = 'active' AND m.role IN ('clinician', 'clinician_admin')
    ORDER BY sp.supervisor_id, sp.assigned_at, sp.id
  ) r;
  IF jsonb_array_length(o_recipients) > 0 THEN
    o_resolution := 'assigned_clinicians';
    RETURN;
  END IF;

  IF coalesce(array_length(v_orgs, 1), 0) = 0 THEN
    o_resolution := 'failed_no_patient_organization';
    RETURN;
  END IF;
  IF array_length(v_orgs, 1) > 1 THEN
    o_resolution := 'failed_ambiguous_patient_organization';
    RETURN;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'user_id', m.user_id, 'organization_id', m.organization_id,
           'basis', 'fallback_clinician_admin', 'supervisor_patient_id', NULL) ORDER BY m.user_id), '[]'::jsonb)
    INTO o_recipients
  FROM organization_members m
  WHERE m.organization_id = o_organization_id AND m.role = 'clinician_admin' AND m.user_id <> p_patient_id;
  o_resolution := CASE WHEN jsonb_array_length(o_recipients) > 0 THEN 'fallback_clinician_admins' ELSE 'no_eligible_recipients' END;
END;
$$;

-- Current authority of a recipient over the notification's patient (the
-- historical row never grants anything by itself).
CREATE OR REPLACE FUNCTION safety_notif_recipient_eligible(p_recipient_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r safety_notification_recipients;
  v_patient UUID;
BEGIN
  SELECT * INTO v_r FROM safety_notification_recipients WHERE id = p_recipient_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_r.event_id IS NOT NULL THEN
    SELECT patient_id INTO v_patient FROM safety_notification_events WHERE id = v_r.event_id;
  ELSE
    SELECT patient_id INTO v_patient FROM safety_acute_stop_notices WHERE id = v_r.acute_stop_notice_id;
  END IF;
  IF v_r.basis IN ('assigned_clinician', 'late_assignment') THEN
    RETURN clinician_patient_access(v_r.recipient_user_id, v_patient);
  END IF;
  RETURN EXISTS (SELECT 1 FROM organization_members m
                 WHERE m.user_id = v_r.recipient_user_id AND m.organization_id = v_r.organization_id AND m.role = 'clinician_admin')
     AND EXISTS (SELECT 1 FROM organization_members m
                 WHERE m.user_id = v_patient AND m.organization_id = v_r.organization_id AND m.role IN ('member', 'tester'));
END;
$$;

-- Inserts recipient rows (+ outbox rows for an email-required event).
-- p_late: an assigned clinician added after creation is recorded as
-- late_assignment. Idempotent (unique per subject and user).
CREATE OR REPLACE FUNCTION safety_notif_insert_recipients(p_event_id UUID, p_notice_id UUID, p_recipients JSONB, p_late BOOLEAN)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rec RECORD;
  v_rid UUID;
  v_email BOOLEAN := false;
  v_tier TEXT;
  v_n INT := 0;
  v_outbox UUID;
BEGIN
  IF p_event_id IS NOT NULL THEN
    SELECT email_required, tier INTO v_email, v_tier FROM safety_notification_events WHERE id = p_event_id;
  END IF;
  FOR v_rec IN SELECT * FROM jsonb_to_recordset(coalesce(p_recipients, '[]'::jsonb))
                 AS x(user_id UUID, organization_id UUID, basis TEXT, supervisor_patient_id UUID) LOOP
    v_rid := NULL;
    INSERT INTO safety_notification_recipients (event_id, acute_stop_notice_id, recipient_user_id, organization_id, basis, supervisor_patient_id)
    VALUES (p_event_id, p_notice_id, v_rec.user_id, v_rec.organization_id,
            CASE WHEN p_late AND v_rec.basis = 'assigned_clinician' THEN 'late_assignment' ELSE v_rec.basis END,
            v_rec.supervisor_patient_id)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_rid;
    IF v_rid IS NOT NULL THEN
      v_n := v_n + 1;
      IF v_email THEN
        v_outbox := gen_random_uuid();
        INSERT INTO safety_email_outbox (id, recipient_id, event_id, tier, idempotency_key)
        VALUES (v_outbox, v_rid, p_event_id, v_tier, 'tenotrainer-safety-email/' || v_outbox::text || '/g1');
      END IF;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;

-- -----------------------------------------------------------------------------
-- 9. The episode evaluator — maps acute_episode_review_state() (the ONLY
--    authority) to a notification tier. Idempotent; upward only.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION safety_notif_evaluate_episode(p_episode_id UUID, p_source TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_state RECORD;
  v_tier TEXT;
  v_existing_rank INT;
  v_res RECORD;
  v_event_id UUID;
  v_source_session UUID;
BEGIN
  -- Serializes concurrent evaluators of one episode (trigger vs sweep)
  -- without touching any clinical row lock.
  PERFORM pg_advisory_xact_lock(hashtext('m32_safety_episode'), hashtext(p_episode_id::text));

  SELECT * INTO v_state FROM acute_episode_review_state(p_episode_id);
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF v_state.released THEN
    UPDATE safety_notification_events SET resolved_at = clock_timestamp()
    WHERE acute_safety_episode_id = p_episode_id AND resolved_at IS NULL;
    UPDATE safety_email_outbox o
       SET status = 'suppressed_episode_released', terminal_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE o.status IN ('pending', 'retry_scheduled')
       AND o.event_id IN (SELECT e.id FROM safety_notification_events e WHERE e.acute_safety_episode_id = p_episode_id);
    PERFORM safety_notif_clear_alert('notification_hook_failed', 'episode:' || p_episode_id::text);
    RETURN NULL;
  END IF;

  -- Mapping of the authoritative output only.
  v_tier := CASE
    WHEN v_state.effective_level >= 5 THEN 'urgent_clinician_review'
    WHEN v_state.requires_clinician_release THEN 'clinician_review'
    ELSE 'safety_review' END;

  SELECT max(safety_notif_tier_rank(e.tier)) INTO v_existing_rank
  FROM safety_notification_events e WHERE e.acute_safety_episode_id = p_episode_id;
  IF v_existing_rank IS NOT NULL AND v_existing_rank >= safety_notif_tier_rank(v_tier) THEN
    PERFORM safety_notif_clear_alert('notification_hook_failed', 'episode:' || p_episode_id::text);
    RETURN NULL;
  END IF;

  SELECT * INTO v_res FROM safety_notif_resolve_recipients(v_state.user_id);

  INSERT INTO safety_notification_events (
    acute_safety_episode_id, patient_id, tier, email_required, effective_level, review_reasons,
    professionally_held, episode_confirmed_at, organization_id, recipient_resolution, detected_by)
  VALUES (
    p_episode_id, v_state.user_id, v_tier, v_tier <> 'safety_review', v_state.effective_level,
    v_state.level4_reasons || CASE WHEN v_state.professionally_held THEN ARRAY['professional_hold'] ELSE '{}'::TEXT[] END,
    v_state.professionally_held, v_state.confirmed_at, v_res.o_organization_id, v_res.o_resolution, p_source)
  ON CONFLICT (acute_safety_episode_id, tier) DO NOTHING
  RETURNING id INTO v_event_id;
  IF v_event_id IS NULL THEN RETURN NULL; END IF;

  UPDATE safety_notification_events SET superseded_by_event_id = v_event_id
  WHERE acute_safety_episode_id = p_episode_id AND id <> v_event_id AND superseded_by_event_id IS NULL;

  PERFORM safety_notif_insert_recipients(v_event_id, NULL, v_res.o_recipients, false);

  -- The acute-stop notice for this episode's source session is replaced by
  -- the classified event (the check-in has necessarily been submitted: an
  -- episode exists only from a submitted evaluation).
  SELECT source_rehab_session_id INTO v_source_session FROM acute_safety_episodes WHERE id = p_episode_id;
  UPDATE safety_acute_stop_notices
     SET resolved_at = coalesce(resolved_at, clock_timestamp()),
         resolution = coalesce(resolution, 'check_in_submitted'),
         superseded_by_event_id = v_event_id
   WHERE rehab_session_id = v_source_session AND superseded_by_event_id IS NULL;

  IF v_res.o_resolution LIKE 'failed_%' THEN
    PERFORM safety_notif_raise_alert('recipient_resolution_failed', 'event:' || v_event_id::text, v_res.o_resolution);
  ELSIF v_res.o_resolution = 'no_eligible_recipients' THEN
    PERFORM safety_notif_raise_alert('no_eligible_recipients', 'event:' || v_event_id::text, v_res.o_resolution);
  END IF;
  PERFORM safety_notif_clear_alert('notification_hook_failed', 'episode:' || p_episode_id::text);
  RETURN v_event_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 10. Acute-stop notice (D6) — open / resolve. Reads the C5.6C Stop-sheet
--     pre-fill as recorded; never classifies.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION safety_notif_sync_acute_stop_notice(p_response_id UUID, p_source TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sir session_immediate_responses;
  v_status TEXT;
  v_res RECORD;
  v_notice UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('m32_safety_acute_stop'), hashtext(p_response_id::text));
  SELECT * INTO v_sir FROM session_immediate_responses WHERE id = p_response_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF v_sir.resolved_at IS NOT NULL THEN
    UPDATE safety_acute_stop_notices
       SET resolved_at = clock_timestamp(), resolution = 'check_in_submitted'
     WHERE session_immediate_response_id = p_response_id AND resolved_at IS NULL;
    PERFORM safety_notif_clear_alert('notification_hook_failed', 'immediate_response:' || p_response_id::text);
    RETURN NULL;
  END IF;

  SELECT training_status INTO v_status FROM rehab_sessions WHERE id = v_sir.rehab_session_id;
  IF v_status IS DISTINCT FROM 'stopped_acute'
     OR NOT (v_sir.sudden_or_sharp_pain IS TRUE OR v_sir.pop_felt_or_heard IS TRUE OR v_sir.new_functional_difficulty IS TRUE) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_res FROM safety_notif_resolve_recipients(v_sir.user_id);
  INSERT INTO safety_acute_stop_notices (session_immediate_response_id, rehab_session_id, patient_id, organization_id, recipient_resolution, detected_by)
  VALUES (p_response_id, v_sir.rehab_session_id, v_sir.user_id, v_res.o_organization_id, v_res.o_resolution, p_source)
  ON CONFLICT (session_immediate_response_id) DO NOTHING
  RETURNING id INTO v_notice;
  IF v_notice IS NOT NULL THEN
    PERFORM safety_notif_insert_recipients(NULL, v_notice, v_res.o_recipients, false);
    IF v_res.o_resolution LIKE 'failed_%' THEN
      PERFORM safety_notif_raise_alert('recipient_resolution_failed', 'notice:' || v_notice::text, v_res.o_resolution);
    ELSIF v_res.o_resolution = 'no_eligible_recipients' THEN
      PERFORM safety_notif_raise_alert('no_eligible_recipients', 'notice:' || v_notice::text, v_res.o_resolution);
    END IF;
  END IF;
  PERFORM safety_notif_clear_alert('notification_hook_failed', 'immediate_response:' || p_response_id::text);
  RETURN v_notice;
END;
$$;

-- -----------------------------------------------------------------------------
-- 11. Late recipients (founder D2) — every newly eligible assigned clinician
--     of an OPEN current event / notice; fallback admins only when the
--     subject has no currently eligible recipient at all.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION safety_notif_add_late_recipients(p_patient_id UUID)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_res RECORD;
  v_subject RECORD;
  v_n INT := 0;
  v_has_eligible BOOLEAN;
BEGIN
  SELECT * INTO v_res FROM safety_notif_resolve_recipients(p_patient_id);
  IF v_res.o_resolution NOT IN ('assigned_clinicians', 'fallback_clinician_admins') THEN RETURN 0; END IF;

  FOR v_subject IN
    SELECT e.id AS event_id, NULL::UUID AS notice_id FROM safety_notification_events e
     WHERE e.patient_id = p_patient_id AND e.resolved_at IS NULL AND e.superseded_by_event_id IS NULL
    UNION ALL
    SELECT NULL::UUID, n.id FROM safety_acute_stop_notices n
     WHERE n.patient_id = p_patient_id AND n.resolved_at IS NULL
  LOOP
    IF v_res.o_resolution = 'fallback_clinician_admins' THEN
      SELECT EXISTS (
        SELECT 1 FROM safety_notification_recipients r
        WHERE (r.event_id = v_subject.event_id OR r.acute_stop_notice_id = v_subject.notice_id)
          AND safety_notif_recipient_eligible(r.id)) INTO v_has_eligible;
      CONTINUE WHEN v_has_eligible;
    END IF;
    v_n := v_n + safety_notif_insert_recipients(v_subject.event_id, v_subject.notice_id, v_res.o_recipients, true);
    IF v_subject.event_id IS NOT NULL THEN
      PERFORM safety_notif_clear_alert('recipient_resolution_failed', 'event:' || v_subject.event_id::text);
      PERFORM safety_notif_clear_alert('no_eligible_recipients', 'event:' || v_subject.event_id::text);
    ELSE
      PERFORM safety_notif_clear_alert('recipient_resolution_failed', 'notice:' || v_subject.notice_id::text);
      PERFORM safety_notif_clear_alert('no_eligible_recipients', 'notice:' || v_subject.notice_id::text);
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;

-- -----------------------------------------------------------------------------
-- 12. Exception-isolated hooks. A notifier failure is recorded and logged
--     and NEVER propagates into the safety transaction. No ASSERT is used
--     in any notifier function (assert_failure is also caught explicitly).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION safety_notif_hook(p_kind TEXT, p_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_state TEXT;
  v_subject TEXT;
BEGIN
  BEGIN
    IF p_kind = 'episode' THEN
      PERFORM safety_notif_evaluate_episode(p_id, 'transition');
    ELSIF p_kind = 'immediate_response' THEN
      PERFORM safety_notif_sync_acute_stop_notice(p_id, 'transition');
    ELSIF p_kind = 'patient' THEN
      PERFORM safety_notif_add_late_recipients(p_id);
    END IF;
  EXCEPTION WHEN OTHERS OR assert_failure THEN
    v_state := SQLSTATE;
    v_subject := p_kind || ':' || p_id::text;
    BEGIN
      PERFORM safety_notif_raise_alert('notification_hook_failed', v_subject, v_state);
      RAISE WARNING 'tenotrainer.safety_notification_hook_failed subject=% sqlstate=% (the sweep repairs it)', v_subject, v_state;
    EXCEPTION WHEN OTHERS OR assert_failure THEN
      RAISE WARNING 'tenotrainer.safety_notification_hook_failed subject=% sqlstate=% (alert not recorded)', v_subject, v_state;
    END;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION trg_m32_notify_episode()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Separate statements: each is planned only for the table it reads.
  IF TG_TABLE_NAME = 'acute_safety_episodes' THEN
    PERFORM safety_notif_hook('episode', NEW.id);
  ELSE
    PERFORM safety_notif_hook('episode', NEW.acute_safety_episode_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION trg_m32_notify_immediate_response()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM safety_notif_hook('immediate_response', NEW.id);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION trg_m32_notify_assignment()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM safety_notif_hook('patient', NEW.patient_id);
  RETURN NULL;
END;
$$;

-- Episode opened (reconcile / legacy confirm), blocked opportunity,
-- reassessment, release: each is a real authoritative write.
CREATE TRIGGER trg_m32_acute_safety_episodes_notify AFTER INSERT ON acute_safety_episodes
  FOR EACH ROW EXECUTE FUNCTION trg_m32_notify_episode();
CREATE TRIGGER trg_m32_blocked_loading_opportunities_notify AFTER INSERT ON blocked_loading_opportunities
  FOR EACH ROW EXECUTE FUNCTION trg_m32_notify_episode();
CREATE TRIGGER trg_m32_acute_safety_reassessments_notify AFTER INSERT ON acute_safety_reassessments
  FOR EACH ROW EXECUTE FUNCTION trg_m32_notify_episode();
CREATE TRIGGER trg_m32_acute_safety_releases_notify AFTER INSERT ON acute_safety_releases
  FOR EACH ROW EXECUTE FUNCTION trg_m32_notify_episode();
-- Acute Stop pre-fill (C5.6C) and check-in submission (C5.6E).
CREATE TRIGGER trg_m32_session_immediate_responses_notify_insert AFTER INSERT ON session_immediate_responses
  FOR EACH ROW WHEN (NEW.resolved_at IS NULL AND (NEW.sudden_or_sharp_pain OR NEW.pop_felt_or_heard OR NEW.new_functional_difficulty))
  EXECUTE FUNCTION trg_m32_notify_immediate_response();
CREATE TRIGGER trg_m32_session_immediate_responses_notify_resolve AFTER UPDATE OF resolved_at ON session_immediate_responses
  FOR EACH ROW WHEN (OLD.resolved_at IS NULL AND NEW.resolved_at IS NOT NULL)
  EXECUTE FUNCTION trg_m32_notify_immediate_response();
-- New assignment period (late recipients).
CREATE TRIGGER trg_m32_supervisor_patients_notify AFTER INSERT ON supervisor_patients
  FOR EACH ROW WHEN (NEW.status = 'active')
  EXECUTE FUNCTION trg_m32_notify_assignment();

-- -----------------------------------------------------------------------------
-- 13. The sweep — repair + time-based detection. Mode-unaware by design
--     (founder D1 operational exception). Each step and item is isolated.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION safety_notifications_sweep()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id UUID;
  v_rec RECORD;
  v_claims TEXT := current_setting('request.jwt.claims', true);
  v_orphans INT := 0; v_reconcile_failed INT := 0;
  v_events INT := 0; v_episode_failed INT := 0;
  v_notices_opened INT := 0; v_notices_resolved INT := 0; v_notice_failed INT := 0;
  v_late INT := 0; v_late_failed INT := 0;
  v_stalled INT := 0;
  v_summary JSONB;
BEGIN
  UPDATE safety_notification_heartbeats SET last_started_at = clock_timestamp() WHERE component = 'sweep';
  IF NOT pg_try_advisory_xact_lock(hashtext('m32_safety_sweep')) THEN
    RETURN jsonb_build_object('result', 'skipped_concurrent_sweep');
  END IF;

  -- (a) Orphan L3/L5 facts (evaluation committed, episode never
  --     reconciled — the C5.6E crash window) via the EXISTING authoritative
  --     reconcile function, on the trusted server's behalf. The grace
  --     period leaves the normal request path to reconcile first.
  FOR v_id IN
    SELECT DISTINCT rs.user_id
    FROM escalation_evaluations ee JOIN rehab_sessions rs ON rs.id = ee.rehab_session_id
    WHERE ee.escalation_level IN (3, 5) AND ee.evaluated_at < clock_timestamp() - INTERVAL '2 minutes'
      AND NOT EXISTS (SELECT 1 FROM acute_safety_episodes a WHERE a.source_escalation_evaluation_id = ee.id)
  LOOP
    BEGIN
      PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
      PERFORM reconcile_missing_acute_episodes(v_id);
      PERFORM set_config('request.jwt.claims', coalesce(v_claims, ''), true);
      v_orphans := v_orphans + 1;
      INSERT INTO safety_notification_alerts (kind, subject_key, detail_code, cleared_at)
      VALUES ('orphan_fact_reconciled', 'patient:' || v_id::text, 'sweep_reconciled', clock_timestamp());
      PERFORM safety_notif_clear_alert('reconcile_failed', 'patient:' || v_id::text);
    EXCEPTION WHEN OTHERS OR assert_failure THEN
      v_reconcile_failed := v_reconcile_failed + 1;
      PERFORM safety_notif_raise_alert('reconcile_failed', 'patient:' || v_id::text, SQLSTATE);
    END;
  END LOOP;
  PERFORM set_config('request.jwt.claims', coalesce(v_claims, ''), true);

  -- (b) Every episode that is open, or released with an unresolved event,
  --     or has an open hook-failure alert: >48 h escalation, missing
  --     events, missed escalations, release resolution.
  FOR v_id IN
    SELECT e.id FROM acute_safety_episodes e
    WHERE NOT EXISTS (SELECT 1 FROM acute_safety_releases r WHERE r.acute_safety_episode_id = e.id)
       OR EXISTS (SELECT 1 FROM safety_notification_events n WHERE n.acute_safety_episode_id = e.id AND n.resolved_at IS NULL)
       OR EXISTS (SELECT 1 FROM safety_notification_alerts a WHERE a.kind = 'notification_hook_failed' AND a.cleared_at IS NULL AND a.subject_key = 'episode:' || e.id::text)
    ORDER BY e.confirmed_at
  LOOP
    BEGIN
      IF safety_notif_evaluate_episode(v_id, 'sweep') IS NOT NULL THEN v_events := v_events + 1; END IF;
    EXCEPTION WHEN OTHERS OR assert_failure THEN
      v_episode_failed := v_episode_failed + 1;
      PERFORM safety_notif_raise_alert('sweep_step_failed', 'episode:' || v_id::text, SQLSTATE);
    END;
  END LOOP;

  -- (c) Acute-stop notices: open the missing ones, resolve the submitted ones.
  FOR v_id IN
    SELECT sir.id FROM session_immediate_responses sir
    JOIN rehab_sessions rs ON rs.id = sir.rehab_session_id
    WHERE sir.resolved_at IS NULL AND rs.training_status = 'stopped_acute'
      AND (sir.sudden_or_sharp_pain IS TRUE OR sir.pop_felt_or_heard IS TRUE OR sir.new_functional_difficulty IS TRUE)
      AND NOT EXISTS (SELECT 1 FROM safety_acute_stop_notices n WHERE n.session_immediate_response_id = sir.id)
    UNION
    SELECT n.session_immediate_response_id FROM safety_acute_stop_notices n
    JOIN session_immediate_responses sir ON sir.id = n.session_immediate_response_id
    WHERE n.resolved_at IS NULL AND sir.resolved_at IS NOT NULL
    UNION
    SELECT sir.id FROM session_immediate_responses sir
    JOIN safety_notification_alerts a ON a.subject_key = 'immediate_response:' || sir.id::text
    WHERE a.kind = 'notification_hook_failed' AND a.cleared_at IS NULL
  LOOP
    BEGIN
      IF safety_notif_sync_acute_stop_notice(v_id, 'sweep') IS NOT NULL THEN
        v_notices_opened := v_notices_opened + 1;
      ELSE
        v_notices_resolved := v_notices_resolved + 1;
      END IF;
    EXCEPTION WHEN OTHERS OR assert_failure THEN
      v_notice_failed := v_notice_failed + 1;
      PERFORM safety_notif_raise_alert('sweep_step_failed', 'immediate_response:' || v_id::text, SQLSTATE);
    END;
  END LOOP;

  -- (d) Late recipients for every patient with an open subject.
  FOR v_id IN
    SELECT patient_id FROM safety_notification_events WHERE resolved_at IS NULL AND superseded_by_event_id IS NULL
    UNION SELECT patient_id FROM safety_acute_stop_notices WHERE resolved_at IS NULL
  LOOP
    BEGIN
      v_late := v_late + safety_notif_add_late_recipients(v_id);
      PERFORM safety_notif_clear_alert('notification_hook_failed', 'patient:' || v_id::text);
    EXCEPTION WHEN OTHERS OR assert_failure THEN
      v_late_failed := v_late_failed + 1;
      PERFORM safety_notif_raise_alert('sweep_step_failed', 'patient:' || v_id::text, SQLSTATE);
    END;
  END LOOP;

  -- (e) Stalled urgent (Level 5) email: no provider acceptance 15 minutes
  --     after the intent was created. Cleared once terminal.
  FOR v_rec IN
    SELECT o.id FROM safety_email_outbox o
    WHERE o.tier = 'urgent_clinician_review' AND o.status IN ('pending', 'claimed', 'retry_scheduled', 'failed_permanent')
      AND o.created_at < clock_timestamp() - INTERVAL '15 minutes'
  LOOP
    PERFORM safety_notif_raise_alert('urgent_delivery_stalled', 'outbox:' || v_rec.id::text, NULL);
    v_stalled := v_stalled + 1;
  END LOOP;
  UPDATE safety_notification_alerts a SET cleared_at = clock_timestamp()
  WHERE a.kind = 'urgent_delivery_stalled' AND a.cleared_at IS NULL
    AND EXISTS (SELECT 1 FROM safety_email_outbox o WHERE 'outbox:' || o.id::text = a.subject_key
                AND o.status IN ('provider_accepted', 'suppressed_episode_released', 'suppressed_recipient_ineligible'));

  v_summary := jsonb_build_object(
    'orphan_patients_reconciled', v_orphans, 'reconcile_failed', v_reconcile_failed,
    'events_created', v_events, 'episode_failed', v_episode_failed,
    'notices_opened', v_notices_opened, 'notices_resolved', v_notices_resolved, 'notice_failed', v_notice_failed,
    'late_recipients', v_late, 'late_failed', v_late_failed, 'urgent_stalled', v_stalled);
  UPDATE safety_notification_heartbeats
     SET last_succeeded_at = clock_timestamp(), last_summary = v_summary
   WHERE component = 'sweep';
  RETURN jsonb_build_object('result', 'swept') || v_summary;
END;
$$;

-- -----------------------------------------------------------------------------
-- 14. Dispatch RPCs (server-only). The provider call happens OUTSIDE the
--     database, between claim and record, never in a clinical transaction.
-- -----------------------------------------------------------------------------
-- Retry delay AFTER attempt n (n = 1..7); attempt 8 is the last.
CREATE OR REPLACE FUNCTION safety_email_retry_delay(p_attempts_made INT)
RETURNS INTERVAL LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT (ARRAY[INTERVAL '1 minute', INTERVAL '5 minutes', INTERVAL '15 minutes', INTERVAL '1 hour',
                INTERVAL '3 hours', INTERVAL '6 hours', INTERVAL '8 hours'])[p_attempts_made];
$$;

-- p_only_outbox_ids: NULL = every eligible due intent (production
-- dispatch). A non-NULL array is an ADDITIONAL filter — only those intents
-- are considered (lease recovery included); it never bypasses any
-- eligibility condition below. An empty array considers nothing.
CREATE OR REPLACE FUNCTION safety_email_claim(p_limit INT DEFAULT 10, p_lease_seconds INT DEFAULT 120, p_only_outbox_ids UUID[] DEFAULT NULL)
RETURNS TABLE (outbox_id UUID, claim_token UUID, idempotency_key TEXT, attempt_no SMALLINT, tier TEXT,
               recipient_id UUID, recipient_email TEXT, organization_name TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_o safety_email_outbox;
  v_r safety_notification_recipients;
  v_email TEXT;
  v_org TEXT;
  v_token UUID;
  v_resolved BOOLEAN;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS' USING ERRCODE = 'P0001';
  END IF;

  -- Expired leases: the worker vanished mid-attempt. Close the attempt as
  -- abandoned (the provider may or may not have accepted it) and make the
  -- row immediately retryable with the SAME idempotency key.
  FOR v_o IN SELECT * FROM safety_email_outbox o WHERE o.status = 'claimed' AND o.claimed_until < clock_timestamp()
               AND (p_only_outbox_ids IS NULL OR o.id = ANY (p_only_outbox_ids))
             FOR UPDATE SKIP LOCKED LOOP
    UPDATE safety_email_attempts a SET finished_at = clock_timestamp(), outcome = 'abandoned_lease_expired'
    WHERE a.claim_token = v_o.claim_token AND a.finished_at IS NULL;
    IF v_o.attempt_count >= 8 THEN
      UPDATE safety_email_outbox SET status = 'failed_permanent', claim_token = NULL, claimed_until = NULL,
             last_error_code = 'attempts_exhausted_after_abandoned_attempt', terminal_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = v_o.id;
      PERFORM safety_notif_raise_alert('delivery_failed_permanent', 'outbox:' || v_o.id::text, 'attempts_exhausted');
    ELSE
      UPDATE safety_email_outbox SET status = 'retry_scheduled', claim_token = NULL, claimed_until = NULL,
             next_attempt_at = clock_timestamp(), last_error_code = 'abandoned_lease_expired', updated_at = clock_timestamp()
      WHERE id = v_o.id;
    END IF;
  END LOOP;

  FOR v_o IN SELECT * FROM safety_email_outbox o
             WHERE o.status IN ('pending', 'retry_scheduled') AND o.next_attempt_at <= clock_timestamp()
               AND (p_only_outbox_ids IS NULL OR o.id = ANY (p_only_outbox_ids))
             ORDER BY (o.tier = 'urgent_clinician_review') DESC, o.next_attempt_at, o.id
             LIMIT p_limit
             FOR UPDATE SKIP LOCKED LOOP
    SELECT * INTO v_r FROM safety_notification_recipients WHERE id = v_o.recipient_id;
    SELECT e.resolved_at IS NOT NULL INTO v_resolved FROM safety_notification_events e WHERE e.id = v_o.event_id;
    IF v_resolved THEN
      UPDATE safety_email_outbox SET status = 'suppressed_episode_released', terminal_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = v_o.id;
      CONTINUE;
    END IF;
    IF NOT safety_notif_recipient_eligible(v_r.id) THEN
      UPDATE safety_email_outbox SET status = 'suppressed_recipient_ineligible', terminal_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = v_o.id;
      CONTINUE;
    END IF;
    SELECT u.email INTO v_email FROM auth.users u WHERE u.id = v_r.recipient_user_id;
    IF v_email IS NULL OR btrim(v_email) = '' THEN
      UPDATE safety_email_outbox SET status = 'failed_permanent', last_error_code = 'recipient_email_missing',
             terminal_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = v_o.id;
      PERFORM safety_notif_raise_alert('delivery_failed_permanent', 'outbox:' || v_o.id::text, 'recipient_email_missing');
      CONTINUE;
    END IF;
    SELECT name INTO v_org FROM organizations WHERE id = v_r.organization_id;

    v_token := gen_random_uuid();
    UPDATE safety_email_outbox SET status = 'claimed', claim_token = v_token,
           claimed_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
           attempt_count = v_o.attempt_count + 1, updated_at = clock_timestamp()
    WHERE id = v_o.id;
    INSERT INTO safety_email_attempts (outbox_id, generation, attempt_no, claim_token, idempotency_key)
    VALUES (v_o.id, v_o.generation, v_o.attempt_count + 1, v_token, v_o.idempotency_key);

    outbox_id := v_o.id; claim_token := v_token; idempotency_key := v_o.idempotency_key;
    attempt_no := v_o.attempt_count + 1; tier := v_o.tier; recipient_id := v_r.id;
    recipient_email := v_email; organization_name := v_org;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- Records the provider outcome of one claimed attempt. A provider
-- acceptance is evidence and is always recorded (even late, even after the
-- lease expired or the row was suppressed); any other outcome from a stale
-- claim only closes its own attempt row.
CREATE OR REPLACE FUNCTION safety_email_record_result(
  p_outbox_id UUID, p_claim_token UUID, p_outcome TEXT, p_http_status INT, p_provider_message_id TEXT, p_error_code TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_a safety_email_attempts;
  v_o safety_email_outbox;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('provider_accepted', 'rejected_permanent', 'transient_error', 'timeout_ambiguous')
     OR (p_outcome = 'provider_accepted' AND (p_provider_message_id IS NULL OR char_length(p_provider_message_id) NOT BETWEEN 1 AND 200))
     OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z0-9_]{1,64}$')
     OR (p_http_status IS NOT NULL AND p_http_status NOT BETWEEN 100 AND 599) THEN
    RETURN jsonb_build_object('result', 'invalid_arguments');
  END IF;

  SELECT * INTO v_o FROM safety_email_outbox WHERE id = p_outbox_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unknown_claim'); END IF;
  SELECT * INTO v_a FROM safety_email_attempts WHERE claim_token = p_claim_token AND outbox_id = p_outbox_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unknown_claim'); END IF;

  IF v_a.finished_at IS NULL THEN
    UPDATE safety_email_attempts SET finished_at = v_now, outcome = p_outcome, http_status = p_http_status,
           provider_message_id = CASE WHEN p_outcome = 'provider_accepted' THEN p_provider_message_id END, error_code = p_error_code
    WHERE id = v_a.id;
  ELSIF v_a.outcome = 'abandoned_lease_expired' AND p_outcome = 'provider_accepted' THEN
    UPDATE safety_email_attempts SET outcome = 'provider_accepted', late_result = true, http_status = p_http_status,
           provider_message_id = p_provider_message_id
    WHERE id = v_a.id;
  ELSE
    -- This attempt already has its own recorded outcome: a replay.
    RETURN jsonb_build_object('result', 'stale_claim', 'status', v_o.status);
  END IF;

  IF p_outcome = 'provider_accepted' THEN
    IF v_o.status <> 'provider_accepted' THEN
      UPDATE safety_email_outbox SET status = 'provider_accepted', provider_message_id = p_provider_message_id,
             provider_accepted_at = v_now, terminal_at = v_now, claim_token = NULL, claimed_until = NULL,
             last_error_code = NULL, updated_at = v_now
      WHERE id = v_o.id;
    END IF;
    PERFORM safety_notif_clear_alert('urgent_delivery_stalled', 'outbox:' || v_o.id::text);
    PERFORM safety_notif_clear_alert('delivery_failed_permanent', 'outbox:' || v_o.id::text);
    RETURN jsonb_build_object('result', 'recorded', 'status', 'provider_accepted');
  END IF;

  IF v_o.status <> 'claimed' OR v_o.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object('result', 'stale_claim', 'status', v_o.status);
  END IF;

  IF p_outcome = 'rejected_permanent' OR v_o.attempt_count >= 8 THEN
    UPDATE safety_email_outbox SET status = 'failed_permanent', claim_token = NULL, claimed_until = NULL,
           last_error_code = CASE WHEN p_outcome = 'rejected_permanent' THEN coalesce(p_error_code, 'provider_rejected') ELSE 'attempts_exhausted' END,
           terminal_at = v_now, updated_at = v_now
    WHERE id = v_o.id;
    PERFORM safety_notif_raise_alert('delivery_failed_permanent', 'outbox:' || v_o.id::text,
      CASE WHEN p_outcome = 'rejected_permanent' THEN coalesce(p_error_code, 'provider_rejected') ELSE 'attempts_exhausted' END);
    RETURN jsonb_build_object('result', 'recorded', 'status', 'failed_permanent');
  END IF;

  UPDATE safety_email_outbox SET status = 'retry_scheduled', claim_token = NULL, claimed_until = NULL,
         next_attempt_at = v_now + safety_email_retry_delay(v_o.attempt_count),
         last_error_code = coalesce(p_error_code, p_outcome), updated_at = v_now
  WHERE id = v_o.id;
  RETURN jsonb_build_object('result', 'recorded', 'status', 'retry_scheduled');
END;
$$;

-- Audited manual recovery (super_user only): a failed_permanent intent gets
-- a NEW idempotency generation (a fresh provider key) and starts again.
CREATE OR REPLACE FUNCTION safety_email_requeue(p_outbox_id UUID, p_actor_id UUID, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_o safety_email_outbox;
  v_reason TEXT := btrim(coalesce(p_reason, ''));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.user_id = p_actor_id AND m.role = 'super_user') THEN
    RETURN jsonb_build_object('result', 'not_authorized');
  END IF;
  IF char_length(v_reason) NOT BETWEEN 1 AND 500 THEN RETURN jsonb_build_object('result', 'invalid_reason'); END IF;
  SELECT * INTO v_o FROM safety_email_outbox WHERE id = p_outbox_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF v_o.status <> 'failed_permanent' THEN RETURN jsonb_build_object('result', 'not_requeueable', 'status', v_o.status); END IF;

  INSERT INTO safety_email_requeues (outbox_id, requested_by, reason, previous_status, previous_generation, new_generation)
  VALUES (v_o.id, p_actor_id, v_reason, v_o.status, v_o.generation, v_o.generation + 1);
  UPDATE safety_email_outbox SET status = 'pending', generation = v_o.generation + 1,
         idempotency_key = 'tenotrainer-safety-email/' || v_o.id::text || '/g' || (v_o.generation + 1)::text,
         attempt_count = 0, next_attempt_at = clock_timestamp(), last_error_code = NULL, terminal_at = NULL, updated_at = clock_timestamp()
  WHERE id = v_o.id;
  PERFORM safety_notif_clear_alert('delivery_failed_permanent', 'outbox:' || v_o.id::text);
  RETURN jsonb_build_object('result', 'requeued', 'generation', v_o.generation + 1);
END;
$$;

CREATE OR REPLACE FUNCTION safety_email_dispatch_heartbeat(p_ok BOOLEAN, p_error_code TEXT, p_summary JSONB)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE safety_notification_heartbeats SET
    last_started_at = clock_timestamp(),
    last_succeeded_at = CASE WHEN p_ok THEN clock_timestamp() ELSE last_succeeded_at END,
    last_failed_at = CASE WHEN p_ok THEN last_failed_at ELSE clock_timestamp() END,
    last_error_code = CASE WHEN p_ok THEN last_error_code
                           WHEN p_error_code ~ '^[A-Za-z0-9_]{1,64}$' THEN p_error_code ELSE 'dispatch_failed' END,
    last_summary = p_summary
  WHERE component = 'dispatch';
$$;

-- -----------------------------------------------------------------------------
-- 15. Clinician inbox (server-only; the caller passes the authenticated
--     user id). Only CURRENTLY eligible rows are visible. Fallback-admin
--     rows carry no episode / session reference (no clinical access).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION safety_notification_inbox(p_user_id UUID, p_limit INT DEFAULT 100)
RETURNS TABLE (
  recipient_id UUID, subject_kind TEXT, tier TEXT, basis TEXT, patient_id UUID, patient_name TEXT,
  acute_safety_episode_id UUID, rehab_session_id UUID, detected_at TIMESTAMPTZ, read_at TIMESTAMPTZ,
  is_open BOOLEAN, resolved_at TIMESTAMPTZ, superseded BOOLEAN, effective_level SMALLINT, review_reasons TEXT[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id,
         CASE WHEN r.event_id IS NOT NULL THEN 'episode_event' ELSE 'acute_stop_notice' END,
         e.tier, r.basis, coalesce(e.patient_id, n.patient_id), p.name,
         CASE WHEN r.basis = 'fallback_clinician_admin' THEN NULL ELSE e.acute_safety_episode_id END,
         CASE WHEN r.basis = 'fallback_clinician_admin' THEN NULL ELSE n.rehab_session_id END,
         coalesce(e.detected_at, n.detected_at), r.read_at,
         coalesce(e.resolved_at, n.resolved_at) IS NULL AND e.superseded_by_event_id IS NULL,
         coalesce(e.resolved_at, n.resolved_at), e.superseded_by_event_id IS NOT NULL,
         CASE WHEN r.basis = 'fallback_clinician_admin' THEN NULL ELSE e.effective_level END,
         CASE WHEN r.basis = 'fallback_clinician_admin' THEN NULL ELSE e.review_reasons END
  FROM safety_notification_recipients r
  LEFT JOIN safety_notification_events e ON e.id = r.event_id
  LEFT JOIN safety_acute_stop_notices n ON n.id = r.acute_stop_notice_id
  LEFT JOIN profiles p ON p.id = coalesce(e.patient_id, n.patient_id)
  WHERE r.recipient_user_id = p_user_id AND safety_notif_recipient_eligible(r.id)
  ORDER BY coalesce(e.detected_at, n.detected_at) DESC, r.id
  LIMIT greatest(1, least(coalesce(p_limit, 100), 500));
$$;

CREATE OR REPLACE FUNCTION safety_notification_unread_count(p_user_id UUID)
RETURNS INT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::INT FROM safety_notification_recipients r
  WHERE r.recipient_user_id = p_user_id AND r.read_at IS NULL AND safety_notif_recipient_eligible(r.id);
$$;

-- Opens one notification for its recipient: ownership + current
-- eligibility, then (only when the caller allows a mutation — never in
-- maintenance) records read_at once. Returns the navigation target.
CREATE OR REPLACE FUNCTION safety_notification_open(p_recipient_id UUID, p_user_id UUID, p_mark_read BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r safety_notification_recipients;
  v_patient UUID;
  v_episode UUID;
  v_session UUID;
BEGIN
  SELECT * INTO v_r FROM safety_notification_recipients WHERE id = p_recipient_id;
  IF NOT FOUND OR v_r.recipient_user_id IS DISTINCT FROM p_user_id OR NOT safety_notif_recipient_eligible(v_r.id) THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF v_r.event_id IS NOT NULL THEN
    SELECT patient_id, acute_safety_episode_id INTO v_patient, v_episode FROM safety_notification_events WHERE id = v_r.event_id;
  ELSE
    SELECT patient_id, rehab_session_id INTO v_patient, v_session FROM safety_acute_stop_notices WHERE id = v_r.acute_stop_notice_id;
  END IF;
  IF p_mark_read AND v_r.read_at IS NULL THEN
    UPDATE safety_notification_recipients SET read_at = clock_timestamp() WHERE id = v_r.id AND read_at IS NULL;
  END IF;
  IF v_r.basis = 'fallback_clinician_admin' THEN
    RETURN jsonb_build_object('result', 'ok', 'destination', 'assign_clinician', 'patient_id', v_patient);
  END IF;
  IF v_episode IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'ok', 'destination', 'patient_safety', 'patient_id', v_patient, 'episode_id', v_episode);
  END IF;
  RETURN jsonb_build_object('result', 'ok', 'destination', 'patient_session', 'patient_id', v_patient, 'session_id', v_session);
END;
$$;

-- -----------------------------------------------------------------------------
-- 16. Health surface (super-user page reads it through the server; counts,
--     ages and codes only — no PHI).
-- -----------------------------------------------------------------------------
CREATE VIEW safety_notification_health WITH (security_invoker = true) AS
SELECT
  (SELECT count(*) FROM safety_email_outbox WHERE status IN ('pending', 'retry_scheduled', 'claimed')) AS outbox_in_flight,
  (SELECT min(created_at) FROM safety_email_outbox WHERE status IN ('pending', 'retry_scheduled', 'claimed')) AS oldest_in_flight_created_at,
  (SELECT count(*) FROM safety_email_outbox WHERE status = 'provider_accepted') AS outbox_provider_accepted,
  (SELECT count(*) FROM safety_email_outbox WHERE status = 'failed_permanent') AS outbox_failed_permanent,
  (SELECT count(*) FROM safety_email_outbox WHERE status = 'failed_permanent' AND tier = 'urgent_clinician_review') AS urgent_failed_permanent,
  (SELECT count(*) FROM safety_notification_alerts WHERE cleared_at IS NULL) AS open_alerts,
  (SELECT coalesce(jsonb_object_agg(kind, n), '{}'::jsonb) FROM (
     SELECT kind, count(*) AS n FROM safety_notification_alerts WHERE cleared_at IS NULL GROUP BY kind) k) AS open_alerts_by_kind,
  (SELECT last_succeeded_at FROM safety_notification_heartbeats WHERE component = 'sweep') AS sweep_last_succeeded_at,
  (SELECT last_summary FROM safety_notification_heartbeats WHERE component = 'sweep') AS sweep_last_summary,
  (SELECT last_succeeded_at FROM safety_notification_heartbeats WHERE component = 'dispatch') AS dispatch_last_succeeded_at,
  (SELECT last_failed_at FROM safety_notification_heartbeats WHERE component = 'dispatch') AS dispatch_last_failed_at;

-- -----------------------------------------------------------------------------
-- 17. Grants. RLS on, no client policy, no client privilege of any kind.
--     service_role may only READ the tables (health/audit); every write is
--     a SECURITY DEFINER function. Supabase's default grants on new
--     objects are revoked explicitly.
-- -----------------------------------------------------------------------------
DO $m32_grants$
DECLARE t TEXT; f RECORD;
BEGIN
  FOREACH t IN ARRAY ARRAY['safety_notification_events', 'safety_acute_stop_notices', 'safety_notification_recipients',
                           'safety_email_outbox', 'safety_email_attempts', 'safety_email_requeues',
                           'safety_notification_alerts', 'safety_notification_heartbeats'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated, service_role', t);
    EXECUTE format('GRANT SELECT ON public.%I TO service_role', t);
  END LOOP;
  REVOKE ALL ON public.safety_notification_health FROM PUBLIC, anon, authenticated, service_role;
  GRANT SELECT ON public.safety_notification_health TO service_role;

  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND (p.proname LIKE 'safety\_%' OR p.proname LIKE 'trg\_m32\_%') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f.sig);
  END LOOP;
END $m32_grants$;

GRANT EXECUTE ON FUNCTION safety_notifications_sweep() TO service_role;
GRANT EXECUTE ON FUNCTION safety_email_claim(INT, INT, UUID[]) TO service_role;
GRANT EXECUTE ON FUNCTION safety_email_record_result(UUID, UUID, TEXT, INT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION safety_email_requeue(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION safety_email_dispatch_heartbeat(BOOLEAN, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION safety_notification_inbox(UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION safety_notification_unread_count(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION safety_notification_open(UUID, UUID, BOOLEAN) TO service_role;

-- -----------------------------------------------------------------------------
-- 18. pg_cron: the durable DATABASE sweep, every minute, as the migration
--     owner in this database. Environment-independent: no URL, no secret,
--     no HTTP (founder D4).
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
SELECT cron.schedule('tenotrainer_m32_safety_notification_sweep', '* * * * *', 'SELECT public.safety_notifications_sweep()');
