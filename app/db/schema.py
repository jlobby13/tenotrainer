"""
Database schema definitions for TenoTrainer.
All tables created via raw SQL for SQLite compatibility.
"""

CREATE_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'patient',
    session_token TEXT UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS onboarding_assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    morning_stiffness INTEGER NOT NULL,
    pain_at_rest INTEGER NOT NULL,
    pain_with_activity INTEGER NOT NULL,
    pain_after_activity INTEGER NOT NULL,
    next_day_pain INTEGER NOT NULL,
    calf_raise_reps INTEGER NOT NULL,
    functional_tests TEXT NOT NULL DEFAULT '{}',
    goals TEXT NOT NULL DEFAULT '{}',
    injury_duration TEXT NOT NULL,
    recent_load_change INTEGER NOT NULL DEFAULT 0,
    risk_factors TEXT NOT NULL DEFAULT '[]',
    stage INTEGER NOT NULL,
    irritability TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS visa_a_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    q1 INTEGER NOT NULL,
    q2 INTEGER NOT NULL,
    q3 INTEGER NOT NULL,
    q4 INTEGER NOT NULL,
    q5 INTEGER NOT NULL,
    q6 INTEGER NOT NULL,
    q7 INTEGER NOT NULL,
    q8 INTEGER NOT NULL,
    total_score INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS daily_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    session_id INTEGER,
    pain_during INTEGER NOT NULL,
    pain_after INTEGER NOT NULL,
    next_day_pain INTEGER NOT NULL,
    difficulty INTEGER NOT NULL,
    confidence INTEGER NOT NULL,
    notes TEXT,
    load_context TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS rehab_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    stage INTEGER NOT NULL,
    irritability TEXT NOT NULL,
    decision TEXT NOT NULL,
    exercises TEXT NOT NULL DEFAULT '[]',
    rationale TEXT,
    citations TEXT NOT NULL DEFAULT '[]',
    ai_explanation TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan_id INTEGER,
    session_number INTEGER NOT NULL DEFAULT 1,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (plan_id) REFERENCES rehab_plans(id)
);

CREATE TABLE IF NOT EXISTS progression_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    from_stage INTEGER NOT NULL,
    to_stage INTEGER NOT NULL,
    decision TEXT NOT NULL,
    triggered_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS knowledge_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kb_id TEXT UNIQUE,
    title TEXT NOT NULL,
    authors TEXT NOT NULL,
    year INTEGER NOT NULL,
    source TEXT NOT NULL,
    summary TEXT NOT NULL,
    key_points TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    clinical_question TEXT,
    applicability TEXT,
    recommended_loading_parameters TEXT DEFAULT '{}',
    progression_criteria TEXT,
    regression_criteria TEXT,
    contraindications TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tfa_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'login',
    pending_token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS session_follow_ups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    log_id INTEGER NOT NULL,
    checkpoint TEXT NOT NULL,
    due_at TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (log_id) REFERENCES daily_logs(id)
);

CREATE TABLE IF NOT EXISTS schedule_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    week_start TEXT NOT NULL,
    session_days TEXT NOT NULL DEFAULT '[]',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, week_start),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS supervisor_patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supervisor_id INTEGER NOT NULL,
    patient_id INTEGER NOT NULL,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'active',
    dismissed_at TIMESTAMP,
    dismissed_reason TEXT,
    dismissed_by INTEGER,
    FOREIGN KEY (supervisor_id) REFERENCES users(id),
    FOREIGN KEY (patient_id) REFERENCES users(id),
    UNIQUE(supervisor_id, patient_id)
);

CREATE TABLE IF NOT EXISTS supervisor_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    log_id INTEGER,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved INTEGER NOT NULL DEFAULT 0,
    resolved_at TEXT,
    FOREIGN KEY (patient_id) REFERENCES users(id),
    FOREIGN KEY (log_id) REFERENCES daily_logs(id)
);

CREATE TABLE IF NOT EXISTS supervisor_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    action_type TEXT NOT NULL,
    target_patient_id INTEGER,
    changes TEXT NOT NULL DEFAULT '{}',
    note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ex_id TEXT UNIQUE NOT NULL,
    exercise_name TEXT NOT NULL,
    category TEXT NOT NULL,
    difficulty_level INTEGER NOT NULL DEFAULT 1,
    target_tissue TEXT,
    region_bias TEXT NOT NULL DEFAULT '[]',
    loading_profile TEXT NOT NULL,
    irritability_appropriateness TEXT NOT NULL DEFAULT '[]',
    insertional_safe INTEGER NOT NULL DEFAULT 1,
    requires_dorsiflexion_depth TEXT NOT NULL DEFAULT 'none',
    stretch_shortening_cycle INTEGER NOT NULL DEFAULT 0,
    rate_of_loading TEXT NOT NULL DEFAULT 'slow',
    unilateral_or_bilateral TEXT NOT NULL DEFAULT 'bilateral',
    requires_full_rom INTEGER NOT NULL DEFAULT 0,
    max_load_potential TEXT,
    impact_level TEXT NOT NULL DEFAULT 'none',
    required_equipment TEXT,
    dosage_defaults TEXT NOT NULL DEFAULT '{}',
    progression_options TEXT NOT NULL DEFAULT '[]',
    regression_options TEXT NOT NULL DEFAULT '[]',
    setup_instructions TEXT,
    execution_cues TEXT NOT NULL DEFAULT '[]',
    common_compensations TEXT NOT NULL DEFAULT '[]',
    contraindications_or_cautions TEXT,
    decision_rules_tags TEXT NOT NULL DEFAULT '[]',
    patient_facing_explanation TEXT,
    clinician_notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
"""
