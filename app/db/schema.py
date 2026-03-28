"""
Database schema definitions for TenoTrainer.
All tables created via raw SQL for SQLite compatibility.
"""

CREATE_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
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
"""
