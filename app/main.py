"""
TenoTrainer — Achilles Tendinopathy Rehabilitation Assistant
FastAPI application entry point.

Run with: uvicorn app.main:app --reload
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import aiosqlite
import bcrypt as _bcrypt
from fastapi import Cookie, FastAPI, Form, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.db.database import get_db, init_db, row_to_dict, parse_json_fields
from app.engine.rules import (
    OnboardingData,
    classify_onboarding,
    check_red_flags,
    get_fitt_dosing,
    run_decision_engine,
    select_exercises_for_plan,
    select_relevant_kb_tags,
    update_irritability_from_log,
    has_conservative_bias,
    compute_recovery_timeline,
    compute_phase_exit_checklist,
    evaluate_session_tolerance,
    filter_exercises_by_state,
    select_initial_exercises,
    evaluate_exercise_progression,
    classify_wblt,
    select_stretch_exercises,
    ExerciseDecision,
    Irritability,
    Decision,
)
from app.engine.visa_a import score_visa_a, get_questions, visa_a_score_from_form
from app.engine.ai_explainer import generate_explanation

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent

app = FastAPI(title="TenoTrainer", description="Achilles Tendinopathy Rehabilitation Assistant")

app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def startup_event():
    await init_db()
    logger.info("TenoTrainer database initialised.")


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def hash_password(password: str) -> str:
    return _bcrypt.hashpw(password.encode(), _bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return _bcrypt.checkpw(plain.encode(), hashed.encode())
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Session helpers
# ---------------------------------------------------------------------------

SESSION_COOKIE = "teno_session"


def _set_session_cookie(response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE, token,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 365,
    )


async def get_user_from_session(session_token: Optional[str]) -> Optional[dict]:
    """Return user dict if the session token is valid, else None."""
    if not session_token:
        return None
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM users WHERE session_token = ?", (session_token,)
        )
        row = await cursor.fetchone()
        return row_to_dict(row) if row else None
    finally:
        await db.close()


async def get_authenticated_user(session_token: Optional[str]) -> Optional[dict]:
    """Return user only if they have a registered account (password set)."""
    user = await get_user_from_session(session_token)
    if user and user.get("password_hash"):
        return user
    return None


# Keep for backwards compatibility with routes that don't require login
async def get_or_create_user(session_token: Optional[str], response: Response) -> dict:
    """Return existing session user or create a guest account."""
    user = await get_user_from_session(session_token)
    if user:
        return user

    db = await get_db()
    try:
        token = secrets.token_urlsafe(32)
        await db.execute(
            "INSERT INTO users (name, role, session_token) VALUES (?, ?, ?)",
            ("Guest", "patient", token),
        )
        await db.commit()
        cursor = await db.execute(
            "SELECT * FROM users WHERE session_token = ?", (token,)
        )
        row = await cursor.fetchone()
        user = row_to_dict(row)
        _set_session_cookie(response, token)
        return user
    finally:
        await db.close()


async def get_current_user(session_token: Optional[str]) -> Optional[dict]:
    """Return current user or None (no auto-create)."""
    if not session_token:
        return None
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM users WHERE session_token = ?", (session_token,)
        )
        row = await cursor.fetchone()
        return row_to_dict(row) if row else None
    finally:
        await db.close()


# ---------------------------------------------------------------------------
# Exercise dosage compliance
# ---------------------------------------------------------------------------

def compute_exercise_compliance(exercises: list[dict], form_data) -> dict:
    """
    Compare prescribed vs completed exercise dosage.
    form_data is an ImmutableMultiDict from request.form().
    """
    results = []
    for i, ex in enumerate(exercises):
        prescribed_sets = ex.get("sets", 0)
        prescribed_reps = str(ex.get("reps", ""))

        sets_done_raw = form_data.get(f"ex_{i}_sets_done", "")
        reps_done = str(form_data.get(f"ex_{i}_reps_done", "") or "").strip()
        load_kg = str(form_data.get(f"ex_{i}_load_kg", "") or "").strip()

        try:
            sets_done = int(sets_done_raw) if sets_done_raw else None
        except (ValueError, TypeError):
            sets_done = None

        if isinstance(prescribed_sets, (int, float)) and prescribed_sets > 0 and sets_done is not None:
            sets_compliance = round(sets_done / prescribed_sets * 100)
        else:
            sets_compliance = None

        results.append({
            "name": ex["name"],
            "type": ex.get("type", ""),
            "prescribed_sets": prescribed_sets,
            "prescribed_reps": prescribed_reps,
            "sets_done": sets_done,
            "reps_done": reps_done or None,
            "load_kg": load_kg or None,
            "sets_compliance": sets_compliance,
        })

    compliances = [r["sets_compliance"] for r in results if r["sets_compliance"] is not None]
    overall = round(sum(compliances) / len(compliances)) if compliances else None

    return {"exercises": results, "overall_compliance": overall}


# ---------------------------------------------------------------------------
# Knowledge Base helpers
# ---------------------------------------------------------------------------

async def get_kb_entries_by_tags(tags: list[str]) -> list[dict]:
    """Fetch KB entries that have at least one matching tag."""
    db = await get_db()
    try:
        cursor = await db.execute("SELECT * FROM knowledge_entries")
        rows = await cursor.fetchall()
        entries = []
        for row in rows:
            entry = parse_json_fields(row_to_dict(row), ["key_points", "tags", "recommended_loading_parameters"])
            entry_tags = set(entry.get("tags", []))
            if entry_tags & set(tags):
                entries.append(entry)
        return entries
    finally:
        await db.close()


async def get_all_kb_entries() -> list[dict]:
    db = await get_db()
    try:
        cursor = await db.execute("SELECT * FROM knowledge_entries ORDER BY year DESC")
        rows = await cursor.fetchall()
        return [
            parse_json_fields(row_to_dict(row), ["key_points", "tags", "recommended_loading_parameters"])
            for row in rows
        ]
    finally:
        await db.close()


# ---------------------------------------------------------------------------
# Auth routes — register / login / logout
# ---------------------------------------------------------------------------

@app.get("/register", response_class=HTMLResponse)
async def register_get(request: Request, teno_session: Optional[str] = Cookie(default=None)):
    user = await get_user_from_session(teno_session)
    if user and user.get("password_hash"):
        return RedirectResponse("/dashboard", status_code=302)
    return templates.TemplateResponse(request, "register.html", {"user": user, "error": None})


@app.post("/register", response_class=HTMLResponse)
async def register_post(
    request: Request,
    response: Response,
    teno_session: Optional[str] = Cookie(default=None),
    name: str = Form(...),
    email: str = Form(...),
    password: str = Form(...),
    password_confirm: str = Form(...),
):
    user = await get_user_from_session(teno_session)

    def fail(msg):
        return templates.TemplateResponse(
            request, "register.html", {"user": user, "error": msg,
                                        "name": name, "email": email},
        )

    if password != password_confirm:
        return fail("Passwords do not match.")
    if len(password) < 8:
        return fail("Password must be at least 8 characters.")
    if not email or "@" not in email:
        return fail("Please enter a valid email address.")

    db = await get_db()
    try:
        # Check email not already taken
        cursor = await db.execute("SELECT id FROM users WHERE email = ?", (email.lower().strip(),))
        if await cursor.fetchone():
            return fail("An account with that email already exists.")

        password_hash = hash_password(password)
        new_token = secrets.token_urlsafe(32)

        if user and not user.get("password_hash"):
            # Upgrade existing guest/demo session to full account
            await db.execute(
                "UPDATE users SET name = ?, email = ?, password_hash = ?, session_token = ? WHERE id = ?",
                (name.strip(), email.lower().strip(), password_hash, new_token, user["id"]),
            )
        else:
            # Create a brand-new account
            await db.execute(
                "INSERT INTO users (name, email, password_hash, role, session_token) VALUES (?, ?, ?, ?, ?)",
                (name.strip(), email.lower().strip(), password_hash, "patient", new_token),
            )
        await db.commit()
    finally:
        await db.close()

    redirect = RedirectResponse("/dashboard", status_code=302)
    _set_session_cookie(redirect, new_token)
    return redirect


@app.get("/login", response_class=HTMLResponse)
async def login_get(request: Request, teno_session: Optional[str] = Cookie(default=None)):
    user = await get_user_from_session(teno_session)
    if user and user.get("password_hash"):
        return RedirectResponse("/dashboard", status_code=302)
    return templates.TemplateResponse(request, "login.html", {"user": None, "error": None})


@app.post("/login", response_class=HTMLResponse)
async def login_post(
    request: Request,
    response: Response,
    email: str = Form(...),
    password: str = Form(...),
):
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM users WHERE email = ?", (email.lower().strip(),)
        )
        row = await cursor.fetchone()
        account = row_to_dict(row) if row else None
    finally:
        await db.close()

    if not account or not account.get("password_hash") or not verify_password(password, account["password_hash"]):
        return templates.TemplateResponse(
            request, "login.html",
            {"user": None, "error": "Invalid email or password.", "email": email},
        )

    # Issue a fresh session token on login
    new_token = secrets.token_urlsafe(32)
    db = await get_db()
    try:
        await db.execute("UPDATE users SET session_token = ? WHERE id = ?", (new_token, account["id"]))
        await db.commit()
    finally:
        await db.close()

    redirect = RedirectResponse("/dashboard", status_code=302)
    _set_session_cookie(redirect, new_token)
    return redirect


@app.get("/logout")
async def logout(response: Response):
    response.delete_cookie(SESSION_COOKIE)
    return RedirectResponse("/login", status_code=302)


# ---------------------------------------------------------------------------
# GET /account  — Account & Dashboard Settings
# ---------------------------------------------------------------------------

@app.get("/account", response_class=HTMLResponse)
async def account_settings_page(
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
):
    user = await get_current_user(teno_session)
    if not user:
        return RedirectResponse("/login", status_code=302)
    return templates.TemplateResponse(
        request, "account.html",
        context={"user": user},
    )


# ---------------------------------------------------------------------------
# GET /  — Homepage
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def homepage(
    request: Request,
    response: Response,
    teno_session: Optional[str] = Cookie(default=None),
):
    user = await get_or_create_user(teno_session, response)
    return templates.TemplateResponse(
        request, "index.html",
        context={
            "user": user
        },
    )


# ---------------------------------------------------------------------------
# GET /onboarding — Onboarding form
# ---------------------------------------------------------------------------

@app.get("/onboarding", response_class=HTMLResponse)
async def onboarding_get(
    request: Request,
    response: Response,
    teno_session: Optional[str] = Cookie(default=None),
    confirm: Optional[str] = None,
):
    user = await get_authenticated_user(teno_session)
    if not user:
        return RedirectResponse("/login", status_code=302)

    last_assessment_date = None
    days_since_assessment = None

    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT created_at FROM onboarding_assessments WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
            (user["id"],),
        )
        row = await cursor.fetchone()
        if row:
            row = row_to_dict(row)
            last_assessment_date = row["created_at"][:10]
            try:
                delta = datetime.utcnow() - datetime.fromisoformat(row["created_at"][:19])
                days_since_assessment = delta.days
            except Exception:
                days_since_assessment = None
    finally:
        await db.close()

    show_confirm = last_assessment_date is not None and confirm != "1"
    is_reassessment = last_assessment_date is not None
    today_date = datetime.utcnow().strftime("%Y-%m-%d")

    return templates.TemplateResponse(
        request, "onboarding.html",
        context={
            "user": user,
            "last_assessment_date": last_assessment_date,
            "days_since_assessment": days_since_assessment,
            "show_confirm": show_confirm,
            "is_reassessment": is_reassessment,
            "today_date": today_date,
            "questions": get_questions(),
        },
    )


# ---------------------------------------------------------------------------
# POST /onboarding — Submit onboarding
# ---------------------------------------------------------------------------

@app.post("/onboarding", response_class=HTMLResponse)
async def onboarding_post(
    request: Request,
    response: Response,
    teno_session: Optional[str] = Cookie(default=None),
    # Pain scores
    morning_stiffness: int = Form(...),
    pain_at_rest: int = Form(...),
    pain_with_activity: int = Form(...),
    pain_after_activity: int = Form(...),
    next_day_pain: int = Form(...),
    # Capacity
    calf_raise_reps: int = Form(...),
    calf_raise_reps_unaffected: Optional[int] = Form(default=None),
    wblt_cm: Optional[int] = Form(default=None),
    wblt_cm_unaffected: Optional[int] = Form(default=None),
    double_leg_hop_cm: Optional[int] = Form(default=None),
    single_leg_hop_cm: Optional[int] = Form(default=None),
    single_leg_hop_cm_unaffected: Optional[int] = Form(default=None),
    double_leg_hop_endurance_reps: Optional[int] = Form(default=None),
    single_leg_hop_endurance_reps: Optional[int] = Form(default=None),
    single_leg_hop_endurance_reps_unaffected: Optional[int] = Form(default=None),
    # History
    injury_duration: str = Form(...),
    recent_load_change: str = Form(default="0"),
    # Risk factors (checkboxes — may be absent)
    risk_obesity: Optional[str] = Form(default=None),
    risk_hypertension: Optional[str] = Form(default=None),
    risk_diabetes: Optional[str] = Form(default=None),
    risk_steroids: Optional[str] = Form(default=None),
    risk_load_spikes: Optional[str] = Form(default=None),
    risk_family_history: Optional[str] = Form(default=None),
    # Onset loading context
    onset_change_sport: str = Form(default="0"),
    onset_change_surface: str = Form(default="0"),
    onset_change_footwear: str = Form(default="0"),
    # Goals
    goal_activity: Optional[str] = Form(default=""),
    goal_level: Optional[str] = Form(default=""),
    goal_notes: Optional[str] = Form(default=""),
    # Red flags
    red_flags: Optional[str] = Form(default=""),
    # User name update
    user_name: Optional[str] = Form(default=None),
    # VISA-A questions
    q1: Optional[int] = Form(default=None),
    q2: Optional[int] = Form(default=None),
    q3: Optional[int] = Form(default=None),
    q4: Optional[int] = Form(default=None),
    q5: Optional[int] = Form(default=None),
    q6: Optional[int] = Form(default=None),
    q7: Optional[int] = Form(default=None),
    q8: Optional[int] = Form(default=None),
):
    user = await get_authenticated_user(teno_session)
    if not user:
        return RedirectResponse("/login", status_code=302)

    # Build risk factors list
    risk_factors = []
    if risk_obesity:
        risk_factors.append("obesity")
    if risk_hypertension:
        risk_factors.append("hypertension")
    if risk_diabetes:
        risk_factors.append("diabetes")
    if risk_steroids:
        risk_factors.append("steroids")
    if risk_load_spikes:
        risk_factors.append("load_spikes")
    if risk_family_history:
        risk_factors.append("family_history")

    # Parse red flags
    red_flag_list = [rf.strip() for rf in (red_flags or "").split(",") if rf.strip()]

    # RED FLAG CHECK — runs on EVERY submission
    # Pass the raw text as notes so phrase scanning catches natural language descriptions
    has_rf, rf_detail = check_red_flags(red_flag_list, notes=red_flags or "")

    if has_rf:
        return templates.TemplateResponse(
        request, "onboarding.html",
        context={
            "user": user,
                "error": "RED FLAG DETECTED",
                "red_flags": rf_detail,
                "halt": True
        },
        status_code=200,
    )

    # Build onboarding data
    data = OnboardingData(
        pain_with_activity=pain_with_activity,
        pain_after_activity=pain_after_activity,
        next_day_pain=next_day_pain,
        morning_stiffness=morning_stiffness,
        pain_at_rest=pain_at_rest,
        calf_raise_reps=calf_raise_reps,
        injury_duration=injury_duration,
        recent_load_change=(
            bool(int(recent_load_change))
            or bool(int(onset_change_sport))
            or bool(int(onset_change_surface))
            or bool(int(onset_change_footwear))
        ),
        risk_factors=risk_factors,
        red_flags=red_flag_list,
        calf_raise_reps_unaffected=calf_raise_reps_unaffected,
        wblt_cm=wblt_cm,
        wblt_cm_unaffected=wblt_cm_unaffected,
        double_leg_hop_cm=double_leg_hop_cm,
        single_leg_hop_cm=single_leg_hop_cm,
        double_leg_hop_endurance_reps=double_leg_hop_endurance_reps,
        single_leg_hop_endurance_reps=single_leg_hop_endurance_reps,
    )

    # Run rule engine — clinical decisions happen HERE
    classification = classify_onboarding(data)

    # Select exercises with dosing
    exercises = select_exercises_for_plan(
        classification.stage,
        classification.irritability,
        classification.conservative_bias,
    )

    # Get relevant KB entries
    relevant_tags = select_relevant_kb_tags(classification.stage, classification.irritability)
    kb_entries = await get_kb_entries_by_tags(relevant_tags)

    # Build plan dict for AI explainer (rule engine output only — no raw user inputs)
    plan = {
        "stage": classification.stage,
        "irritability": classification.irritability,
        "decision": Decision.STAY,
        "exercises": exercises,
        "rationale": classification.rationale,
        "fitt": classification.fitt,
        "citations": [{"title": e["title"], "authors": e["authors"], "year": e["year"]} for e in kb_entries],
    }

    # Get AI explanation (non-blocking — fallback if unavailable)
    name = user_name or user["name"]
    ai_explanation = await generate_explanation(plan, kb_entries, name)

    # Save to DB
    db = await get_db()
    try:
        # Update user name if provided
        if user_name and user_name.strip():
            await db.execute("UPDATE users SET name = ? WHERE id = ?", (user_name.strip(), user["id"]))

        # Save onboarding assessment
        functional_tests_json = json.dumps({
            k: v for k, v in {
                "calf_raise_reps_unaffected": calf_raise_reps_unaffected,
                "wblt_cm": wblt_cm,
                "wblt_cm_unaffected": wblt_cm_unaffected,
                "double_leg_hop_cm": double_leg_hop_cm,
                "single_leg_hop_cm": single_leg_hop_cm,
                "single_leg_hop_cm_unaffected": single_leg_hop_cm_unaffected,
                "double_leg_hop_endurance_reps": double_leg_hop_endurance_reps,
                "single_leg_hop_endurance_reps": single_leg_hop_endurance_reps,
                "single_leg_hop_endurance_reps_unaffected": single_leg_hop_endurance_reps_unaffected,
            }.items() if v is not None
        })
        goals_json = json.dumps({
            "activity": goal_activity or "",
            "level": goal_level or "",
            "notes": goal_notes or "",
            "onset_change_sport": bool(int(onset_change_sport)),
            "onset_change_surface": bool(int(onset_change_surface)),
            "onset_change_footwear": bool(int(onset_change_footwear)),
        })
        await db.execute(
            """INSERT INTO onboarding_assessments
               (user_id, morning_stiffness, pain_at_rest, pain_with_activity, pain_after_activity,
                next_day_pain, calf_raise_reps, functional_tests, goals, injury_duration,
                recent_load_change, risk_factors, stage, irritability)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                user["id"], morning_stiffness, pain_at_rest, pain_with_activity,
                pain_after_activity, next_day_pain, calf_raise_reps, functional_tests_json,
                goals_json, injury_duration, int(bool(int(recent_load_change))),
                json.dumps(risk_factors), classification.stage, classification.irritability,
            ),
        )

        # Save rehab plan
        cursor = await db.execute(
            """INSERT INTO rehab_plans
               (user_id, stage, irritability, decision, exercises, rationale, citations, ai_explanation)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                user["id"], classification.stage, classification.irritability,
                Decision.STAY, json.dumps(exercises), classification.rationale,
                json.dumps(plan["citations"]), ai_explanation,
            ),
        )
        plan_id = cursor.lastrowid

        # Create initial session
        await db.execute(
            "INSERT INTO sessions (user_id, plan_id, session_number, completed) VALUES (?, ?, ?, ?)",
            (user["id"], plan_id, 1, 0),
        )

        # Save VISA-A if all 8 questions answered
        visa_result = None
        if all(v is not None for v in [q1, q2, q3, q4, q5, q6, q7, q8]):
            visa_result = score_visa_a(q1, q2, q3, q4, q5, q6, q7, q8)
            await db.execute(
                """INSERT INTO visa_a_responses
                   (user_id, q1, q2, q3, q4, q5, q6, q7, q8, total_score)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    user["id"],
                    visa_result.q1, visa_result.q2, visa_result.q3, visa_result.q4,
                    visa_result.q5, visa_result.q6, visa_result.q7_score, visa_result.q8_score,
                    visa_result.total_score,
                ),
            )

        await db.commit()
    finally:
        await db.close()

    return templates.TemplateResponse(
        request, "plan.html",
        context={
            "user": user,
            "plan": plan,
            "classification": classification,
            "kb_entries": kb_entries,
            "ai_explanation": ai_explanation,
            "is_onboarding": True,
            "visa_result": visa_result,
        },
    )


# ---------------------------------------------------------------------------
# GET /visa-a — redirects to assessment (VISA-A is now part of the assessment)
# ---------------------------------------------------------------------------

@app.get("/visa-a", response_class=HTMLResponse)
async def visa_a_get(request: Request):
    return RedirectResponse("/onboarding", status_code=302)


@app.post("/visa-a", response_class=HTMLResponse)
async def visa_a_post(request: Request):
    return RedirectResponse("/onboarding", status_code=302)


# ---------------------------------------------------------------------------
# GET /dashboard
# ---------------------------------------------------------------------------

@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard(
    request: Request,
    response: Response,
    teno_session: Optional[str] = Cookie(default=None),
):
    user = await get_authenticated_user(teno_session)
    if not user:
        return RedirectResponse("/login", status_code=302)

    db = await get_db()
    try:
        # Unified user rehab state (irritability, stage, insertional, WBLT, session_plan, etc.)
        rehab_state = await _get_user_rehab_state(user, db)

        # Current plan (most recent) — kept for stage/irritability/decision badges and rationale
        cursor = await db.execute(
            "SELECT * FROM rehab_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
            (user["id"],),
        )
        plan_row = await cursor.fetchone()
        current_plan = None
        if plan_row:
            current_plan = parse_json_fields(
                row_to_dict(plan_row), ["exercises", "citations"]
            )

        # Recent daily logs (last 10)
        cursor = await db.execute(
            "SELECT * FROM daily_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 10",
            (user["id"],),
        )
        log_rows = await cursor.fetchall()
        recent_logs = [row_to_dict(r) for r in log_rows]
        for _log in recent_logs:
            try:
                _ex = json.loads(_log.get("exercise_log") or "{}")
            except Exception:
                _ex = {}
            _log["exercises_parsed"] = _ex.get("exercises", [])

        # VISA-A history
        cursor = await db.execute(
            "SELECT total_score, created_at FROM visa_a_responses WHERE user_id = ? ORDER BY created_at ASC",
            (user["id"],),
        )
        visa_rows = await cursor.fetchall()
        visa_history = [row_to_dict(r) for r in visa_rows]
        visa_labels = [_short_date(r["created_at"]) for r in visa_history]

        # Onboarding data — most recent for current state
        cursor = await db.execute(
            "SELECT * FROM onboarding_assessments WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
            (user["id"],),
        )
        onboarding_row = await cursor.fetchone()
        onboarding = None
        if onboarding_row:
            onboarding = parse_json_fields(row_to_dict(onboarding_row), ["risk_factors", "functional_tests"])
            raw_goals = onboarding.get("goals", "{}")
            onboarding["goals_parsed"] = json.loads(raw_goals or "{}")
            # Ensure functional_tests is a dict (may still be a string if parse failed)
            if isinstance(onboarding.get("functional_tests"), str):
                try:
                    onboarding["functional_tests"] = json.loads(onboarding["functional_tests"])
                except Exception:
                    onboarding["functional_tests"] = {}

        # All onboarding assessments — for longitudinal functional capacity charts
        cursor = await db.execute(
            "SELECT created_at, calf_raise_reps, functional_tests FROM onboarding_assessments"
            " WHERE user_id = ? ORDER BY created_at ASC",
            (user["id"],),
        )
        all_onboarding_rows = await cursor.fetchall()

        def _safe_ft(row_dict: dict) -> dict:
            try:
                return json.loads(row_dict.get("functional_tests") or "{}")
            except (json.JSONDecodeError, TypeError):
                return {}

        def _lsi(affected, unaffected):
            """Return LSI % or None if either value is missing."""
            if affected is not None and unaffected and unaffected > 0:
                return round(affected / unaffected * 100, 1)
            return None

        fc_labels, cr_affected, cr_unaffected, cr_lsi = [], [], [], []
        wblt_aff, wblt_unaff, wblt_lsi = [], [], []
        hop_d, hop_s, hop_su, hop_lsi = [], [], [], []
        hop_end_d, hop_end_s, hop_end_su, hop_end_lsi = [], [], [], []

        for row in all_onboarding_rows:
            rd = row_to_dict(row)
            ft = _safe_ft(rd)
            fc_labels.append(_short_date(rd["created_at"]))

            ca = rd.get("calf_raise_reps")
            cu = ft.get("calf_raise_reps_unaffected")
            cr_affected.append(ca)
            cr_unaffected.append(cu)
            cr_lsi.append(_lsi(ca, cu))

            wa = ft.get("wblt_cm")
            wu = ft.get("wblt_cm_unaffected")
            wblt_aff.append(wa)
            wblt_unaff.append(wu)
            wblt_lsi.append(_lsi(wa, wu))

            hd = ft.get("double_leg_hop_cm")
            hs = ft.get("single_leg_hop_cm")
            hsu = ft.get("single_leg_hop_cm_unaffected")
            hop_d.append(hd)
            hop_s.append(hs)
            hop_su.append(hsu)
            hop_lsi.append(_lsi(hs, hsu))

            hed = ft.get("double_leg_hop_endurance_reps")
            hes = ft.get("single_leg_hop_endurance_reps")
            hesu = ft.get("single_leg_hop_endurance_reps_unaffected")
            hop_end_d.append(hed)
            hop_end_s.append(hes)
            hop_end_su.append(hesu)
            hop_end_lsi.append(_lsi(hes, hesu))

        functional_chart_data = {
            "labels": fc_labels,
            "calf_raise": {"affected": cr_affected, "unaffected": cr_unaffected, "lsi": cr_lsi},
            "wblt": {"affected": wblt_aff, "unaffected": wblt_unaff, "lsi": wblt_lsi},
            "hop_distance": {"double": hop_d, "single": hop_s, "unaffected": hop_su, "lsi": hop_lsi},
            "hop_endurance": {"double": hop_end_d, "single": hop_end_s, "unaffected": hop_end_su, "lsi": hop_end_lsi},
        }

        # Progression decisions
        cursor = await db.execute(
            "SELECT * FROM progression_decisions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5",
            (user["id"],),
        )
        prog_rows = await cursor.fetchall()
        progression_history = [row_to_dict(r) for r in prog_rows]

        # Pain trend data for chart (last 10 logs, reversed for chronological)
        chart_logs = list(reversed(recent_logs))

        pain_chart_data = {
            "labels": [_short_date(l["created_at"]) for l in chart_logs],
            "during": [l["pain_during"] for l in chart_logs],
            "after": [l["pain_after"] for l in chart_logs],
            "next_day": [l["next_day_pain"] for l in chart_logs],
        }

    finally:
        await db.close()

    # Compute recovery timeline if we have both onboarding and a plan
    goals: dict = {}
    timeline = None
    if onboarding is not None and current_plan is not None:
        goals = onboarding.get("goals_parsed", {})
        conservative_bias_flag = bool(onboarding.get("risk_factors", []))
        timeline = compute_recovery_timeline(
            stage=current_plan["stage"],
            irritability=current_plan["irritability"],
            conservative_bias=conservative_bias_flag,
            injury_duration=onboarding.get("injury_duration", "chronic"),
            goal_level=goals.get("level", ""),
            risk_factors=onboarding.get("risk_factors", []),
        )

    # Phase-exit checklist — evaluated against session logs
    phase_checklist = None
    if current_plan is not None:
        phase_checklist = compute_phase_exit_checklist(
            stage=current_plan["stage"],
            session_logs=recent_logs,
            visa_history=visa_history,
        )

    # Adaptive weekly schedule — fetch KB evidence for current stage/irritability
    sched_stage = rehab_state.get("current_stage", 1)
    sched_irritability = rehab_state.get("current_irritability", "moderate")
    sched_tags = select_relevant_kb_tags(sched_stage, sched_irritability)
    sched_kb_entries = await get_kb_entries_by_tags(sched_tags)

    weekly_schedule = _compute_adaptive_schedule(
        stage=sched_stage,
        irritability=sched_irritability,
        decision=current_plan.get("decision", "STAY") if current_plan else "STAY",
        recent_logs=recent_logs,
        session_plan=rehab_state.get("session_plan", []),
        kb_entries=sched_kb_entries,
    )

    return templates.TemplateResponse(
        request, "dashboard.html",
        context={
            "user": user,
            "current_plan": current_plan,
            "recent_logs": recent_logs,
            "visa_history": visa_history,
            "visa_labels": visa_labels,
            "onboarding": onboarding,
            "progression_history": progression_history,
            "pain_chart_data": json.dumps(pain_chart_data),
            "functional_chart_data": json.dumps(functional_chart_data),
            "has_onboarding": onboarding is not None,
            "goals": goals,
            "timeline": timeline,
            "phase_checklist": phase_checklist,
            "weekly_schedule": weekly_schedule,
            # Unified rehab state — same data as Track Session and Exercise Library
            **rehab_state,
        },
    )


# ---------------------------------------------------------------------------
# Adaptive weekly schedule helper
# ---------------------------------------------------------------------------

def _short_date(dt_str: str) -> str:
    """'2024-06-05 10:00:00' → 'Jun 5'"""
    try:
        from datetime import datetime as _dt
        d = _dt.fromisoformat(dt_str[:10])
        return d.strftime("%b ") + str(d.day)
    except Exception:
        return dt_str[:10]


def _parse_freq_to_per_week(freq_str: str) -> tuple[int, int] | None:
    """
    Parse a frequency string from KB recommended_loading_parameters.frequency
    or exercise dosage_defaults.weekly_frequency into a (min, max) sessions/week range.

    Returns None if the string is not a session-frequency (e.g. assessment intervals).

    Examples:
      "3 times per week"       → (3, 3)
      "2-4 times per week"     → (2, 4)
      "2–3 times per week"     → (2, 3)
      "twice daily"            → (7, 14)   # lower-bound 1/day
      "daily or twice daily"   → (7, 14)
      "2–3 times daily"        → (7, 14)
      "2–3x daily"             → (7, 14)
      "1–2x daily"             → (7, 14)
      "every other day"        → (3, 4)
      "3x/week"                → (3, 3)
      "2x/week"                → (2, 2)
      "daily"                  → (7, 7)
      "every 2-4 weeks"        → None      # assessment interval — skip
    """
    if not freq_str:
        return None
    s = freq_str.lower().strip()

    # Skip assessment/review intervals
    if re.search(r"every\s+\d+.{0,5}week", s) and "per week" not in s:
        return None

    # Daily variants
    if re.search(r"(twice|2.{0,4}3\s*times?|2.{0,3}3x|1.{0,3}2x)\s*daily", s):
        return (7, 14)
    if re.search(r"\bdaily\b", s):
        return (7, 7)

    # "N times per week" or "N-M times per week"
    m = re.search(r"(\d+)\s*[-–]\s*(\d+)\s*times?\s*per\s*week", s)
    if m:
        return (int(m.group(1)), int(m.group(2)))
    m = re.search(r"(\d+)\s*times?\s*per\s*week", s)
    if m:
        n = int(m.group(1))
        return (n, n)

    # "Nx/week"
    m = re.search(r"(\d+)\s*x\s*/?\s*week", s)
    if m:
        n = int(m.group(1))
        return (n, n)

    # "every other day" ≈ 3-4x/week
    if "every other day" in s:
        return (3, 4)

    return None


def _compute_adaptive_schedule(
    stage: int,
    irritability: str,
    decision: str,
    recent_logs: list,
    session_plan: list,
    kb_entries: list | None = None,
) -> dict:
    """
    Compute the recommended weekly session frequency and day distribution,
    adapting based on progression decision, recent pain response, exercise
    compliance, KB evidence, and exercise-level frequency targets.

    Returns a dict consumed directly by the dashboard template.
    """

    factors: list[dict] = []  # {text, level: 'good'|'caution'|'warning'}

    # ── Full rest if engine says STOP ──────────────────────────────────────
    if decision == "STOP":
        return {
            "session_days": [],
            "sessions_per_week": 0,
            "freq_note": "Full rest week — engine decision is STOP",
            "factors": [{"text": "Engine decision STOP: complete rest indicated until clinician review", "level": "warning"}],
            "avg_next_day_pain": None,
            "avg_during_pain": None,
            "avg_compliance": None,
            "is_rest_week": True,
            "evidence_sources": [],
        }

    # ── Evidence-based base frequency from KB + exercise library ──────────
    evidence_sources: list[dict] = []
    kb_freq_vals: list[int] = []  # midpoint values for consensus

    if kb_entries:
        for entry in kb_entries:
            rlp = entry.get("recommended_loading_parameters") or {}
            freq_str = rlp.get("frequency", "") if isinstance(rlp, dict) else ""
            parsed = _parse_freq_to_per_week(freq_str)
            if parsed:
                lo, hi = parsed
                mid = round((lo + hi) / 2)
                # Cap daily+ protocols to session frequency for weekly planning
                weekly_mid = min(mid, 7)
                weekly_lo = min(lo, 7)
                weekly_hi = min(hi, 7)
                kb_freq_vals.append(weekly_mid)
                evidence_sources.append({
                    "title": entry.get("title", ""),
                    "authors": entry.get("authors", ""),
                    "year": entry.get("year", ""),
                    "recommended_freq": freq_str,
                    "parsed_per_week": weekly_mid,
                    "freq_lo": weekly_lo,
                    "freq_hi": weekly_hi,
                })

    # Exercise library frequency cross-reference
    ex_freq_vals: list[int] = []
    if session_plan:
        for ex in session_plan:
            dosage = ex.get("dosage_defaults") or {}
            if isinstance(dosage, str):
                try:
                    dosage = json.loads(dosage)
                except (json.JSONDecodeError, TypeError):
                    dosage = {}
            wf = dosage.get("weekly_frequency", "")
            parsed = _parse_freq_to_per_week(wf)
            if parsed:
                lo, hi = parsed
                ex_freq_vals.append(round((lo + hi) / 2))

    # Determine base_freq: KB consensus → exercise consensus → fallback table
    fallback_freq = {
        (1, "high"): 4, (1, "moderate"): 5, (1, "low"): 6,
        (2, "high"): 3, (2, "moderate"): 3, (2, "low"): 4,
        (3, "high"): 2, (3, "moderate"): 3, (3, "low"): 3,
    }.get((stage, irritability), 3)

    if kb_freq_vals:
        kb_consensus = round(sum(kb_freq_vals) / len(kb_freq_vals))
        # Clamp to stage-appropriate range
        stage_max = {1: 7, 2: 5, 3: 4}.get(stage, 5)
        base_freq = max(2, min(kb_consensus, stage_max))
        factors.append({
            "text": f"KB evidence ({len(evidence_sources)} studies): median {kb_consensus}x/week for Stage {stage} — schedule anchored to evidence",
            "level": "good",
        })
    elif ex_freq_vals:
        base_freq = round(sum(ex_freq_vals) / len(ex_freq_vals))
        base_freq = max(2, min(base_freq, 7))
        factors.append({
            "text": f"Exercise library defaults: avg {base_freq}x/week — no KB evidence for this stage/irritability combination",
            "level": "caution",
        })
    else:
        base_freq = fallback_freq
        factors.append({
            "text": "No KB or exercise frequency data available — using clinical defaults",
            "level": "caution",
        })

    # ── Decision modifier ──────────────────────────────────────────────────
    if decision == "CAUTION":
        base_freq = max(2, base_freq - 1)
        factors.append({"text": "Engine decision CAUTION — frequency reduced by 1 day", "level": "caution"})
    elif decision == "GO":
        factors.append({"text": "Engine decision GO — progressing at recommended frequency", "level": "good"})
    else:  # STAY
        factors.append({"text": "Engine decision STAY — maintaining current frequency", "level": "good"})

    # ── Recent pain response (last 3 sessions) ─────────────────────────────
    avg_next_day = None
    avg_during = None
    if recent_logs:
        sample = recent_logs[:3]  # most recent first
        avg_next_day = round(sum(l.get("next_day_pain", 0) for l in sample) / len(sample), 1)
        avg_during   = round(sum(l.get("pain_during",   0) for l in sample) / len(sample), 1)

        if avg_next_day > 5:
            base_freq = max(2, base_freq - 1)
            factors.append({
                "text": f"High next-day pain avg ({avg_next_day}/10 over last {len(sample)} sessions) — frequency reduced",
                "level": "warning",
            })
        elif avg_next_day > 3:
            factors.append({
                "text": f"Moderate next-day pain avg ({avg_next_day}/10) — monitoring response closely",
                "level": "caution",
            })
        else:
            factors.append({
                "text": f"Good next-day pain response (avg {avg_next_day}/10) — schedule on track",
                "level": "good",
            })

        if avg_during > 5:
            base_freq = max(2, base_freq - 1)
            factors.append({
                "text": f"High in-session pain avg ({avg_during}/10) — frequency reduced; review exercise dosage",
                "level": "warning",
            })
        elif avg_during > 3:
            factors.append({
                "text": f"Moderate in-session pain avg ({avg_during}/10) — stay within 3–4/10 working range",
                "level": "caution",
            })

    # ── Compliance (last 3 sessions with exercise data) ────────────────────
    avg_compliance = None
    compliance_vals = []
    for log in recent_logs[:5]:
        try:
            ex_log = json.loads(log.get("exercise_log") or "{}")
            for ex in ex_log.get("exercises", []):
                sc = ex.get("sets_compliance")
                if sc is not None:
                    compliance_vals.append(sc)
        except (json.JSONDecodeError, TypeError):
            continue

    if compliance_vals:
        avg_compliance = round(sum(compliance_vals) / len(compliance_vals), 1)
        if avg_compliance < 60:
            factors.append({
                "text": f"Low exercise completion ({avg_compliance}% avg) — consider reducing load before increasing frequency",
                "level": "warning",
            })
        elif avg_compliance < 85:
            factors.append({
                "text": f"Moderate exercise completion ({avg_compliance}% avg) — aim for ≥90% before progressing",
                "level": "caution",
            })
        else:
            factors.append({
                "text": f"Strong exercise completion ({avg_compliance}% avg) — ready to progress",
                "level": "good",
            })

    # ── Day distribution (maximise rest between sessions) ─────────────────
    day_patterns = {
        0: [],
        1: [2],
        2: [0, 3],
        3: [0, 2, 4],
        4: [0, 2, 3, 5],
        5: [0, 1, 2, 4, 5],
        6: [0, 1, 2, 3, 5, 6],
        7: [0, 1, 2, 3, 4, 5, 6],
    }
    session_days = day_patterns.get(min(base_freq, 7), [0, 2, 4])

    # ── Frequency note ─────────────────────────────────────────────────────
    min_recovery_h = {1: 24, 2: 48, 3: 72}.get(stage, 48)
    freq_note = f"{base_freq} day{'s' if base_freq != 1 else ''}/week"
    if stage == 1:
        freq_note += " — isometric loading; adjust daily based on morning pain"
    elif stage == 2:
        freq_note += f" — minimum {min_recovery_h} hr recovery between sessions"
    else:
        freq_note += f" — minimum {min_recovery_h} hr between plyometric/reactive sessions"

    return {
        "session_days": session_days,
        "sessions_per_week": base_freq,
        "freq_note": freq_note,
        "factors": factors,
        "avg_next_day_pain": avg_next_day,
        "avg_during_pain": avg_during,
        "avg_compliance": avg_compliance,
        "is_rest_week": False,
        "evidence_sources": evidence_sources,
    }


# ---------------------------------------------------------------------------
# Shared user-rehab-state helper
# ---------------------------------------------------------------------------

async def _get_user_rehab_state(user: dict, db) -> dict:
    """
    Single source of truth for per-user rehab state needed across multiple pages.
    Returns a dict with keys:
      current_irritability, current_stage, is_insertional,
      wblt_cm, wblt_cm_unaffected, wblt_result,
      baseline_morning_pain, baseline_morning_stiffness,
      has_plan, has_onboarding,
      session_plan, session_plan_ids
    """
    cursor = await db.execute(
        "SELECT * FROM rehab_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
        (user["id"],),
    )
    plan_row = await cursor.fetchone()

    cursor = await db.execute(
        "SELECT * FROM onboarding_assessments WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
        (user["id"],),
    )
    ob_row = await cursor.fetchone()

    current_irritability = Irritability.MODERATE
    current_stage = 1
    if plan_row:
        p = row_to_dict(plan_row)
        current_irritability = p.get("irritability", Irritability.MODERATE)
        current_stage = p.get("stage", 1)

    is_insertional = False
    wblt_cm = None
    wblt_cm_unaffected = None
    baseline_morning_pain = 0
    baseline_morning_stiffness = 0

    if ob_row:
        o = parse_json_fields(row_to_dict(ob_row), ["risk_factors", "functional_tests"])
        baseline_morning_pain = o.get("next_day_pain", 0)
        baseline_morning_stiffness = o.get("morning_stiffness", 0)
        rf = o.get("risk_factors", [])
        is_insertional = "insertional" in [r.lower() for r in rf]
        ft = o.get("functional_tests", {}) or {}
        if isinstance(ft, str):
            try: ft = json.loads(ft)
            except Exception: ft = {}
        wblt_cm = ft.get("wblt_cm") or o.get("wblt_cm")
        wblt_cm_unaffected = ft.get("wblt_cm_unaffected") or o.get("wblt_cm_unaffected")

    wblt_result = classify_wblt(wblt_cm, wblt_cm_unaffected)
    lib_exercises = await _load_exercises_from_db(db)
    session_plan = _build_session_plan(lib_exercises, current_irritability, current_stage, is_insertional, wblt_result)
    session_plan_ids = ",".join(item["exercise"]["ex_id"] for item in session_plan)

    return {
        "current_irritability": current_irritability,
        "current_stage": current_stage,
        "is_insertional": is_insertional,
        "wblt_cm": wblt_cm,
        "wblt_cm_unaffected": wblt_cm_unaffected,
        "wblt_result": wblt_result,
        "baseline_morning_pain": baseline_morning_pain,
        "baseline_morning_stiffness": baseline_morning_stiffness,
        "has_plan": plan_row is not None,
        "has_onboarding": ob_row is not None,
        "session_plan": session_plan,
        "session_plan_ids": session_plan_ids,
        "lib_exercises": lib_exercises,
    }


# ---------------------------------------------------------------------------
# GET /daily-log
# ---------------------------------------------------------------------------

def _build_session_plan(
    lib_exercises: list[dict],
    irritability: str,
    stage: int,
    insertional: bool,
    wblt_result: dict,
) -> list[dict]:
    """
    Build an ordered session plan from the exercise library rule engines.
    Returns list of dicts: {exercise, source, reason, dosage}.
    """
    _CATEGORY_REASON = {
        "symptom_modulation": "Pain modulation — isometric loading to reduce irritability",
        "slow_strength":      "Slow strength — primary tendon adaptation loading",
        "eccentric_loading":  "Eccentric loading — tendon remodelling and stiffness",
        "heavy_dynamic":      "Heavy dynamic — maximum load capacity development",
        "fast_dynamic":       "Fast dynamic — bridging to reactive demands",
        "reactive_plyometric":"Reactive strength — energy storage and return",
        "running_sport_reentry": "Running re-entry — progressive sport loading",
        "accessory":          "Accessory — targeted impairment support",
    }
    _STRETCH_REASON = {
        "primary": "WBLT restriction — dorsiflexion is a primary impairment target",
        "adjunct": "WBLT restriction — dorsiflexion mobility support",
    }

    loading = [ex for ex in lib_exercises if ex.get("category") != "flexibility_mobility"]
    loading_recs = select_initial_exercises(loading, irritability, stage, insertional, limit=4)

    stretch_recs = select_stretch_exercises(lib_exercises, wblt_result, insertional)
    # Limit stretches: 1 if adjunct, 2 if primary
    stretch_limit = 2 if wblt_result.get("stretch_priority") == "primary" else 1
    stretch_recs = stretch_recs[:stretch_limit] if wblt_result.get("stretch_indicated") else []

    plan = []
    for ex in loading_recs:
        dosage = ex.get("dosage_defaults", {})
        plan.append({
            "exercise": ex,
            "source": "loading",
            "reason": _CATEGORY_REASON.get(ex.get("category", ""), "Selected for current stage"),
            "dosage": dosage,
        })
    for ex in stretch_recs:
        dosage = ex.get("dosage_defaults", {})
        priority = wblt_result.get("stretch_priority", "adjunct")
        plan.append({
            "exercise": ex,
            "source": "stretch",
            "reason": _STRETCH_REASON.get(priority, "Stretch indicated"),
            "dosage": dosage,
        })
    return plan


@app.get("/daily-log", response_class=HTMLResponse)
async def daily_log_get(
    request: Request,
    response: Response,
    teno_session: Optional[str] = Cookie(default=None),
):
    user = await get_authenticated_user(teno_session)
    if not user:
        return RedirectResponse("/login", status_code=302)

    # Guard: if the user has manually moved today's session to another day, block logging
    from datetime import date as _date, timedelta as _td
    _today = _date.today()
    _today_dow = _today.weekday()          # 0=Mon … 6=Sun
    _week_start = (_today - _td(days=_today_dow)).isoformat()

    db = await get_db()
    try:
        _cur = await db.execute(
            "SELECT session_days FROM schedule_overrides WHERE user_id = ? AND week_start = ?",
            (user["id"], _week_start),
        )
        _override = await _cur.fetchone()
        if _override:
            _days = json.loads(_override["session_days"])
            if _today_dow not in _days:
                return RedirectResponse("/dashboard?blocked=1", status_code=302)

        state = await _get_user_rehab_state(user, db)
    finally:
        await db.close()

    return templates.TemplateResponse(
        request, "daily_log.html",
        context={"user": user, **state},
    )


# ---------------------------------------------------------------------------
# POST /daily-log
# ---------------------------------------------------------------------------

@app.post("/daily-log", response_class=HTMLResponse)
async def daily_log_post(
    request: Request,
    response: Response,
    teno_session: Optional[str] = Cookie(default=None),
    pain_during: int = Form(...),
    pain_after: int = Form(...),
    pain_later_same_day: int = Form(default=0),
    next_day_pain: int = Form(...),
    next_morning_stiffness: int = Form(default=0),
    difficulty: int = Form(...),
    confidence: int = Form(...),
    notes: Optional[str] = Form(default=""),
    red_flag_notes: Optional[str] = Form(default=""),
    sharp_pain: Optional[str] = Form(default=None),
    swelling_increase: Optional[str] = Form(default=None),
    limp_or_function_loss: Optional[str] = Form(default=None),
    abandoned_due_to_pain: Optional[str] = Form(default=None),
    change_sport: Optional[str] = Form(default=None),
    change_surface: Optional[str] = Form(default=None),
    change_footwear: Optional[str] = Form(default=None),
    load_context_notes: Optional[str] = Form(default=""),
    session_plan_ids: Optional[str] = Form(default=""),
):
    # Capture full form data for dynamic exercise fields
    form_data = await request.form()
    user = await get_authenticated_user(teno_session)
    if not user:
        return RedirectResponse("/login", status_code=302)

    # RED FLAG CHECK on every submission
    has_rf, rf_detail = check_red_flags([], notes=red_flag_notes or notes or "")
    if has_rf:
        return templates.TemplateResponse(
        request, "daily_log.html",
        context={
            "user": user,
                "error": "RED FLAG DETECTED",
                "red_flags": rf_detail,
                "halt": True
        },
    )

    # Run decision engine
    db = await get_db()
    try:
        # Get recent logs for decision engine
        cursor = await db.execute(
            "SELECT * FROM daily_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 10",
            (user["id"],),
        )
        log_rows = await cursor.fetchall()
        existing_logs = [row_to_dict(r) for r in log_rows]

        # Add the new log to the list for assessment
        new_log = {
            "pain_during": pain_during,
            "pain_after": pain_after,
            "next_day_pain": next_day_pain,
            "difficulty": difficulty,
            "confidence": confidence,
        }
        all_logs = existing_logs + [new_log]

        # Get current plan
        cursor = await db.execute(
            "SELECT * FROM rehab_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
            (user["id"],),
        )
        plan_row = await cursor.fetchone()

        # Get onboarding data
        cursor = await db.execute(
            "SELECT * FROM onboarding_assessments WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
            (user["id"],),
        )
        onboarding_row = await cursor.fetchone()

        current_stage = 1
        current_irritability = Irritability.MODERATE
        baseline_reps = 0
        conservative_bias = False
        plan_id = None

        current_exercises = []
        if plan_row:
            p = parse_json_fields(row_to_dict(plan_row), ["exercises"])
            current_stage = p["stage"]
            current_irritability = p["irritability"]
            plan_id = p["id"]
            current_exercises = p.get("exercises", [])

        if onboarding_row:
            o = parse_json_fields(row_to_dict(onboarding_row), ["risk_factors"])
            baseline_reps = o.get("calf_raise_reps", 0)
            conservative_bias = has_conservative_bias(o.get("risk_factors", []))

        # Update irritability from new log
        new_irritability = update_irritability_from_log(pain_during, pain_after, next_day_pain)

        # Build loading context changes list
        loading_context_changes = [
            key for key, val in [
                ("sport", change_sport),
                ("surface", change_surface),
                ("footwear", change_footwear),
            ] if val
        ]
        load_context_json = json.dumps({
            "changes": loading_context_changes,
            "notes": load_context_notes or "",
        })

        # Resolve exercises for compliance: prefer library plan from form if available
        lib_exercises_for_compliance = await _load_exercises_from_db(db)
        lib_ex_map = {ex["ex_id"]: ex for ex in lib_exercises_for_compliance}
        if session_plan_ids:
            ids = [i.strip() for i in session_plan_ids.split(",") if i.strip()]
            compliance_exercises = []
            for ex_id in ids:
                lib_ex = lib_ex_map.get(ex_id)
                if lib_ex:
                    dosage = lib_ex.get("dosage_defaults", {})
                    compliance_exercises.append({
                        "id": lib_ex["ex_id"],
                        "name": lib_ex["exercise_name"],
                        "type": lib_ex.get("loading_profile", ""),
                        "sets": dosage.get("sets", 3),
                        "reps": dosage.get("reps_or_hold_time", ""),
                        "tempo": dosage.get("tempo", ""),
                    })
        else:
            compliance_exercises = current_exercises

        exercise_compliance = compute_exercise_compliance(compliance_exercises, form_data)
        exercise_log_json = json.dumps(exercise_compliance)

        # Build and run session tolerance engine
        allowed_pain_map = {Irritability.HIGH: 3, Irritability.MODERATE: 4, Irritability.LOW: 5}
        allowed_pain = allowed_pain_map.get(current_irritability, 4)
        total_prescribed_sets = sum(
            ex.get("sets", 0) for ex in compliance_exercises
            if isinstance(ex.get("sets"), (int, float))
        )
        total_completed_sets = sum(
            (ex.get("sets_done") or 0) for ex in exercise_compliance.get("exercises", [])
        )
        # Fall back to 1 prescribed set if no plan yet (avoids division by zero)
        session_report = {
            "prescribed": {
                "sets": max(total_prescribed_sets, 1),
                "allowedPain": allowed_pain,
            },
            "completed": {
                "sets": total_completed_sets,
                "completed": not bool(abandoned_due_to_pain),
                "abandonedDueToPain": bool(abandoned_due_to_pain),
            },
            "symptoms": {
                "painDuring": pain_during,
                "painAfter": pain_after,
                "painLaterSameDay": pain_later_same_day,
                "nextMorningPain": next_day_pain,
                "nextMorningStiffness": next_morning_stiffness,
                "swellingIncrease": bool(swelling_increase),
                "sharpPain": bool(sharp_pain),
                "limpOrFunctionLoss": bool(limp_or_function_loss),
            },
            "baseline": {
                "usualMorningPain": o.get("next_day_pain", 0) if onboarding_row else 0,
                "usualMorningStiffness": o.get("morning_stiffness", 0) if onboarding_row else 0,
            },
        }
        session_tolerance = evaluate_session_tolerance(session_report)

        # Exercise-level progression recommendations
        ex_progression_recs = []
        try:
            all_lib_exercises = await _load_exercises_from_db(db)
            lib_ex_map = {ex["ex_id"]: ex for ex in all_lib_exercises}

            # Determine insertional status from risk factors
            _rf_list = []
            if onboarding_row:
                _o = parse_json_fields(row_to_dict(onboarding_row), ["risk_factors"])
                _rf_list = _o.get("risk_factors", [])
            is_insertional_now = "insertional" in [r.lower() for r in _rf_list]

            # For each exercise in the current plan that was logged this session
            for logged_ex in exercise_compliance.get("exercises", []):
                ex_id = logged_ex.get("exercise_id") or logged_ex.get("id", "")
                lib_ex = lib_ex_map.get(ex_id)
                if not lib_ex:
                    continue

                # Count how many sessions this exercise has been logged
                cursor = await db.execute(
                    """SELECT COUNT(*) as cnt FROM daily_logs
                       WHERE user_id = ? AND exercise_log LIKE ?""",
                    (user["id"], f'%"{ex_id}"%'),
                )
                cnt_row = await cursor.fetchone()
                sessions_at = (cnt_row[0] if cnt_row else 0) + 1  # +1 for this session

                rec = evaluate_exercise_progression(
                    current_exercise=lib_ex,
                    session_signal=session_tolerance["signal"],
                    irritability=new_irritability,
                    insertional=is_insertional_now,
                    sessions_at_current=sessions_at,
                    all_exercises=all_lib_exercises,
                )
                # Resolve target exercise name
                target_ex = lib_ex_map.get(rec["target_ex_id"])
                ex_progression_recs.append({
                    "current_name": lib_ex["exercise_name"],
                    "current_id":   ex_id,
                    "decision":     rec["decision"],
                    "target_id":    rec["target_ex_id"],
                    "target_name":  target_ex["exercise_name"] if target_ex else rec["target_ex_id"],
                    "rationale":    rec["rationale"],
                    "sessions_at":  sessions_at,
                })
        except Exception as _exc:
            logger.warning(f"Exercise progression engine error: {_exc}")
            ex_progression_recs = []

        # Run progression decision engine
        progression = run_decision_engine(
            recent_logs=all_logs[-8:],
            current_stage=current_stage,
            current_irritability=new_irritability,
            calf_raise_reps_baseline=baseline_reps,
            calf_raise_reps_current=baseline_reps,  # Updated at reassessment
            conservative_bias=conservative_bias,
            loading_context_changes=loading_context_changes,
        )

        # Save log
        await db.execute(
            """INSERT INTO daily_logs
               (user_id, session_id, pain_during, pain_after, next_day_pain, difficulty, confidence, notes, load_context, exercise_log)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (user["id"], plan_id, pain_during, pain_after, next_day_pain, difficulty, confidence, notes, load_context_json, exercise_log_json),
        )

        # If stage progression is warranted, create new plan
        if progression.can_progress_stage and progression.proposed_stage != current_stage:
            new_stage = progression.proposed_stage
            exercises = select_exercises_for_plan(new_stage, new_irritability, conservative_bias)
            relevant_tags = select_relevant_kb_tags(new_stage, new_irritability)
            kb_entries = await get_kb_entries_by_tags(relevant_tags)

            plan_dict = {
                "stage": new_stage,
                "irritability": new_irritability,
                "decision": progression.decision,
                "exercises": exercises,
                "rationale": progression.rationale,
                "fitt": get_fitt_dosing(new_irritability),
                "citations": [{"title": e["title"], "authors": e["authors"], "year": e["year"]} for e in kb_entries],
            }
            cursor = await db.execute(
                """INSERT INTO rehab_plans
                   (user_id, stage, irritability, decision, exercises, rationale, citations)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    user["id"], new_stage, new_irritability, progression.decision,
                    json.dumps(exercises), progression.rationale,
                    json.dumps(plan_dict["citations"]),
                ),
            )
            new_plan_id = cursor.lastrowid

            # Record progression decision
            await db.execute(
                """INSERT INTO progression_decisions
                   (user_id, from_stage, to_stage, decision, triggered_by)
                   VALUES (?, ?, ?, ?, ?)""",
                (user["id"], current_stage, new_stage, progression.decision, "daily_log"),
            )
        elif plan_id:
            # Update existing plan irritability and decision
            await db.execute(
                "UPDATE rehab_plans SET irritability = ?, decision = ? WHERE id = ?",
                (new_irritability, progression.decision, plan_id),
            )

        await db.commit()

    finally:
        await db.close()

    # Build next-session plan using updated irritability + stage
    next_stage = progression.proposed_stage if progression.can_progress_stage else current_stage
    try:
        lib_all = await _load_exercises_from_db(await get_db())
    except Exception:
        lib_all = []
    _next_wblt = classify_wblt(
        onboarding_row and parse_json_fields(row_to_dict(onboarding_row), ["functional_tests"]).get("functional_tests", {}).get("wblt_cm"),
        onboarding_row and parse_json_fields(row_to_dict(onboarding_row), ["functional_tests"]).get("functional_tests", {}).get("wblt_cm_unaffected"),
    ) if onboarding_row else classify_wblt(None, None)
    _is_insertional_post = False
    if onboarding_row:
        _o2 = parse_json_fields(row_to_dict(onboarding_row), ["risk_factors"])
        _is_insertional_post = "insertional" in [r.lower() for r in _o2.get("risk_factors", [])]
    next_session_plan = _build_session_plan(
        lib_all, new_irritability, next_stage, _is_insertional_post, _next_wblt
    )

    return templates.TemplateResponse(
        request, "daily_log.html",
        context={
            "user": user,
            "submitted": True,
            "session_tolerance": session_tolerance,
            "session_report": session_report,
            "progression": progression,
            "new_irritability": new_irritability,
            "pain_during": pain_during,
            "pain_after": pain_after,
            "next_day_pain": next_day_pain,
            "loading_context_changes": loading_context_changes,
            "exercise_compliance": exercise_compliance,
            "ex_progression_recs": ex_progression_recs,
            "next_session_plan": next_session_plan,
            "next_stage": next_stage,
        },
    )


# ---------------------------------------------------------------------------
# GET /exercise-log
# ---------------------------------------------------------------------------

@app.get("/exercise-log", response_class=HTMLResponse)
async def exercise_log_get(
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
):
    user = await get_authenticated_user(teno_session)
    if not user:
        return RedirectResponse("/login", status_code=302)

    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT id, pain_during, pain_after, next_day_pain, exercise_log, created_at "
            "FROM daily_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 30",
            (user["id"],),
        )
        log_rows = await cursor.fetchall()
        logs = [row_to_dict(r) for r in log_rows]
    finally:
        await db.close()

    # Group sessions by exercise name so each exercise gets its own history table.
    # exercise_history: OrderedDict preserving first-seen order (most recent first).
    exercise_history: dict = {}

    for log in logs:
        try:
            ex_log = json.loads(log.get("exercise_log") or "{}")
        except (json.JSONDecodeError, TypeError):
            continue

        exercises = ex_log.get("exercises", [])
        if not exercises:
            continue

        date_str = log["created_at"][:10]

        for ex in exercises:
            name = ex.get("name", "Unknown")
            if name not in exercise_history:
                exercise_history[name] = {
                    "name": name,
                    "type": ex.get("type", ""),
                    "prescribed_sets": ex.get("prescribed_sets"),
                    "prescribed_reps": ex.get("prescribed_reps", ""),
                    "sessions": [],
                }
            exercise_history[name]["sessions"].append({
                "date": date_str,
                "sets_done": ex.get("sets_done"),
                "reps_done": ex.get("reps_done"),
                "load_kg": ex.get("load_kg"),
                "sets_compliance": ex.get("sets_compliance"),
                "pain_during": log["pain_during"],
                "pain_after": log["pain_after"],
                "next_day_pain": log["next_day_pain"],
            })

    total_logged = sum(1 for l in logs if json.loads(l.get("exercise_log") or "{}").get("exercises"))

    return templates.TemplateResponse(
        request, "exercise_log.html",
        context={
            "user": user,
            "exercise_history": list(exercise_history.values()),
            "total_sessions": total_logged,
        },
    )


# ---------------------------------------------------------------------------
# GET /plan/{plan_id}
# ---------------------------------------------------------------------------

@app.get("/plan/{plan_id}", response_class=HTMLResponse)
async def view_plan(
    plan_id: int,
    request: Request,
    response: Response,
    teno_session: Optional[str] = Cookie(default=None),
):
    user = await get_or_create_user(teno_session, response)

    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM rehab_plans WHERE id = ? AND user_id = ?",
            (plan_id, user["id"]),
        )
        plan_row = await cursor.fetchone()
        if not plan_row:
            raise HTTPException(status_code=404, detail="Plan not found")

        plan = parse_json_fields(row_to_dict(plan_row), ["exercises", "citations"])

        # Get KB entries matching plan stage
        relevant_tags = select_relevant_kb_tags(plan["stage"], plan["irritability"])
        kb_entries = await get_kb_entries_by_tags(relevant_tags)

    finally:
        await db.close()

    stage_names = {1: "Capacity Initiation", 2: "Strength Development", 3: "Energy Storage & Release"}
    plan["stage_name"] = stage_names.get(plan["stage"], "Unknown")

    return templates.TemplateResponse(
        request, "plan.html",
        context={
            "user": user,
            "plan": plan,
            "kb_entries": kb_entries,
            "ai_explanation": plan.get("ai_explanation", ""),
            "is_onboarding": False
        },
    )


# ---------------------------------------------------------------------------
# GET /admin/knowledge
# ---------------------------------------------------------------------------

@app.get("/admin/knowledge", response_class=HTMLResponse)
async def admin_knowledge_get(
    request: Request,
    response: Response,
    teno_session: Optional[str] = Cookie(default=None),
):
    user = await get_or_create_user(teno_session, response)
    entries = await get_all_kb_entries()
    return templates.TemplateResponse(
        request, "admin_knowledge.html",
        context={
            "user": user, "entries": entries
        },
    )


# ---------------------------------------------------------------------------
# POST /admin/knowledge
# ---------------------------------------------------------------------------

@app.post("/admin/knowledge", response_class=HTMLResponse)
async def admin_knowledge_post(
    request: Request,
    response: Response,
    teno_session: Optional[str] = Cookie(default=None),
    title: str = Form(...),
    authors: str = Form(...),
    year: int = Form(...),
    source: str = Form(...),
    summary: str = Form(...),
    key_points: str = Form(default=""),
    tags: str = Form(default=""),
    clinical_question: str = Form(default=""),
    applicability: str = Form(default=""),
    progression_criteria: str = Form(default=""),
    regression_criteria: str = Form(default=""),
    contraindications: str = Form(default=""),
):
    user = await get_or_create_user(teno_session, response)

    # Parse key_points and tags as newline-separated lists
    key_points_list = [p.strip() for p in key_points.split("\n") if p.strip()]
    tags_list = [t.strip().lower().replace(" ", "_") for t in tags.split(",") if t.strip()]

    kb_id = f"kb_user_{uuid.uuid4().hex[:8]}"

    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO knowledge_entries
               (kb_id, title, authors, year, source, summary, key_points, tags,
                clinical_question, applicability, recommended_loading_parameters,
                progression_criteria, regression_criteria, contraindications)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                kb_id, title, authors, year, source, summary,
                json.dumps(key_points_list), json.dumps(tags_list),
                clinical_question, applicability, json.dumps({}),
                progression_criteria, regression_criteria, contraindications,
            ),
        )
        await db.commit()
    finally:
        await db.close()

    entries = await get_all_kb_entries()
    return templates.TemplateResponse(
        request, "admin_knowledge.html",
        context={
            "user": user,
            "entries": entries,
            "success": f"Entry '{title}' added successfully."
        },
    )


# ---------------------------------------------------------------------------
# GET /api/progression-check
# ---------------------------------------------------------------------------

@app.get("/api/progression-check")
async def progression_check_api(
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
):
    user = await get_current_user(teno_session)
    if not user:
        return {"error": "Not authenticated", "decision": "STAY"}

    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM daily_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 10",
            (user["id"],),
        )
        log_rows = await cursor.fetchall()
        logs = [row_to_dict(r) for r in log_rows]

        cursor = await db.execute(
            "SELECT * FROM rehab_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
            (user["id"],),
        )
        plan_row = await cursor.fetchone()

        cursor = await db.execute(
            "SELECT * FROM onboarding_assessments WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
            (user["id"],),
        )
        onboarding_row = await cursor.fetchone()

    finally:
        await db.close()

    current_stage = 1
    current_irritability = Irritability.MODERATE
    baseline_reps = 0

    if plan_row:
        p = row_to_dict(plan_row)
        current_stage = p["stage"]
        current_irritability = p["irritability"]

    if onboarding_row:
        o = row_to_dict(onboarding_row)
        baseline_reps = o.get("calf_raise_reps", 0)

    assessment = run_decision_engine(
        recent_logs=logs,
        current_stage=current_stage,
        current_irritability=current_irritability,
        calf_raise_reps_baseline=baseline_reps,
        calf_raise_reps_current=baseline_reps,
        conservative_bias=False,
    )

    return {
        "decision": assessment.decision,
        "current_stage": assessment.current_stage,
        "proposed_stage": assessment.proposed_stage,
        "rationale": assessment.rationale,
        "can_progress_stage": assessment.can_progress_stage,
    }


# ---------------------------------------------------------------------------
# Schedule Override API
# ---------------------------------------------------------------------------

@app.get("/api/schedule-override")
async def get_schedule_override(
    week: str,
    teno_session: Optional[str] = Cookie(default=None),
):
    user = await get_current_user(teno_session)
    if not user:
        return {"session_days": None}
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT session_days FROM schedule_overrides WHERE user_id = ? AND week_start = ?",
            (user["id"], week),
        )
        row = await cursor.fetchone()
        if row:
            return {"session_days": json.loads(row["session_days"])}
        return {"session_days": None}
    finally:
        await db.close()


@app.post("/api/schedule-override")
async def save_schedule_override(
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
):
    user = await get_current_user(teno_session)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    week = body.get("week")
    session_days = body.get("session_days", [])
    if not week:
        raise HTTPException(status_code=400, detail="week is required")
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO schedule_overrides (user_id, week_start, session_days, updated_at)
               VALUES (?, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(user_id, week_start) DO UPDATE SET
               session_days = excluded.session_days,
               updated_at = CURRENT_TIMESTAMP""",
            (user["id"], week, json.dumps(session_days)),
        )
        await db.commit()
        return {"ok": True}
    finally:
        await db.close()


@app.get("/api/session-logs")
async def get_session_logs_range(
    from_date: str,
    to_date: str,
    teno_session: Optional[str] = Cookie(default=None),
):
    """Return daily logs for a date range, keyed by YYYY-MM-DD date string."""
    user = await get_current_user(teno_session)
    if not user:
        return {"logs": {}}
    db = await get_db()
    try:
        cursor = await db.execute(
            """SELECT pain_during, pain_after, next_day_pain, difficulty, confidence,
                      exercise_log, created_at
               FROM daily_logs
               WHERE user_id = ? AND DATE(created_at) >= ? AND DATE(created_at) <= ?
               ORDER BY created_at ASC""",
            (user["id"], from_date, to_date),
        )
        rows = await cursor.fetchall()
    finally:
        await db.close()

    result = {}
    for row in rows:
        r = row_to_dict(row)
        date_key = r["created_at"][:10]
        try:
            ex_data = json.loads(r.get("exercise_log") or "{}")
        except Exception:
            ex_data = {}
        exercises = ex_data.get("exercises", [])
        # Compute overall compliance
        comp_vals = [e.get("sets_compliance") for e in exercises if e.get("sets_compliance") is not None]
        overall_comp = round(sum(comp_vals) / len(comp_vals)) if comp_vals else None
        result[date_key] = {
            "created_at": r["created_at"],   # full UTC timestamp — JS re-keys by local date
            "pain_during": r["pain_during"],
            "pain_after": r["pain_after"],
            "next_day_pain": r["next_day_pain"],
            "difficulty": r["difficulty"],
            "confidence": r["confidence"],
            "overall_compliance": overall_comp,
            "exercises": [
                {
                    "name": e.get("name", ""),
                    "sets_done": e.get("sets_done"),
                    "prescribed_sets": e.get("prescribed_sets"),
                    "sets_compliance": e.get("sets_compliance"),
                    "reps_done": e.get("reps_done") or e.get("prescribed_reps") or "—",
                    "tempo": e.get("tempo") or "",
                }
                for e in exercises
            ],
        }
    return {"logs": result}


# ---------------------------------------------------------------------------
# Weekly adaptation helper + API
# ---------------------------------------------------------------------------

def _compute_week_adaptation(
    completed_logs: list[dict],
    missed_count: int,
    remaining_count: int,
) -> dict:
    """
    Compute weekly adaptive dosing adjustment based on session outcomes.

    Rules (highest priority first):
      peak pain ≥6 OR next-day pain >5  → reduce   (60% of sets)
      peak pain 4-5 OR next-day pain 3-5 → caution  (85% of sets)
      compliance <60%                    → caution  (75% of sets)
      ≥2 missed sessions                 → caution  (85% of sets)
      otherwise                          → maintain (100%)
    """
    import datetime as _datetime

    stats: dict = {
        "done": len(completed_logs),
        "missed": missed_count,
        "remaining": remaining_count,
        "peak_pain": None,
        "compliance": None,
    }

    if not completed_logs and missed_count == 0:
        return {
            "has_adaptation": False,
            "level": "maintain",
            "sets_factor": 1.0,
            "rationale": "",
            "stats": stats,
        }

    # Derive peak pain and mean compliance from completed sessions
    peak_pain = 0
    peak_next_day = 0
    comp_vals: list[int] = []
    for log in completed_logs:
        peak_pain = max(peak_pain, log.get("pain_during") or 0, log.get("pain_after") or 0)
        peak_next_day = max(peak_next_day, log.get("next_day_pain") or 0)
        if log.get("overall_compliance") is not None:
            comp_vals.append(log["overall_compliance"])

    mean_comp = round(sum(comp_vals) / len(comp_vals)) if comp_vals else None
    stats["peak_pain"] = peak_pain if completed_logs else None
    stats["compliance"] = mean_comp

    level = "maintain"
    sets_factor = 1.0
    rationale = ""

    if peak_pain >= 6 or peak_next_day > 5:
        level = "reduce"
        sets_factor = 0.60
        rationale = (
            f"High pain recorded this week (peak {peak_pain}/10 during session, "
            f"next-day {peak_next_day}/10). Load significantly reduced for remaining sessions "
            "to allow tendon recovery."
        )
    elif peak_pain >= 4 or peak_next_day >= 3:
        level = "caution"
        sets_factor = 0.85
        rationale = (
            f"Moderate pain detected this week (peak {peak_pain}/10, next-day {peak_next_day}/10). "
            "Applying conservative load reduction. Stay within 3\u20134/10 working pain range."
        )
    elif mean_comp is not None and mean_comp < 60:
        level = "caution"
        sets_factor = 0.75
        rationale = (
            f"Low session compliance this week ({mean_comp}% average). "
            "Volume reduced to match actual capacity before the next session."
        )
    elif missed_count >= 2:
        level = "caution"
        sets_factor = 0.85
        rationale = (
            f"{missed_count} session{'s' if missed_count != 1 else ''} missed this week. "
            "Applying conservative loading for remaining sessions to avoid overloading."
        )

    if level == "maintain":
        rationale = "Week is progressing well. Continuing with prescribed dosing for remaining sessions."

    return {
        "has_adaptation": True,
        "level": level,
        "sets_factor": sets_factor,
        "rationale": rationale,
        "stats": stats,
    }


@app.get("/api/weekly-adaptation")
async def get_weekly_adaptation(
    week: str,
    session_days: str = "",
    teno_session: Optional[str] = Cookie(default=None),
):
    """
    Compute weekly load adaptation for the given week.

    Query params:
      week         — ISO date of Monday (YYYY-MM-DD)
      session_days — comma-separated scheduled day indices e.g. "0,2,4"
    """
    user = await get_current_user(teno_session)
    if not user:
        return {"has_adaptation": False}

    from datetime import date as _date, timedelta as _td
    import datetime as _datetime

    try:
        week_date = _date.fromisoformat(week)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid week format")

    week_end = week_date + _td(days=6)
    today = _date.today()

    try:
        sched_days = [int(d.strip()) for d in session_days.split(",") if d.strip()]
    except ValueError:
        sched_days = []

    if not sched_days:
        return {"has_adaptation": False}

    # Fetch logs with ±1 day buffer to handle UTC/local boundary mismatches
    from_buf = (week_date - _td(days=1)).isoformat()
    to_buf = (week_end + _td(days=1)).isoformat()

    db = await get_db()
    try:
        cursor = await db.execute(
            """SELECT pain_during, pain_after, next_day_pain, exercise_log, created_at
               FROM daily_logs
               WHERE user_id = ? AND DATE(created_at) >= ? AND DATE(created_at) <= ?
               ORDER BY created_at ASC""",
            (user["id"], from_buf, to_buf),
        )
        rows = await cursor.fetchall()
    finally:
        await db.close()

    # Re-key logs by LOCAL date (same UTC→local conversion as /api/session-logs)
    logs_by_local_date: dict = {}
    for row in rows:
        r = row_to_dict(row)
        ts = r["created_at"]
        try:
            dt_utc = _datetime.datetime.fromisoformat(
                ts.replace(" ", "T")
            ).replace(tzinfo=_datetime.timezone.utc)
            local_date = dt_utc.astimezone().date()
        except Exception:
            local_date = _date.fromisoformat(ts[:10])

        if week_date <= local_date <= week_end:
            try:
                ex_data = json.loads(r.get("exercise_log") or "{}")
            except Exception:
                ex_data = {}
            exercises = ex_data.get("exercises", [])
            comp_vals = [
                e.get("sets_compliance")
                for e in exercises
                if e.get("sets_compliance") is not None
            ]
            logs_by_local_date[local_date] = {
                "pain_during": r["pain_during"],
                "pain_after": r["pain_after"],
                "next_day_pain": r["next_day_pain"],
                "overall_compliance": round(sum(comp_vals) / len(comp_vals)) if comp_vals else None,
            }

    # Classify each scheduled day
    completed_logs: list[dict] = []
    missed_count = 0
    remaining_count = 0

    for day_idx in sched_days:
        session_date = week_date + _td(days=day_idx)
        if session_date in logs_by_local_date:
            completed_logs.append(logs_by_local_date[session_date])
        elif session_date < today:
            missed_count += 1
        else:
            remaining_count += 1

    return _compute_week_adaptation(completed_logs, missed_count, remaining_count)


@app.delete("/api/schedule-override")
async def delete_schedule_override(
    week: str,
    teno_session: Optional[str] = Cookie(default=None),
):
    user = await get_current_user(teno_session)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    db = await get_db()
    try:
        await db.execute(
            "DELETE FROM schedule_overrides WHERE user_id = ? AND week_start = ?",
            (user["id"], week),
        )
        await db.commit()
        return {"ok": True}
    finally:
        await db.close()


# ---------------------------------------------------------------------------
# Exercise Library
# ---------------------------------------------------------------------------

async def _load_exercises_from_db(db: aiosqlite.Connection) -> list[dict]:
    """Fetch all exercises from DB and deserialise JSON fields."""
    JSON_FIELDS = [
        "region_bias", "irritability_appropriateness", "dosage_defaults",
        "progression_options", "regression_options", "execution_cues",
        "common_compensations", "decision_rules_tags",
    ]
    cursor = await db.execute(
        "SELECT * FROM exercises ORDER BY difficulty_level ASC, category ASC"
    )
    rows = await cursor.fetchall()
    exercises = []
    for row in rows:
        ex = row_to_dict(row)
        ex = parse_json_fields(ex, JSON_FIELDS)
        # Normalise booleans from INTEGER
        ex["insertional_safe"] = bool(ex.get("insertional_safe", 1))
        ex["stretch_shortening_cycle"] = bool(ex.get("stretch_shortening_cycle", 0))
        ex["requires_full_rom"] = bool(ex.get("requires_full_rom", 0))
        exercises.append(ex)
    return exercises


@app.get("/exercise-library", response_class=HTMLResponse)
async def exercise_library_page(
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
    irritability: Optional[str] = None,
    category: Optional[str] = None,
    insertional_only: Optional[str] = None,
    impact: Optional[str] = None,
):
    user = await get_current_user(teno_session)
    if not user:
        return RedirectResponse("/login", status_code=302)

    db = await get_db()
    try:
        state = await _get_user_rehab_state(user, db)
        exercises = state["lib_exercises"]

        # Exercise-library-specific: calf raise + hop functional measures (not needed by other pages)
        cursor = await db.execute(
            "SELECT * FROM onboarding_assessments WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
            (user["id"],),
        )
        onboarding_row = await cursor.fetchone()
    finally:
        await db.close()

    current_irritability = state["current_irritability"]
    current_stage = state["current_stage"]
    is_insertional = state["is_insertional"]
    wblt_cm = state["wblt_cm"]
    wblt_cm_unaffected = state["wblt_cm_unaffected"]
    wblt_result = state["wblt_result"]

    calf_raise_reps = None
    calf_raise_reps_unaffected = None
    single_leg_hop_cm = None
    double_leg_hop_cm = None
    single_leg_hop_endurance_reps = None
    double_leg_hop_endurance_reps = None

    if onboarding_row:
        o = parse_json_fields(row_to_dict(onboarding_row), ["risk_factors", "functional_tests"])
        ft = o.get("functional_tests", {}) or {}
        if isinstance(ft, str):
            try: ft = json.loads(ft)
            except Exception: ft = {}
        calf_raise_reps = o.get("calf_raise_reps")
        calf_raise_reps_unaffected = ft.get("calf_raise_reps_unaffected")
        single_leg_hop_cm = ft.get("single_leg_hop_cm")
        double_leg_hop_cm = ft.get("double_leg_hop_cm")
        single_leg_hop_endurance_reps = ft.get("single_leg_hop_endurance_reps")
        double_leg_hop_endurance_reps = ft.get("double_leg_hop_endurance_reps")

    def _lsi(affected, unaffected):
        try:
            return round((float(affected) / float(unaffected)) * 100)
        except (TypeError, ZeroDivisionError):
            return None

    calf_raise_lsi = _lsi(calf_raise_reps, calf_raise_reps_unaffected)
    hop_distance_lsi = _lsi(single_leg_hop_cm, double_leg_hop_cm)
    hop_endurance_lsi = _lsi(single_leg_hop_endurance_reps, double_leg_hop_endurance_reps)

    # Build exercise map for progression/regression lookups
    ex_map = {ex["ex_id"]: ex for ex in exercises}

    # Recommended loading exercises for this patient (exclude flexibility_mobility from general recs)
    loading_exercises = [ex for ex in exercises if ex.get("category") != "flexibility_mobility"]
    recommended_ids = {
        ex["ex_id"] for ex in select_initial_exercises(
            loading_exercises, current_irritability, current_stage, is_insertional, limit=6
        )
    }

    # Recommended stretch exercises based on WBLT
    stretch_recs = select_stretch_exercises(exercises, wblt_result, is_insertional)
    for ex in stretch_recs:
        recommended_ids.add(ex["ex_id"])

    # Build enriched top-recommendations list with reasons from each rule engine signal
    _LOADING_REASON = {
        "symptom_modulation": "Symptom modulation — isometric loading reduces pain without provocative stress",
        "slow_strength":      "Slow strength loading — primary tendon adaptation driver for your current stage",
        "eccentric_loading":  "Eccentric loading — targeted tendon remodelling and stiffness development",
        "heavy_dynamic":      "Heavy dynamic loading — maximum tendon load capacity development",
        "fast_dynamic":       "Fast dynamic loading — bridging slow strength to reactive demands",
        "reactive_plyometric":"Reactive strength — energy storage and return capacity",
        "running_sport_reentry": "Running re-entry — progressive return to sport loading",
        "accessory":          "Accessory — impairment-targeted support work",
    }
    _IRRITABILITY_REASON = {
        "high":     "High irritability — only low-load, pain-modulating exercises selected",
        "moderate": "Moderate irritability — graduated loading with pain monitoring",
        "low":      "Low irritability — full progressive loading appropriate",
    }
    _STRETCH_REASON = {
        "primary": "WBLT {val} cm — severe dorsiflexion restriction, stretching is a primary impairment target",
        "adjunct": "WBLT {val} cm — dorsiflexion restriction present, stretching included as adjunct",
    }

    top_recommendations = []

    # Loading exercises — up to 4, with per-exercise reason
    loading_recs = select_initial_exercises(
        loading_exercises, current_irritability, current_stage, is_insertional, limit=4
    )
    for ex in loading_recs:
        cat_reason = _LOADING_REASON.get(ex.get("category", ""), "Selected based on current rehab stage")
        irr_reason = _IRRITABILITY_REASON.get(current_irritability, "")
        insertional_note = " Insertional-safe variant selected." if is_insertional and ex.get("insertional_safe") else ""
        top_recommendations.append({
            "exercise":  ex,
            "reason":    cat_reason + insertional_note,
            "sub_reason": irr_reason,
            "badge":     "loading",
        })

    # Stretch exercises — up to 2 if indicated (avoids overwhelming the section)
    for ex in stretch_recs[:2]:
        priority = wblt_result.get("stretch_priority", "adjunct")
        val_str = f"{wblt_cm:.0f}" if wblt_cm else "?"
        stretch_reason = _STRETCH_REASON.get(priority, "").format(val=val_str)
        insertional_note = " Bent-knee / non-weight-bearing variant — safe for insertional presentation." if is_insertional else ""
        top_recommendations.append({
            "exercise":  ex,
            "reason":    stretch_reason + insertional_note,
            "sub_reason": "Restricted dorsiflexion increases cumulative Achilles tendon load during gait",
            "badge":     "stretch",
        })

    # Apply UI filters
    filtered = exercises
    if irritability:
        filtered = [ex for ex in filtered if irritability in ex.get("irritability_appropriateness", [])]
    if category:
        filtered = [ex for ex in filtered if ex.get("category") == category]
    if insertional_only == "1":
        filtered = [ex for ex in filtered if ex.get("insertional_safe")]
    if impact:
        filtered = [ex for ex in filtered if ex.get("impact_level") == impact]

    # Group by category for display
    CATEGORY_LABELS = {
        "symptom_modulation":    "Symptom Modulation / Low-Load Tolerance",
        "slow_strength":         "Slow Strength Loading",
        "eccentric_loading":     "Eccentric-Biased Loading",
        "heavy_dynamic":         "Heavy Dynamic Loading",
        "fast_dynamic":          "Fast Dynamic Loading",
        "reactive_plyometric":   "Reactive Strength / Plyometric Loading",
        "running_sport_reentry": "Running / Sport Re-entry",
        "accessory":             "Accessory & Impairment-Targeted Work",
        "flexibility_mobility":  "Flexibility & Mobility (WBLT-Indicated)",
    }
    CATEGORY_ORDER = list(CATEGORY_LABELS.keys())

    grouped: dict[str, list[dict]] = {cat: [] for cat in CATEGORY_ORDER}
    for ex in filtered:
        cat = ex.get("category", "accessory")
        if cat in grouped:
            grouped[cat].append(ex)

    return templates.TemplateResponse(
        request, "exercise_library.html",
        context={
            "user": user,
            "exercises": filtered,
            "grouped": grouped,
            "ex_map": ex_map,
            "category_labels": CATEGORY_LABELS,
            "category_order": CATEGORY_ORDER,
            "recommended_ids": recommended_ids,
            "current_irritability": current_irritability,
            "current_stage": current_stage,
            "is_insertional": is_insertional,
            "total_exercises": len(exercises),
            "filter_irritability": irritability or "",
            "filter_category": category or "",
            "filter_insertional_only": insertional_only or "",
            "filter_impact": impact or "",
            "top_recommendations": top_recommendations,
            "wblt_result": wblt_result,
            "wblt_cm": wblt_cm,
            "wblt_cm_unaffected": wblt_cm_unaffected,
            "stretch_recs": stretch_recs,
            "calf_raise_reps": calf_raise_reps,
            "calf_raise_reps_unaffected": calf_raise_reps_unaffected,
            "calf_raise_lsi": calf_raise_lsi,
            "single_leg_hop_cm": single_leg_hop_cm,
            "double_leg_hop_cm": double_leg_hop_cm,
            "hop_distance_lsi": hop_distance_lsi,
            "single_leg_hop_endurance_reps": single_leg_hop_endurance_reps,
            "double_leg_hop_endurance_reps": double_leg_hop_endurance_reps,
            "hop_endurance_lsi": hop_endurance_lsi,
            "has_onboarding": state["has_onboarding"],
        },
    )
