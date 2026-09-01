-- =============================================================================
-- Stage 1: Core schema migration
-- TenoTrainer · FastAPI/SQLite → Next.js/Supabase (PostgreSQL)
-- =============================================================================
-- Design notes:
--   • All PK/FKs use UUID (gen_random_uuid()).
--   • user_id columns reference auth.users(id) — Supabase Auth is the identity
--     source of truth; no password hashes are stored in public tables.
--   • JSON columns (previously TEXT in SQLite) become JSONB for indexability.
--   • Timestamps become TIMESTAMPTZ (UTC-aware).
--   • Enums for role / irritability / decision / etc. replace free-text.
--   • RLS is enabled on every table but no policies are written here —
--     that is Stage 3–4.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- fuzzy search on KB titles

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE org_role AS ENUM (
    'super_user',
    'clinician_admin',
    'clinician',
    'tester',
    'member'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE invitation_type AS ENUM (
    'USER_TESTER',
    'CLINICIAN_ADMIN_TESTER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE invitation_status AS ENUM (
    'pending',
    'accepted',
    'expired',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rehab_irritability AS ENUM ('low', 'moderate', 'high');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rehab_decision AS ENUM ('PROGRESS', 'STAY', 'REGRESS');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE alert_severity AS ENUM ('info', 'warning', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tfa_purpose AS ENUM ('login', 'enable_2fa', 'delete_account');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 2. Multi-tenancy foundation
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organization_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role            org_role NOT NULL DEFAULT 'member',
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_org  ON organization_members(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);

-- ---------------------------------------------------------------------------
-- 3. Invitations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invitations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invited_by      UUID NOT NULL REFERENCES auth.users(id),
  email           TEXT NOT NULL,
  invitation_type invitation_type NOT NULL,
  -- Role granted on acceptance — derived server-side from invitation_type, never trusted from browser
  granted_role    org_role NOT NULL,
  token           TEXT NOT NULL UNIQUE,  -- cryptographically random, server-generated
  status          invitation_status NOT NULL DEFAULT 'pending',
  expires_at      TIMESTAMPTZ NOT NULL,
  accepted_at     TIMESTAMPTZ,
  accepted_by     UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invitations_email  ON invitations(email);
CREATE INDEX IF NOT EXISTS idx_invitations_token  ON invitations(token);
CREATE INDEX IF NOT EXISTS idx_invitations_org    ON invitations(organization_id);

-- ---------------------------------------------------------------------------
-- 4. Profiles (replaces the custom users table)
--    auth.users owns the identity; this stores app-level profile data.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS profiles (
  id                   UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id      UUID REFERENCES organizations(id),
  name                 TEXT NOT NULL,
  phone                TEXT,
  age                  INTEGER,
  sex                  TEXT,
  gender               TEXT,
  height_cm            NUMERIC(5,1),
  weight_kg            NUMERIC(5,1),
  affected_side        TEXT,
  activity_level       TEXT,
  sports               TEXT,
  condition_timeline   TEXT,
  injury_sides         TEXT,
  previous_history     TEXT,
  seen_by_provider     BOOLEAN NOT NULL DEFAULT FALSE,
  seen_by_provider_notes TEXT,
  tfa_enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  tfa_method           TEXT NOT NULL DEFAULT 'email',
  dashboard_layout     TEXT,
  date_format          TEXT NOT NULL DEFAULT 'MM-DD-YYYY',
  color_tags_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  dismissed_at         TIMESTAMPTZ,
  access_expires_at    TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger: keep profiles.updated_at fresh
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DO $$ BEGIN
  CREATE TRIGGER trg_profiles_updated_at
    BEFORE UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 5. Exercises library (was INTEGER PK; now UUID)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS exercises (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ex_id                       TEXT UNIQUE NOT NULL,
  exercise_name               TEXT NOT NULL,
  category                    TEXT NOT NULL,
  difficulty_level            INTEGER NOT NULL DEFAULT 1,
  target_tissue               TEXT,
  region_bias                 JSONB NOT NULL DEFAULT '[]',
  loading_profile             TEXT NOT NULL,
  irritability_appropriateness JSONB NOT NULL DEFAULT '[]',
  insertional_safe            BOOLEAN NOT NULL DEFAULT TRUE,
  requires_dorsiflexion_depth TEXT NOT NULL DEFAULT 'none',
  stretch_shortening_cycle    BOOLEAN NOT NULL DEFAULT FALSE,
  rate_of_loading             TEXT NOT NULL DEFAULT 'slow',
  unilateral_or_bilateral     TEXT NOT NULL DEFAULT 'bilateral',
  requires_full_rom           BOOLEAN NOT NULL DEFAULT FALSE,
  max_load_potential          TEXT,
  impact_level                TEXT NOT NULL DEFAULT 'none',
  required_equipment          TEXT,
  dosage_defaults             JSONB NOT NULL DEFAULT '{}',
  progression_options         JSONB NOT NULL DEFAULT '[]',
  regression_options          JSONB NOT NULL DEFAULT '[]',
  setup_instructions          TEXT,
  execution_cues              JSONB NOT NULL DEFAULT '[]',
  common_compensations        JSONB NOT NULL DEFAULT '[]',
  contraindications_or_cautions TEXT,
  decision_rules_tags         JSONB NOT NULL DEFAULT '[]',
  patient_facing_explanation  TEXT,
  clinician_notes             TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 6. Knowledge base
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS knowledge_entries (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_id                        TEXT UNIQUE,
  title                        TEXT NOT NULL,
  authors                      TEXT NOT NULL,
  year                         INTEGER NOT NULL,
  source                       TEXT NOT NULL,
  summary                      TEXT NOT NULL,
  key_points                   JSONB NOT NULL DEFAULT '[]',
  tags                         JSONB NOT NULL DEFAULT '[]',
  clinical_question            TEXT,
  applicability                TEXT,
  recommended_loading_parameters JSONB DEFAULT '{}',
  progression_criteria         TEXT,
  regression_criteria          TEXT,
  contraindications            TEXT,
  study_design                 TEXT NOT NULL DEFAULT '',
  level_of_evidence            TEXT NOT NULL DEFAULT '',
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_title_trgm ON knowledge_entries USING GIN (title gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 7. Onboarding assessments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS onboarding_assessments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  morning_stiffness    INTEGER NOT NULL,
  pain_at_rest         INTEGER NOT NULL,
  pain_with_activity   INTEGER NOT NULL,
  pain_after_activity  INTEGER NOT NULL,
  next_day_pain        INTEGER NOT NULL,
  calf_raise_reps      INTEGER NOT NULL,
  injury_duration      TEXT NOT NULL,
  recent_load_change   BOOLEAN NOT NULL DEFAULT FALSE,
  risk_factors         JSONB NOT NULL DEFAULT '[]',
  stage                INTEGER NOT NULL,
  irritability         rehab_irritability NOT NULL,
  functional_tests     JSONB NOT NULL DEFAULT '{}',
  goals                JSONB NOT NULL DEFAULT '{}',
  comments             TEXT,
  problem_list         JSONB NOT NULL DEFAULT '[]',
  other_problems       TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_user ON onboarding_assessments(user_id);

-- ---------------------------------------------------------------------------
-- 8. Rehab plans
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rehab_plans (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stage          INTEGER NOT NULL,
  irritability   rehab_irritability NOT NULL,
  decision       rehab_decision NOT NULL,
  exercises      JSONB NOT NULL DEFAULT '[]',
  rationale      TEXT,
  citations      JSONB NOT NULL DEFAULT '[]',
  ai_explanation TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rehab_plans_user ON rehab_plans(user_id);

-- ---------------------------------------------------------------------------
-- 9. Sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id        UUID REFERENCES rehab_plans(id),
  session_number INTEGER NOT NULL DEFAULT 1,
  completed      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ---------------------------------------------------------------------------
-- 10. Daily logs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS daily_logs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id          UUID REFERENCES sessions(id),
  pain_during         INTEGER NOT NULL,
  pain_after          INTEGER NOT NULL,
  next_day_pain       INTEGER NOT NULL,
  difficulty          INTEGER NOT NULL,
  confidence          INTEGER NOT NULL,
  notes               TEXT,
  load_context        JSONB NOT NULL DEFAULT '{}',
  exercise_log        JSONB NOT NULL DEFAULT '{}',
  morning_stiffness   INTEGER NOT NULL DEFAULT 0,
  pain_later_same_day INTEGER,
  is_complete         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_logs_user    ON daily_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_daily_logs_created ON daily_logs(created_at DESC);

-- ---------------------------------------------------------------------------
-- 11. Session follow-ups
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS session_follow_ups (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  log_id       UUID NOT NULL REFERENCES daily_logs(id) ON DELETE CASCADE,
  checkpoint   TEXT NOT NULL,
  due_at       TIMESTAMPTZ NOT NULL,
  completed    BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_follow_ups_user ON session_follow_ups(user_id);

-- ---------------------------------------------------------------------------
-- 12. Progression decisions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS progression_decisions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_stage   INTEGER NOT NULL,
  to_stage     INTEGER NOT NULL,
  decision     rehab_decision NOT NULL,
  triggered_by TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_progression_user ON progression_decisions(user_id);

-- ---------------------------------------------------------------------------
-- 13. VISA-A responses
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS visa_a_responses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  q1          INTEGER NOT NULL,
  q2          INTEGER NOT NULL,
  q3          INTEGER NOT NULL,
  q4          INTEGER NOT NULL,
  q5          INTEGER NOT NULL,
  q6          INTEGER NOT NULL,
  q7          INTEGER NOT NULL,
  q8          INTEGER NOT NULL,
  total_score INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_visa_a_user ON visa_a_responses(user_id);

-- ---------------------------------------------------------------------------
-- 14. Schedule overrides (clinician scheduling privileges)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schedule_overrides (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  week_start  DATE NOT NULL,
  session_days JSONB NOT NULL DEFAULT '[]',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, week_start)
);

-- ---------------------------------------------------------------------------
-- 15. Messages (patient ↔ clinician/supervisor)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  read         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender    ON messages(sender_id);

-- ---------------------------------------------------------------------------
-- 16. Supervisor tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS supervisor_patients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supervisor_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  patient_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'active',
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dismissed_at    TIMESTAMPTZ,
  dismissed_reason TEXT,
  dismissed_by    UUID REFERENCES auth.users(id),
  UNIQUE (supervisor_id, patient_id)
);

CREATE INDEX IF NOT EXISTS idx_sup_patients_sup     ON supervisor_patients(supervisor_id);
CREATE INDEX IF NOT EXISTS idx_sup_patients_patient ON supervisor_patients(patient_id);

CREATE TABLE IF NOT EXISTS supervisor_assessments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  supervisor_id   UUID NOT NULL REFERENCES auth.users(id),
  calf_raise_reps INTEGER,
  functional_tests JSONB NOT NULL DEFAULT '{}',
  risk_factors    JSONB NOT NULL DEFAULT '[]',
  objective_info  TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sup_assessments_patient ON supervisor_assessments(patient_id);

CREATE TABLE IF NOT EXISTS supervisor_case_notes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  supervisor_id UUID NOT NULL REFERENCES auth.users(id),
  note          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_case_notes_patient ON supervisor_case_notes(patient_id);

CREATE TABLE IF NOT EXISTS supervisor_session_comments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supervisor_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  daily_log_id  UUID NOT NULL REFERENCES daily_logs(id) ON DELETE CASCADE,
  comment       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (supervisor_id, daily_log_id)
);

DO $$ BEGIN
  CREATE TRIGGER trg_sup_comments_updated_at
    BEFORE UPDATE ON supervisor_session_comments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS supervisor_alerts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  log_id      UUID REFERENCES daily_logs(id),
  type        TEXT NOT NULL,
  severity    alert_severity NOT NULL,
  message     TEXT NOT NULL,
  resolved    BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_patient  ON supervisor_alerts(patient_id);
CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON supervisor_alerts(resolved);

CREATE TABLE IF NOT EXISTS supervisor_audit_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id),
  action_type       TEXT NOT NULL,
  target_patient_id UUID REFERENCES auth.users(id),
  changes           JSONB NOT NULL DEFAULT '{}',
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user   ON supervisor_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON supervisor_audit_logs(target_patient_id);

-- ---------------------------------------------------------------------------
-- 17. 2FA codes (pending login tokens)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tfa_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  purpose       tfa_purpose NOT NULL DEFAULT 'login',
  pending_token TEXT NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tfa_codes_pending ON tfa_codes(pending_token);

-- ---------------------------------------------------------------------------
-- 18. Enable RLS on every table (policies written in Stage 3–4)
-- ---------------------------------------------------------------------------

ALTER TABLE organizations              ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members       ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations                ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE exercises                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entries          ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_assessments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE rehab_plans                ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_logs                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_follow_ups         ENABLE ROW LEVEL SECURITY;
ALTER TABLE progression_decisions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE visa_a_responses           ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_overrides         ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE supervisor_patients        ENABLE ROW LEVEL SECURITY;
ALTER TABLE supervisor_assessments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE supervisor_case_notes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE supervisor_session_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE supervisor_alerts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE supervisor_audit_logs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE tfa_codes                  ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 19. Profile auto-creation trigger
--     When Supabase Auth creates a new user, seed their profile row.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION handle_new_auth_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id, name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1))
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER trg_on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_auth_user();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
