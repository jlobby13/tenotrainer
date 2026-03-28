"""
TenoTrainer — Achilles Tendinopathy Rehabilitation Assistant
FastAPI application entry point.

Run with: uvicorn app.main:app --reload
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import aiosqlite
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
# Session helpers
# ---------------------------------------------------------------------------

SESSION_COOKIE = "teno_session"
DEMO_USER_NAME = "Demo User"


async def get_or_create_user(session_token: Optional[str], response: Response) -> dict:
    """
    Return the user dict for the session token.
    If no valid session, create a demo user and set cookie.
    """
    db = await get_db()
    try:
        user = None
        if session_token:
            cursor = await db.execute(
                "SELECT * FROM users WHERE session_token = ?", (session_token,)
            )
            row = await cursor.fetchone()
            if row:
                user = row_to_dict(row)

        if not user:
            # Create new demo user
            token = secrets.token_urlsafe(32)
            await db.execute(
                "INSERT INTO users (name, email, role, session_token) VALUES (?, ?, ?, ?)",
                (DEMO_USER_NAME, None, "patient", token),
            )
            await db.commit()
            cursor = await db.execute(
                "SELECT * FROM users WHERE session_token = ?", (token,)
            )
            row = await cursor.fetchone()
            user = row_to_dict(row)
            response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax")

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
):
    user = await get_or_create_user(teno_session, response)
    return templates.TemplateResponse(
        request, "onboarding.html",
        context={
            "user": user
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
    # Red flags
    red_flags: Optional[str] = Form(default=""),
    # User name update
    user_name: Optional[str] = Form(default=None),
):
    user = await get_or_create_user(teno_session, response)

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
        recent_load_change=bool(int(recent_load_change)),
        risk_factors=risk_factors,
        red_flags=red_flag_list,
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
        await db.execute(
            """INSERT INTO onboarding_assessments
               (user_id, morning_stiffness, pain_at_rest, pain_with_activity, pain_after_activity,
                next_day_pain, calf_raise_reps, injury_duration, recent_load_change,
                risk_factors, stage, irritability)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                user["id"], morning_stiffness, pain_at_rest, pain_with_activity,
                pain_after_activity, next_day_pain, calf_raise_reps, injury_duration,
                int(bool(int(recent_load_change))), json.dumps(risk_factors),
                classification.stage, classification.irritability,
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
            "is_onboarding": True
        },
    )


# ---------------------------------------------------------------------------
# GET /visa-a — VISA-A questionnaire
# ---------------------------------------------------------------------------

@app.get("/visa-a", response_class=HTMLResponse)
async def visa_a_get(
    request: Request,
    response: Response,
    teno_session: Optional[str] = Cookie(default=None),
):
    user = await get_or_create_user(teno_session, response)
    questions = get_questions()
    return templates.TemplateResponse(
        request, "visa_a.html",
        context={
            "user": user, "questions": questions
        },
    )


# ---------------------------------------------------------------------------
# POST /visa-a — Submit VISA-A
# ---------------------------------------------------------------------------

@app.post("/visa-a", response_class=HTMLResponse)
async def visa_a_post(
    request: Request,
    response: Response,
    teno_session: Optional[str] = Cookie(default=None),
):
    user = await get_or_create_user(teno_session, response)
    form = await request.form()
    form_data = dict(form)

    # Score deterministically in visa_a.py — AI never touches this
    result = visa_a_score_from_form(form_data)

    # Store in DB
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO visa_a_responses
               (user_id, q1, q2, q3, q4, q5, q6, q7, q8, total_score)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                user["id"],
                result.q1, result.q2, result.q3, result.q4,
                result.q5, result.q6, result.q7_score, result.q8_score,
                result.total_score,
            ),
        )
        await db.commit()
    finally:
        await db.close()

    questions = get_questions()
    return templates.TemplateResponse(
        request, "visa_a.html",
        context={
            "user": user,
            "questions": questions,
            "result": result,
            "show_result": True
        },
    )


# ---------------------------------------------------------------------------
# GET /dashboard
# ---------------------------------------------------------------------------

@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard(
    request: Request,
    response: Response,
    teno_session: Optional[str] = Cookie(default=None),
):
    user = await get_or_create_user(teno_session, response)

    db = await get_db()
    try:
        # Current plan (most recent)
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

        # VISA-A history
        cursor = await db.execute(
            "SELECT total_score, created_at FROM visa_a_responses WHERE user_id = ? ORDER BY created_at ASC",
            (user["id"],),
        )
        visa_rows = await cursor.fetchall()
        visa_history = [row_to_dict(r) for r in visa_rows]

        # Onboarding data (most recent)
        cursor = await db.execute(
            "SELECT * FROM onboarding_assessments WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
            (user["id"],),
        )
        onboarding_row = await cursor.fetchone()
        onboarding = None
        if onboarding_row:
            onboarding = parse_json_fields(row_to_dict(onboarding_row), ["risk_factors"])

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
            "labels": [f"Session {i+1}" for i in range(len(chart_logs))],
            "during": [l["pain_during"] for l in chart_logs],
            "after": [l["pain_after"] for l in chart_logs],
            "next_day": [l["next_day_pain"] for l in chart_logs],
        }

    finally:
        await db.close()

    return templates.TemplateResponse(
        request, "dashboard.html",
        context={
            "user": user,
            "current_plan": current_plan,
            "recent_logs": recent_logs,
            "visa_history": visa_history,
            "onboarding": onboarding,
            "progression_history": progression_history,
            "pain_chart_data": json.dumps(pain_chart_data),
            "has_onboarding": onboarding is not None
        },
    )


# ---------------------------------------------------------------------------
# GET /daily-log
# ---------------------------------------------------------------------------

@app.get("/daily-log", response_class=HTMLResponse)
async def daily_log_get(
    request: Request,
    response: Response,
    teno_session: Optional[str] = Cookie(default=None),
):
    user = await get_or_create_user(teno_session, response)
    return templates.TemplateResponse(
        request, "daily_log.html",
        context={
            "user": user
        },
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
    next_day_pain: int = Form(...),
    difficulty: int = Form(...),
    confidence: int = Form(...),
    notes: Optional[str] = Form(default=""),
    red_flag_notes: Optional[str] = Form(default=""),
):
    user = await get_or_create_user(teno_session, response)

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

        if plan_row:
            p = row_to_dict(plan_row)
            current_stage = p["stage"]
            current_irritability = p["irritability"]
            plan_id = p["id"]

        if onboarding_row:
            o = parse_json_fields(row_to_dict(onboarding_row), ["risk_factors"])
            baseline_reps = o.get("calf_raise_reps", 0)
            conservative_bias = has_conservative_bias(o.get("risk_factors", []))

        # Update irritability from new log
        new_irritability = update_irritability_from_log(pain_during, pain_after, next_day_pain)

        # Run progression decision engine
        progression = run_decision_engine(
            recent_logs=all_logs[-8:],
            current_stage=current_stage,
            current_irritability=new_irritability,
            calf_raise_reps_baseline=baseline_reps,
            calf_raise_reps_current=baseline_reps,  # Updated at reassessment
            conservative_bias=conservative_bias,
        )

        # Save log
        await db.execute(
            """INSERT INTO daily_logs
               (user_id, session_id, pain_during, pain_after, next_day_pain, difficulty, confidence, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (user["id"], plan_id, pain_during, pain_after, next_day_pain, difficulty, confidence, notes),
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

    return templates.TemplateResponse(
        request, "daily_log.html",
        context={
            "user": user,
            "submitted": True,
            "progression": progression,
            "new_irritability": new_irritability,
            "pain_during": pain_during,
            "pain_after": pain_after,
            "next_day_pain": next_day_pain
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
