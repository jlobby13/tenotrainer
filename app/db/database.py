"""
Database connection and query helpers for TenoTrainer.
Uses Python's built-in sqlite3 with a lightweight async wrapper via aiosqlite.
"""

import json
import sqlite3
import os
from pathlib import Path
from typing import Any, Optional

import aiosqlite

from app.db.schema import CREATE_TABLES_SQL

DB_PATH = os.environ.get("TENO_DB_PATH", str(Path(__file__).parent.parent / "tenotrainer.db"))


async def get_db() -> aiosqlite.Connection:
    """Return an open aiosqlite connection with row_factory set."""
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    return db


async def init_db() -> None:
    """Create all tables if they do not exist and seed knowledge base."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("PRAGMA foreign_keys=ON")
        # Execute each statement separately
        for statement in CREATE_TABLES_SQL.strip().split(";"):
            stmt = statement.strip()
            if stmt:
                await db.execute(stmt)
        await db.commit()

        # Migrations — add columns that didn't exist in earlier schema versions
        migrations = [
            "ALTER TABLE users ADD COLUMN password_hash TEXT",
            "ALTER TABLE users ADD COLUMN email TEXT",
            "ALTER TABLE users ADD COLUMN phone TEXT",
            "ALTER TABLE users ADD COLUMN tfa_enabled INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE users ADD COLUMN tfa_method TEXT NOT NULL DEFAULT 'email'",
            "ALTER TABLE users ADD COLUMN age INTEGER",
            "ALTER TABLE users ADD COLUMN sex TEXT",
            "ALTER TABLE users ADD COLUMN gender TEXT",
            "ALTER TABLE users ADD COLUMN height_cm REAL",
            "ALTER TABLE users ADD COLUMN weight_kg REAL",
            "ALTER TABLE users ADD COLUMN affected_side TEXT",
            "ALTER TABLE users ADD COLUMN activity_level TEXT",
            "ALTER TABLE users ADD COLUMN sports TEXT",
            "ALTER TABLE users ADD COLUMN condition_timeline TEXT",
            "ALTER TABLE onboarding_assessments ADD COLUMN functional_tests TEXT NOT NULL DEFAULT '{}'",
            "ALTER TABLE onboarding_assessments ADD COLUMN goals TEXT NOT NULL DEFAULT '{}'",
            "ALTER TABLE daily_logs ADD COLUMN load_context TEXT NOT NULL DEFAULT '{}'",
            "ALTER TABLE daily_logs ADD COLUMN exercise_log TEXT NOT NULL DEFAULT '{}'",
            "ALTER TABLE daily_logs ADD COLUMN morning_stiffness INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE users ADD COLUMN dashboard_layout TEXT",
            "ALTER TABLE users ADD COLUMN date_format TEXT NOT NULL DEFAULT 'MM-DD-YYYY'",
            "ALTER TABLE users ADD COLUMN color_tags_enabled INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE daily_logs ADD COLUMN pain_later_same_day INTEGER",
            "ALTER TABLE daily_logs ADD COLUMN is_complete INTEGER NOT NULL DEFAULT 0",
        ]
        for migration in migrations:
            try:
                await db.execute(migration)
                await db.commit()
            except Exception:
                pass  # Column already exists

    # Seed knowledge base entries if empty
    await seed_knowledge_base()
    # Seed exercise library if empty
    await seed_exercise_library()


async def seed_knowledge_base() -> None:
    """Seed the knowledge_entries table from knowledge_base.json if empty."""
    kb_path = Path(__file__).parent.parent / "data" / "knowledge_base.json"
    if not kb_path.exists():
        return

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT COUNT(*) as cnt FROM knowledge_entries")
        row = await cursor.fetchone()
        if row and row["cnt"] > 0:
            return  # Already seeded

        with open(kb_path, "r") as f:
            entries = json.load(f)

        for entry in entries:
            await db.execute(
                """
                INSERT OR IGNORE INTO knowledge_entries
                    (kb_id, title, authors, year, source, summary, key_points, tags,
                     clinical_question, applicability, recommended_loading_parameters,
                     progression_criteria, regression_criteria, contraindications)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    entry.get("id"),
                    entry["title"],
                    entry["authors"],
                    entry["year"],
                    entry["source"],
                    entry["summary"],
                    json.dumps(entry.get("key_points", [])),
                    json.dumps(entry.get("tags", [])),
                    entry.get("clinical_question"),
                    entry.get("applicability"),
                    json.dumps(entry.get("recommended_loading_parameters", {})),
                    entry.get("progression_criteria"),
                    entry.get("regression_criteria"),
                    entry.get("contraindications"),
                ),
            )
        await db.commit()


async def seed_exercise_library() -> None:
    """Seed the exercises table from exercise_library.json if empty."""
    lib_path = Path(__file__).parent.parent / "data" / "exercise_library.json"
    if not lib_path.exists():
        return

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT COUNT(*) as cnt FROM exercises")
        row = await cursor.fetchone()
        if row and row["cnt"] > 0:
            return  # Already seeded

        with open(lib_path, "r") as f:
            exercises = json.load(f)

        for ex in exercises:
            dosage = ex.get("dosage_defaults", {})
            await db.execute(
                """
                INSERT OR IGNORE INTO exercises (
                    ex_id, exercise_name, category, difficulty_level,
                    target_tissue, region_bias, loading_profile,
                    irritability_appropriateness, insertional_safe,
                    requires_dorsiflexion_depth, stretch_shortening_cycle,
                    rate_of_loading, unilateral_or_bilateral, requires_full_rom,
                    max_load_potential, impact_level, required_equipment,
                    dosage_defaults, progression_options, regression_options,
                    setup_instructions, execution_cues, common_compensations,
                    contraindications_or_cautions, decision_rules_tags,
                    patient_facing_explanation, clinician_notes
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?
                )
                """,
                (
                    ex["id"],
                    ex["exercise_name"],
                    ex["category"],
                    ex.get("difficulty_level", 1),
                    ex.get("target_tissue"),
                    json.dumps(ex.get("region_bias", [])),
                    ex["loading_profile"],
                    json.dumps(ex.get("irritability_appropriateness", [])),
                    1 if ex.get("insertional_safe", True) else 0,
                    ex.get("requires_dorsiflexion_depth", "none"),
                    1 if ex.get("stretch_shortening_cycle", False) else 0,
                    ex.get("rate_of_loading", "slow"),
                    ex.get("unilateral_or_bilateral", "bilateral"),
                    1 if ex.get("requires_full_rom", False) else 0,
                    ex.get("max_load_potential"),
                    ex.get("impact_level", "none"),
                    ex.get("required_equipment"),
                    json.dumps(dosage),
                    json.dumps(ex.get("progression_options", [])),
                    json.dumps(ex.get("regression_options", [])),
                    ex.get("setup_instructions"),
                    json.dumps(ex.get("execution_cues", [])),
                    json.dumps(ex.get("common_compensations", [])),
                    ex.get("contraindications_or_cautions"),
                    json.dumps(ex.get("decision_rules_tags", [])),
                    ex.get("patient_facing_explanation"),
                    ex.get("clinician_notes"),
                ),
            )
        await db.commit()


def row_to_dict(row: aiosqlite.Row) -> dict:
    """Convert an aiosqlite Row to a plain dict."""
    return dict(row)


def parse_json_fields(d: dict, fields: list[str]) -> dict:
    """Parse JSON string fields in a dict in-place and return it."""
    for field in fields:
        if field in d and isinstance(d[field], str):
            try:
                d[field] = json.loads(d[field])
            except (json.JSONDecodeError, TypeError):
                d[field] = []
    return d
