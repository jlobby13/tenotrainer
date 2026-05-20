"""
TenoTrainer — Supervisor System (MVP Phase 1)

Provides a read-only view of assigned patients: status dashboard,
session metrics, program comparison, and auto-generated alerts.

Alert types:
  pain        — pain_during ≥ 7 (high) OR increased ≥ 2 vs recent avg (medium)
  compliance  — overall_compliance < 30% (high) OR < 60% (medium)
  inactivity  — no session in > 5 days (medium)
  comment     — patient left a note on their session log (low)

All supervisor actions are appended to supervisor_audit_logs.
Rule engine outputs are never modified.
"""

from __future__ import annotations

import json
import secrets
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Cookie, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from app.db.database import get_db, parse_json_fields, row_to_dict
from app.notifier import send_dismissal_email

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


def _fmt_date(value: str) -> str:
    """YYYY-MM-DD[...] → MM-DD-YYYY, preserving HH:MM if present."""
    if not value:
        return value or ""
    try:
        s = str(value).strip()
        y, m, d = s[:10].split("-")
        date_part = f"{m}-{d}-{y}"
        rest = s[10:].lstrip("T ").strip()
        time_part = rest[:5] if rest else ""
        return f"{date_part} {time_part}".strip() if time_part else date_part
    except Exception:
        return str(value)


templates.env.filters["fmt_date"] = _fmt_date


def _fmt_alert_date(dt_str: str) -> str:
    """'2024-06-05T14:30:00' → '2:30 PM 06-05-2024'"""
    try:
        s = (dt_str or "").strip()[:19].replace("T", " ")
        dt = datetime.fromisoformat(s)
        hour = dt.hour % 12 or 12
        ampm = "AM" if dt.hour < 12 else "PM"
        return f"{hour}:{dt.minute:02d} {ampm} {dt.month:02d}-{dt.day:02d}-{dt.year}"
    except Exception:
        return (dt_str or "")

router = APIRouter()


# ---------------------------------------------------------------------------
# Auth helper
# ---------------------------------------------------------------------------

async def _get_supervisor(session_token: Optional[str]) -> Optional[dict]:
    """Return the user dict for supervisors and superusers."""
    if not session_token:
        return None
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT * FROM users WHERE session_token = ? AND role IN ('supervisor', 'superuser')",
            (session_token,),
        )
        row = await cur.fetchone()
        return row_to_dict(row) if row else None
    finally:
        await db.close()


# ---------------------------------------------------------------------------
# Audit log helper
# ---------------------------------------------------------------------------

async def _audit(user_id: int, action_type: str, target_patient_id: Optional[int] = None,
                 changes: dict | None = None, note: Optional[str] = None) -> None:
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO supervisor_audit_logs (user_id, action_type, target_patient_id, changes, note) "
            "VALUES (?, ?, ?, ?, ?)",
            (user_id, action_type, target_patient_id, json.dumps(changes or {}), note),
        )
        await db.commit()
    finally:
        await db.close()


# ---------------------------------------------------------------------------
# Alert generation (called from main.py after session log submission)
# ---------------------------------------------------------------------------

async def generate_session_alerts(
    user_id: int,
    log_id: int,
    pain_during: int,
    overall_compliance: Optional[int],
    recent_logs: list[dict],
    session_notes: Optional[str] = None,
) -> None:
    """
    Generate supervisor alerts after a patient session is submitted.
    This is NON-DESTRUCTIVE — rule engine outputs are never touched.
    """
    db = await get_db()
    try:
        # ── Patient comment alert ────────────────────────────────────────────
        if session_notes and session_notes.strip():
            preview = session_notes.strip()[:120]
            if len(session_notes.strip()) > 120:
                preview += "…"
            await db.execute(
                "INSERT INTO supervisor_alerts (patient_id, log_id, type, severity, message) "
                "VALUES (?, ?, ?, ?, ?)",
                (user_id, log_id, "comment", "low",
                 f"Patient left a session note: \"{preview}\""),
            )

        # ── Pain alert ──────────────────────────────────────────────────────
        if pain_during >= 7:
            await db.execute(
                "INSERT INTO supervisor_alerts (patient_id, log_id, type, severity, message) "
                "VALUES (?, ?, ?, ?, ?)",
                (user_id, log_id, "pain", "high",
                 f"Pain during session: {pain_during}/10 — exceeds critical threshold (≥7)."),
            )
        else:
            # Compare against recent 5-session average
            recent_pain = [
                r["pain_during"] for r in recent_logs[-5:]
                if r.get("pain_during") is not None
            ]
            if len(recent_pain) >= 2:
                avg = sum(recent_pain) / len(recent_pain)
                if pain_during - avg >= 2:
                    await db.execute(
                        "INSERT INTO supervisor_alerts (patient_id, log_id, type, severity, message) "
                        "VALUES (?, ?, ?, ?, ?)",
                        (user_id, log_id, "pain", "medium",
                         f"Pain during session: {pain_during}/10 — increased ≥2 points vs "
                         f"recent average ({avg:.1f}/10)."),
                    )

        # ── Compliance alert ────────────────────────────────────────────────
        if overall_compliance is not None:
            if overall_compliance < 30:
                await db.execute(
                    "INSERT INTO supervisor_alerts (patient_id, log_id, type, severity, message) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (user_id, log_id, "compliance", "high",
                     f"Session compliance: {overall_compliance}% — critically low (< 30%)."),
                )
            elif overall_compliance < 60:
                await db.execute(
                    "INSERT INTO supervisor_alerts (patient_id, log_id, type, severity, message) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (user_id, log_id, "compliance", "medium",
                     f"Session compliance: {overall_compliance}% — below target (< 60%)."),
                )

        await db.commit()
    finally:
        await db.close()


# ---------------------------------------------------------------------------
# Inactivity alert check
# ---------------------------------------------------------------------------

async def _check_inactivity(patient_id: int) -> None:
    """
    Create or resolve inactivity alerts for a patient.
    Called on dashboard/profile load (not on session submission).
    """
    db = await get_db()
    try:
        cutoff = (datetime.utcnow() - timedelta(days=5)).isoformat()
        cur = await db.execute(
            "SELECT created_at FROM daily_logs WHERE user_id = ? "
            "ORDER BY created_at DESC LIMIT 1",
            (patient_id,),
        )
        row = await cur.fetchone()
        last_session = row[0] if row else None

        if last_session is None or last_session < cutoff:
            # Check if unresolved inactivity alert already exists
            cur2 = await db.execute(
                "SELECT id FROM supervisor_alerts WHERE patient_id = ? "
                "AND type = 'inactivity' AND resolved = 0 LIMIT 1",
                (patient_id,),
            )
            existing = await cur2.fetchone()
            if not existing:
                days_inactive = (
                    int((datetime.utcnow() - datetime.fromisoformat(last_session)).days)
                    if last_session else None
                )
                msg = (
                    f"No session logged in {days_inactive} days."
                    if days_inactive is not None
                    else "No sessions recorded yet."
                )
                await db.execute(
                    "INSERT INTO supervisor_alerts (patient_id, log_id, type, severity, message) "
                    "VALUES (?, NULL, ?, ?, ?)",
                    (patient_id, "inactivity", "medium", msg),
                )
                await db.commit()
        else:
            # Patient has been active — resolve any open inactivity alerts
            await db.execute(
                "UPDATE supervisor_alerts SET resolved = 1, resolved_at = ? "
                "WHERE patient_id = ? AND type = 'inactivity' AND resolved = 0",
                (datetime.utcnow().isoformat(), patient_id),
            )
            await db.commit()
    finally:
        await db.close()


# ---------------------------------------------------------------------------
# Data helpers
# ---------------------------------------------------------------------------

_DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


async def _get_schedule_range(
    patient_ids: list[int],
    start_date,   # datetime.date — always a Monday
    num_days: int,  # 7, 14, 21, or 28
    offset: int = 0,
) -> dict:
    """
    Return per-day session counts and patient lists for an arbitrary date range
    starting on `start_date` (a Monday) and spanning `num_days` days.
    """
    from datetime import date as _date

    today = datetime.utcnow().date()
    range_end_date = start_date + timedelta(days=num_days - 1)
    range_end = range_end_date.isoformat()
    start_iso = start_date.isoformat()

    scheduled_by_day: dict[int, list] = {i: [] for i in range(num_days)}
    completed_by_day: dict[int, list] = {i: [] for i in range(num_days)}

    if patient_ids:
        db = await get_db()
        try:
            placeholders = ",".join("?" * len(patient_ids))

            # Patient names
            cur = await db.execute(
                f"SELECT id, name FROM users WHERE id IN ({placeholders})",
                patient_ids,
            )
            rows = await cur.fetchall()
            patient_names = {r[0]: r[1] for r in rows}

            # Collect all Monday week_start values in the range
            week_mondays = [
                (start_date + timedelta(weeks=w)).isoformat()
                for w in range(num_days // 7)
            ]
            mondays_ph = ",".join("?" * len(week_mondays))

            # Week-specific overrides for every Monday in the range
            cur = await db.execute(
                f"SELECT user_id, week_start, session_days FROM schedule_overrides "
                f"WHERE user_id IN ({placeholders}) AND week_start IN ({mondays_ph})",
                (*patient_ids, *week_mondays),
            )
            # scheduled_per_week[week_start_iso][user_id] = session_days_json
            scheduled_per_week: dict[str, dict[int, str]] = {m: {} for m in week_mondays}
            for r in await cur.fetchall():
                uid, ws, sd = r[0], r[1], r[2]
                if ws in scheduled_per_week:
                    scheduled_per_week[ws][uid] = sd

            # For patients missing an override for a given week, fall back to
            # their most recent past override (standing schedule).
            # Collect all patient/week combos that need a fallback.
            missing_by_patient: dict[int, list[str]] = {}
            for monday_iso in week_mondays:
                for pid in patient_ids:
                    if pid not in scheduled_per_week[monday_iso]:
                        missing_by_patient.setdefault(pid, []).append(monday_iso)

            if missing_by_patient:
                miss_pids = list(missing_by_patient.keys())
                miss_ph = ",".join("?" * len(miss_pids))
                # Fallback: most recent past override up to start_date
                cur = await db.execute(
                    f"SELECT user_id, session_days FROM schedule_overrides "
                    f"WHERE user_id IN ({miss_ph}) AND week_start <= ? "
                    f"GROUP BY user_id HAVING week_start = MAX(week_start)",
                    (*miss_pids, start_iso),
                )
                fallback: dict[int, str] = {r[0]: r[1] for r in await cur.fetchall()}
                for pid, weeks in missing_by_patient.items():
                    if pid in fallback:
                        for monday_iso in weeks:
                            scheduled_per_week[monday_iso][pid] = fallback[pid]

            # Map each (week, session_day_idx) → list of patients scheduled
            for w_idx, monday_iso in enumerate(week_mondays):
                base_offset = w_idx * 7
                for uid, raw in scheduled_per_week[monday_iso].items():
                    for idx in (json.loads(raw) if raw else []):
                        if 0 <= idx <= 6:
                            day_slot = base_offset + idx
                            if day_slot < num_days:
                                scheduled_by_day[day_slot].append(
                                    {"id": uid, "name": patient_names.get(uid, "")}
                                )

            # Completed sessions within the full date range
            cur = await db.execute(
                f"SELECT user_id, DATE(created_at) FROM daily_logs "
                f"WHERE user_id IN ({placeholders}) "
                f"AND DATE(created_at) >= ? AND DATE(created_at) <= ?",
                (*patient_ids, start_iso, range_end),
            )
            for r in await cur.fetchall():
                uid, log_date = r[0], r[1]
                try:
                    diff = (_date.fromisoformat(log_date) - start_date).days
                    if 0 <= diff < num_days:
                        completed_by_day[diff].append(
                            {"id": uid, "name": patient_names.get(uid, "")}
                        )
                except Exception:
                    pass
        finally:
            await db.close()

    days = []
    for i in range(num_days):
        d = start_date + timedelta(days=i)
        days.append({
            "date": d.isoformat(),
            "label": _DAY_LABELS[d.weekday()],
            "day_num": d.day,
            "month_abbr": d.strftime("%b"),
            "col_idx": i % 7,
            "is_today": d == today,
            "is_past": d < today,
            "scheduled": scheduled_by_day[i],
            "completed": completed_by_day[i],
        })

    return {
        "days": days,
        "today": today.isoformat(),
        "num_days": num_days,
        "offset": offset,
    }


async def _get_weekly_schedule(patient_ids: list[int]) -> dict:
    """Return per-day session counts and patient lists for the current week."""
    today = datetime.utcnow().date()
    week_start_date = today - timedelta(days=today.weekday())  # Monday
    week_start = week_start_date.isoformat()

    result = await _get_schedule_range(patient_ids, week_start_date, 7, offset=0)

    # Re-attach legacy fields so existing template code keeps working
    for day in result["days"]:
        day["index"] = result["days"].index(day)

    return {"week_start": week_start, "days": result["days"]}


_REVIEW_WINDOW_MIN_DAYS = 42  # 6 weeks — review window opens
_REVIEW_WINDOW_MAX_DAYS = 56  # 8 weeks — review window closes (overdue after this)
_NOTICE_DAYS = 14             # show patients 14 days before window opens


async def _get_program_reviews(patient_ids: list[int]) -> list[dict]:
    """Return patients approaching or past their 6–8 week program review window."""
    today = datetime.utcnow().date()
    results = []
    if not patient_ids:
        return results

    db = await get_db()
    try:
        placeholders = ",".join("?" * len(patient_ids))
        cur = await db.execute(
            f"SELECT u.id, u.name, MAX(oa.created_at) AS last_assessed "
            f"FROM users u "
            f"LEFT JOIN onboarding_assessments oa ON oa.user_id = u.id "
            f"WHERE u.id IN ({placeholders}) "
            f"GROUP BY u.id, u.name",
            patient_ids,
        )
        for r in await cur.fetchall():
            uid, name, last_assessed = r[0], r[1], r[2]
            if not last_assessed:
                results.append({
                    "id": uid, "name": name,
                    "last_assessed": None,
                    "days_since": None,
                    "days_remaining": 0,
                    "pct": 100,
                    "status": "overdue",
                    "sort_key": -999999,
                    "review_date": "0000-00-00",
                })
                continue
            last_date = datetime.fromisoformat(last_assessed[:10]).date()
            days_since = (today - last_date).days
            review_date = (last_date + timedelta(days=_REVIEW_WINDOW_MIN_DAYS)).isoformat()
            notice_start = _REVIEW_WINDOW_MIN_DAYS - _NOTICE_DAYS
            if days_since > _REVIEW_WINDOW_MAX_DAYS:
                status = "overdue"
                days_remaining = 0
                pct = 100
            elif days_since >= _REVIEW_WINDOW_MIN_DAYS:
                # Inside the 6–8 week review window
                status = "in_window"
                days_remaining = _REVIEW_WINDOW_MAX_DAYS - days_since
                pct = 100
            elif days_since >= notice_start:
                # Approaching window — fill bar from 0% to 100% over the notice period
                days_remaining = _REVIEW_WINDOW_MIN_DAYS - days_since
                pct = max(0, min(100, round((1 - days_remaining / _NOTICE_DAYS) * 100)))
                status = "due_soon"
            else:
                continue  # not yet in the notice window — skip
            # sort_key: lower = more urgent (negative for overdue, positive for upcoming)
            sort_key = _REVIEW_WINDOW_MAX_DAYS - days_since
            results.append({
                "id": uid, "name": name,
                "last_assessed": last_assessed[:10],
                "days_since": days_since,
                "days_remaining": days_remaining,
                "pct": pct,
                "status": status,
                "sort_key": sort_key,
                "review_date": review_date,
            })
    finally:
        await db.close()

    _status_order = {"overdue": 0, "in_window": 1, "due_soon": 2}
    results.sort(key=lambda r: (_status_order.get(r["status"], 3), -r["pct"], r["name"]))
    return results


async def _get_patient_summary(patient_id: int) -> dict:
    """Fetch summary data for one patient (used on dashboard rows)."""
    db = await get_db()
    try:
        # Basic user info
        cur = await db.execute(
            "SELECT id, name, email, injury_sides, previous_history, seen_by_provider, seen_by_provider_notes FROM users WHERE id = ?",
            (patient_id,),
        )
        row = await cur.fetchone()
        if not row:
            return {}
        try:
            _sides = json.loads(row[3] or "[]") or []
        except Exception:
            _sides = []
        p = {
            "id": row[0], "name": row[1], "email": row[2] or "",
            "injury_sides_list": _sides,
            "previous_history": row[4],
            "seen_by_provider": row[5] or 0,
            "seen_by_provider_notes": row[6],
        }

        # Latest assessment → stage + irritability
        cur = await db.execute(
            "SELECT stage, irritability FROM onboarding_assessments "
            "WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
            (patient_id,),
        )
        row = await cur.fetchone()
        p["stage"] = row[0] if row else None
        p["irritability"] = row[1] if row else None

        # Last session date + sessions in last 28 days
        cutoff_28 = (datetime.utcnow() - timedelta(days=28)).isoformat()
        cur = await db.execute(
            "SELECT created_at FROM daily_logs WHERE user_id = ? "
            "ORDER BY created_at DESC LIMIT 1",
            (patient_id,),
        )
        row = await cur.fetchone()
        p["last_session_date"] = (row[0][:10] if row else None)

        cur = await db.execute(
            "SELECT COUNT(*) FROM daily_logs WHERE user_id = ? AND created_at >= ?",
            (patient_id, cutoff_28),
        )
        row = await cur.fetchone()
        sessions_28d = row[0] if row else 0
        p["sessions_28d"] = sessions_28d

        # Adherence % — sessions_28d vs expected (irritability-based: HIGH→2/wk, else→3/wk)
        expected_per_week = 2 if (p["irritability"] or "").lower() == "high" else 3
        expected_28d = expected_per_week * 4
        p["adherence_pct"] = min(100, round(sessions_28d / expected_28d * 100)) if expected_28d else None

        # Alert count + max severity + individual alerts for hover display
        cur = await db.execute(
            "SELECT id, type, severity, message, created_at FROM supervisor_alerts "
            "WHERE patient_id = ? AND resolved = 0 ORDER BY "
            "CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC",
            (patient_id,),
        )
        alert_rows = list(await cur.fetchall())
        p["alert_count"] = len(alert_rows)
        p["alerts"] = [
            {"id": r[0], "type": r[1], "severity": r[2], "message": r[3],
             "created_at": _fmt_alert_date(r[4])}
            for r in alert_rows
        ]
        severities = [a["severity"] for a in p["alerts"]]
        if "high" in severities:
            p["max_severity"] = "high"
        elif "medium" in severities:
            p["max_severity"] = "medium"
        elif "low" in severities:
            p["max_severity"] = "low"
        else:
            p["max_severity"] = None

        # Status flag
        cutoff_inactive = (datetime.utcnow() - timedelta(days=5)).isoformat()
        last_raw = p["last_session_date"]  # "YYYY-MM-DD" or None
        is_inactive = (last_raw is None) or (last_raw < cutoff_inactive[:10])
        if is_inactive:
            p["status"] = "inactive"
        elif p["max_severity"] == "high":
            p["status"] = "red"
        elif p["max_severity"] in ("medium", "low"):
            p["status"] = "yellow"
        else:
            p["status"] = "green"

        return p
    finally:
        await db.close()


def _calc_bmi(height_cm, weight_kg) -> Optional[dict]:
    """Return BMI data dict or None if either measurement is missing."""
    if not height_cm or not weight_kg:
        return None
    h_m = height_cm / 100
    bmi = round(weight_kg / (h_m * h_m), 1)
    if bmi < 16.0:
        cat, color = "Severely underweight", "blue"
    elif bmi < 18.5:
        cat, color = "Underweight", "sky"
    elif bmi < 25.0:
        cat, color = "Normal weight", "green"
    elif bmi < 30.0:
        cat, color = "Overweight", "yellow"
    elif bmi < 35.0:
        cat, color = "Obese — Class I", "orange"
    elif bmi < 40.0:
        cat, color = "Obese — Class II", "red"
    else:
        cat, color = "Obese — Class III", "red"
    pct = max(2, min(98, round((bmi - 15) / 30 * 100)))
    total_in = height_cm / 2.54
    return {
        "value": bmi,
        "category": cat,
        "color": color,
        "pct": pct,
        "height_ft": int(total_in // 12),
        "height_in": round(total_in % 12, 1),
        "weight_lbs": round(weight_kg * 2.20462, 1),
    }


def _short_date(dt_str: str) -> str:
    """'2024-06-05 10:00:00' → 'Jun 5'"""
    try:
        from datetime import datetime as _dt
        d = _dt.fromisoformat((dt_str or "")[:10])
        return d.strftime("%b ") + str(d.day)
    except Exception:
        return (dt_str or "")[:10]


async def _get_patient_detail(patient_id: int, supervisor_id: Optional[int] = None) -> dict:
    """Fetch full detail for patient profile page."""
    db = await get_db()
    try:
        # Basic user info
        cur = await db.execute(
            "SELECT id, name, email, created_at, injury_sides, previous_history, seen_by_provider, seen_by_provider_notes,"
            " age, sex, height_cm, weight_kg, affected_side, activity_level, sports, condition_timeline"
            " FROM users WHERE id = ?",
            (patient_id,),
        )
        row = await cur.fetchone()
        if not row:
            return {}
        try:
            _sides = json.loads(row[4] or "[]") or []
        except Exception:
            _sides = []
        p = {
            "id": row[0], "name": row[1], "email": row[2] or "",
            "member_since": (row[3] or "")[:10],
            "injury_sides_list": _sides,
            "previous_history": row[5],
            "seen_by_provider": row[6] or 0,
            "seen_by_provider_notes": row[7],
            "age": row[8],
            "sex": row[9],
            "height_cm": row[10],
            "weight_kg": row[11],
            "affected_side": row[12],
            "activity_level": row[13],
            "sports": row[14],
            "condition_timeline": row[15],
        }
        p["bmi_data"] = _calc_bmi(p["height_cm"], p["weight_kg"])

        # Latest assessment
        cur = await db.execute(
            "SELECT stage, irritability, pain_with_activity, next_day_pain, calf_raise_reps, created_at "
            "FROM onboarding_assessments WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
            (patient_id,),
        )
        row = await cur.fetchone()
        if row:
            p["stage"] = row[0]
            p["irritability"] = row[1]
            p["baseline_pain"] = row[2]
            p["baseline_next_day"] = row[3]
            p["baseline_reps"] = row[4]
            p["assessed_at"] = (row[5] or "")[:10]
        else:
            p["stage"] = None
            p["irritability"] = None
            p["baseline_pain"] = None
            p["baseline_next_day"] = None
            p["baseline_reps"] = None
            p["assessed_at"] = None

        # Recent sessions (20 for chart + table)
        cur = await db.execute(
            "SELECT id, created_at, pain_during, pain_after, next_day_pain, "
            "morning_stiffness, notes, exercise_log "
            "FROM daily_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
            (patient_id,),
        )
        rows = await cur.fetchall()
        sessions = []
        for r in rows:
            ex_log = {}
            try:
                ex_log = json.loads(r[7]) if r[7] else {}
            except Exception:
                pass
            # overall_compliance lives inside the exercise_log JSON, not as a column
            compliance = ex_log.get("overall_compliance")
            sessions.append({
                "log_id": r[0],
                "date": (r[1] or "")[:10],
                "pain_during": r[2],
                "pain_after": r[3],
                "next_day_pain": r[4],
                "morning_stiffness": r[5],
                "compliance": compliance,
                "notes": r[6] or "",
                "exercise_log": ex_log,
                "supervisor_comment": "",
            })
        table_sessions = sessions[:8]  # table shows last 8

        # Attach supervisor comments to table sessions
        if supervisor_id and table_sessions:
            log_ids = [s["log_id"] for s in table_sessions]
            placeholders = ",".join("?" * len(log_ids))
            cur = await db.execute(
                f"SELECT daily_log_id, comment FROM supervisor_session_comments "
                f"WHERE supervisor_id = ? AND daily_log_id IN ({placeholders})",
                [supervisor_id, *log_ids],
            )
            comment_rows = await cur.fetchall()
            comment_map = {r[0]: r[1] for r in comment_rows}
            for s in table_sessions:
                s["supervisor_comment"] = comment_map.get(s["log_id"]) or ""

        p["recent_sessions"] = table_sessions

        # Pain/stiffness chart data (chronological order)
        chart_sessions = list(reversed(sessions))
        p["pain_chart_data"] = {
            "labels": [_short_date(s["date"]) for s in chart_sessions],
            "dates":  [s["date"] for s in chart_sessions],
            "during": [s["pain_during"] for s in chart_sessions],
            "after": [s["pain_after"] for s in chart_sessions],
            "next_day": [s["next_day_pain"] for s in chart_sessions],
        }
        p["stiffness_chart_data"] = {
            "labels": [_short_date(s["date"]) for s in chart_sessions],
            "dates":  [s["date"] for s in chart_sessions],
            "stiffness": [s["morning_stiffness"] for s in chart_sessions],
        }

        # VISA-A history
        cur = await db.execute(
            "SELECT total_score, created_at FROM visa_a_responses WHERE user_id = ? ORDER BY created_at ASC",
            (patient_id,),
        )
        visa_rows = await cur.fetchall()
        p["visa_history"] = [{"total_score": r[0], "created_at": r[1]} for r in visa_rows]
        p["visa_labels"] = [_short_date(r[1]) for r in visa_rows]
        p["visa_dates"]  = [(r[1] or "")[:10] for r in visa_rows]

        # All onboarding assessments for functional capacity charts
        cur = await db.execute(
            "SELECT created_at, calf_raise_reps, functional_tests FROM onboarding_assessments "
            "WHERE user_id = ? ORDER BY created_at ASC",
            (patient_id,),
        )
        all_ob_rows = await cur.fetchall()

        def _safe_ft(raw: str) -> dict:
            try:
                return json.loads(raw or "{}")
            except (json.JSONDecodeError, TypeError):
                return {}

        def _lsi(affected, unaffected):
            if affected is not None and unaffected and float(unaffected) > 0:
                return round(float(affected) / float(unaffected) * 100, 1)
            return None

        fc_labels, fc_dates, cr_aff, cr_unaff, cr_lsi = [], [], [], [], []
        wblt_aff, wblt_unaff, wblt_lsi = [], [], []
        hop_d, hop_s, hop_su, hop_lsi = [], [], [], []
        hop_end_d, hop_end_s, hop_end_su, hop_end_lsi = [], [], [], []

        for ob in all_ob_rows:
            ft = _safe_ft(ob[2])
            fc_labels.append(_short_date(ob[0]))
            fc_dates.append((ob[0] or "")[:10])

            ca = ob[1]
            cu = ft.get("calf_raise_reps_unaffected")
            cr_aff.append(ca)
            cr_unaff.append(cu)
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

        p["functional_chart_data"] = {
            "labels": fc_labels,
            "dates":  fc_dates,
            "calf_raise":    {"affected": cr_aff, "unaffected": cr_unaff, "lsi": cr_lsi},
            "wblt":          {"affected": wblt_aff, "unaffected": wblt_unaff, "lsi": wblt_lsi},
            "hop_distance":  {"double": hop_d, "single": hop_s, "unaffected": hop_su, "lsi": hop_lsi},
            "hop_endurance": {"double": hop_end_d, "single": hop_end_s, "unaffected": hop_end_su, "lsi": hop_end_lsi},
        }

        # Aggregate metrics from last 5 sessions
        last5 = sessions[:5]
        pain_vals = [s["pain_during"] for s in last5 if s["pain_during"] is not None]
        comp_vals = [s["compliance"] for s in last5 if s["compliance"] is not None]
        p["avg_pain"] = round(sum(pain_vals) / len(pain_vals), 1) if pain_vals else None
        p["avg_compliance"] = round(sum(comp_vals) / len(comp_vals)) if comp_vals else None

        # Last session date + sessions_28d
        p["last_session_date"] = sessions[0]["date"] if sessions else None
        cutoff_28 = (datetime.utcnow() - timedelta(days=28)).isoformat()
        cur = await db.execute(
            "SELECT COUNT(*) FROM daily_logs WHERE user_id = ? AND created_at >= ?",
            (patient_id, cutoff_28),
        )
        row = await cur.fetchone()
        p["sessions_28d"] = row[0] if row else 0

        # Program comparison: latest session's exercise_log vs current plan's prescriptions
        comparison = []
        latest_ex_log = sessions[0]["exercise_log"] if sessions else {}
        if latest_ex_log and "exercises" in latest_ex_log:
            latest_pain = sessions[0]["pain_during"] if sessions else None
            pain_flag = (
                "stop" if (latest_pain or 0) >= 7
                else "caution" if (latest_pain or 0) >= 4
                else "none"
            )
            for ex in latest_ex_log["exercises"]:
                prescribed = ex.get("prescribed_sets") or 0
                completed = ex.get("sets_done")
                delta = (completed - prescribed) if (completed is not None and prescribed) else None
                comparison.append({
                    "name": ex.get("name", "—"),
                    "prescribed_sets": prescribed,
                    "prescribed_reps": ex.get("prescribed_reps") or "—",
                    "sets_done": completed,
                    "reps_done": ex.get("reps_done") or "—",
                    "sets_compliance": ex.get("sets_compliance"),
                    "delta": delta,
                    "pain_flag": pain_flag,
                })
        p["comparison"] = comparison

        # Unresolved alerts for this patient
        cur = await db.execute(
            "SELECT id, type, severity, message, created_at FROM supervisor_alerts "
            "WHERE patient_id = ? AND resolved = 0 ORDER BY created_at DESC",
            (patient_id,),
        )
        rows = await cur.fetchall()
        p["alerts"] = [
            {
                "id": r[0],
                "type": r[1],
                "severity": r[2],
                "message": r[3],
                "created_at": _fmt_alert_date(r[4]),
            }
            for r in rows
        ]
        p["alert_count"] = len(p["alerts"])

        # Status flag (same logic as summary)
        cutoff_inactive = (datetime.utcnow() - timedelta(days=5)).isoformat()
        is_inactive = (p["last_session_date"] is None) or (p["last_session_date"] < cutoff_inactive[:10])
        severities = [a["severity"] for a in p["alerts"]]
        if is_inactive:
            p["status"] = "inactive"
        elif "high" in severities:
            p["status"] = "red"
        elif "medium" in severities:
            p["status"] = "yellow"
        else:
            p["status"] = "green"

        # Supervisor case notes (versioned — newest first)
        if supervisor_id is not None:
            cur = await db.execute(
                "SELECT id, note, created_at FROM supervisor_case_notes "
                "WHERE patient_id = ? AND supervisor_id = ? ORDER BY created_at DESC",
                (patient_id, supervisor_id),
            )
            note_rows = await cur.fetchall()
            case_notes = [
                {"id": r[0], "note": r[1], "created_at": (r[2] or "")[:10]}
                for r in note_rows
            ]
        else:
            case_notes = []
        p["case_notes_history"] = case_notes
        p["latest_case_note"] = case_notes[0] if case_notes else None

        # Patient's own comments from onboarding assessments (newest first)
        cur = await db.execute(
            "SELECT comments, created_at FROM onboarding_assessments "
            "WHERE user_id = ? AND comments IS NOT NULL AND TRIM(comments) != '' "
            "ORDER BY created_at DESC",
            (patient_id,),
        )
        comment_rows = await cur.fetchall()
        assessment_comments = [
            {"note": r[0], "created_at": (r[1] or "")[:10]}
            for r in comment_rows
        ]
        p["assessment_comments_history"] = assessment_comments
        p["latest_assessment_comment"] = assessment_comments[0] if assessment_comments else None

        return p
    finally:
        await db.close()


async def _get_recent_sessions(patient_ids: list[int]) -> list[dict]:
    """Fetch the 100 most recent sessions across all assigned patients."""
    if not patient_ids:
        return []
    db = await get_db()
    try:
        placeholders = ",".join("?" * len(patient_ids))
        cur = await db.execute(
            f"SELECT dl.user_id, u.name, dl.created_at, dl.pain_during, "
            f"dl.pain_after, dl.morning_stiffness, dl.exercise_log "
            f"FROM daily_logs dl JOIN users u ON dl.user_id = u.id "
            f"WHERE dl.user_id IN ({placeholders}) "
            f"ORDER BY dl.created_at DESC LIMIT 100",
            patient_ids,
        )
        rows = await cur.fetchall()
    finally:
        await db.close()

    sessions = []
    for r in rows:
        ex_log = {}
        try:
            ex_log = json.loads(r[6]) if r[6] else {}
        except Exception:
            pass
        sessions.append({
            "patient_id":       r[0],
            "patient_name":     r[1],
            "date":             (r[2] or "")[:10],
            "pain_during":      r[3],
            "pain_after":       r[4],
            "morning_stiffness": r[5],
            "compliance":       ex_log.get("overall_compliance"),
        })
    return sessions


# ---------------------------------------------------------------------------
# Batch caseload extra metrics
# ---------------------------------------------------------------------------

async def _get_cases_extra(patient_ids: list[int]) -> dict:
    """
    One DB connection, three queries.
    Returns dict[patient_id, {avg_pain_7d, days_in_program, latest_visa}].
    """
    if not patient_ids:
        return {}

    placeholders = ",".join("?" * len(patient_ids))
    result: dict[int, dict] = {pid: {"avg_pain_7d": None, "days_in_program": None, "latest_visa": None}
                                for pid in patient_ids}

    db = await get_db()
    try:
        cutoff_7d = (datetime.utcnow() - timedelta(days=7)).isoformat()

        # avg_pain_7d
        cur = await db.execute(
            f"SELECT user_id, ROUND(AVG(pain_during), 1) FROM daily_logs "
            f"WHERE user_id IN ({placeholders}) AND created_at >= ? AND pain_during IS NOT NULL "
            f"GROUP BY user_id",
            (*patient_ids, cutoff_7d),
        )
        for row in await cur.fetchall():
            uid, avg = row[0], row[1]
            if uid in result:
                result[uid]["avg_pain_7d"] = avg

        # first_session → days_in_program
        cur = await db.execute(
            f"SELECT user_id, MIN(created_at) FROM daily_logs "
            f"WHERE user_id IN ({placeholders}) GROUP BY user_id",
            patient_ids,
        )
        today = datetime.utcnow().date()
        for row in await cur.fetchall():
            uid, first_dt = row[0], row[1]
            if uid in result and first_dt:
                try:
                    first_date = datetime.fromisoformat(first_dt[:10]).date()
                    result[uid]["days_in_program"] = (today - first_date).days
                except Exception:
                    pass

        # visa_latest — order by created_at DESC, take first row per user
        cur = await db.execute(
            f"SELECT user_id, total_score FROM visa_a_responses "
            f"WHERE user_id IN ({placeholders}) ORDER BY created_at DESC",
            patient_ids,
        )
        seen_visa: set[int] = set()
        for row in await cur.fetchall():
            uid, score = row[0], row[1]
            if uid in result and uid not in seen_visa:
                result[uid]["latest_visa"] = score
                seen_visa.add(uid)

    finally:
        await db.close()

    return result


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/supervisor/dashboard", response_class=HTMLResponse)
async def supervisor_dashboard(
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
):
    supervisor = await _get_supervisor(teno_session)
    if not supervisor:
        return RedirectResponse("/login", status_code=302)

    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT patient_id FROM supervisor_patients "
            "WHERE supervisor_id = ? AND (status IS NULL OR status = 'active')",
            (supervisor["id"],),
        )
        rows = await cur.fetchall()
        patient_ids = [r[0] for r in rows]

        cur = await db.execute(
            "SELECT COUNT(*) FROM supervisor_patients WHERE supervisor_id = ? AND status = 'dismissed'",
            (supervisor["id"],),
        )
        past_row = await cur.fetchone()
        past_cases_count = past_row[0] if past_row else 0
    finally:
        await db.close()

    # Check inactivity for all patients, then build summaries
    patients = []
    for pid in patient_ids:
        await _check_inactivity(pid)
        summary = await _get_patient_summary(pid)
        if summary:
            patients.append(summary)

    # Sort: red → yellow → inactive → green
    _order = {"red": 0, "yellow": 1, "inactive": 2, "green": 3}
    patients.sort(key=lambda p: _order.get(p.get("status", "green"), 3))

    # Case overview — engaged = session within last 4 days; behind = otherwise
    _engage_cutoff = (datetime.utcnow() - timedelta(days=4)).date().isoformat()
    engaged = [p for p in patients if p.get("last_session_date") and p["last_session_date"] >= _engage_cutoff]
    behind  = [p for p in patients if not p.get("last_session_date") or p["last_session_date"] < _engage_cutoff]

    # Alert counts by category
    _alert_type_order = ["pain", "compliance", "inactivity", "comment"]
    _alert_by_type: dict[str, dict] = {
        t: {"type": t, "count": 0, "patient_count": 0, "names": []}
        for t in _alert_type_order
    }
    for p in patients:
        _seen_types: set[str] = set()
        for a in p.get("alerts", []):
            t = a.get("type", "")
            if t in _alert_by_type:
                _alert_by_type[t]["count"] += 1
                if t not in _seen_types:
                    _alert_by_type[t]["patient_count"] += 1
                    _alert_by_type[t]["names"].append(p["name"])
                    _seen_types.add(t)
    alert_by_type = [_alert_by_type[t] for t in _alert_type_order]

    weekly_schedule  = await _get_weekly_schedule(patient_ids)
    program_reviews  = await _get_program_reviews(patient_ids)
    recent_sessions  = await _get_recent_sessions(patient_ids)

    await _audit(supervisor["id"], "view_dashboard")

    return templates.TemplateResponse(
        request, "supervisor_dashboard.html",
        {
            "user": supervisor,
            "patients": patients,
            "engaged": engaged,
            "behind": behind,
            "weekly_schedule": weekly_schedule,
            "program_reviews": program_reviews,
            "recent_sessions": recent_sessions,
            "review_window_min": _REVIEW_WINDOW_MIN_DAYS,
            "review_window_max": _REVIEW_WINDOW_MAX_DAYS,
            "active_cases_count": len(patients),
            "past_cases_count": past_cases_count,
            "alert_by_type": alert_by_type,
        },
    )


@router.get("/supervisor/assessments", response_class=HTMLResponse)
async def supervisor_assessments_overview(
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
):
    supervisor = await _get_supervisor(teno_session)
    if not supervisor:
        return RedirectResponse("/login", status_code=302)

    sup_id = supervisor["id"]

    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT patient_id FROM supervisor_patients "
            "WHERE supervisor_id = ? AND (status IS NULL OR status = 'active')",
            (sup_id,),
        )
        patient_ids = [r[0] for r in await cur.fetchall()]

        # Last supervisor assessment date + total count per patient
        placeholders = ",".join("?" * len(patient_ids)) if patient_ids else "NULL"
        cur = await db.execute(
            f"SELECT patient_id, MAX(created_at) AS last_assessed, COUNT(*) AS total "
            f"FROM supervisor_assessments "
            f"WHERE patient_id IN ({placeholders}) "
            f"GROUP BY patient_id",
            patient_ids,
        )
        assess_meta: dict[int, dict] = {}
        for r in await cur.fetchall():
            assess_meta[r[0]] = {
                "last_assessed": (r[1] or "")[:10],
                "total_assessments": r[2],
            }
    finally:
        await db.close()

    patients = []
    for pid in patient_ids:
        await _check_inactivity(pid)
        summary = await _get_patient_summary(pid)
        if summary:
            patients.append(summary)

    extras = await _get_cases_extra(patient_ids)
    _engage_cutoff = (datetime.utcnow() - timedelta(days=4)).date().isoformat()
    for p in patients:
        ex = extras.get(p["id"], {})
        p["avg_pain_7d"]     = ex.get("avg_pain_7d")
        p["days_in_program"] = ex.get("days_in_program")
        p["latest_visa"]     = ex.get("latest_visa")
        p["sessions_per_week"] = round(p.get("sessions_28d", 0) / 4, 1)
        meta = assess_meta.get(p["id"], {})
        p["last_assessed"]      = meta.get("last_assessed") or None
        p["total_assessments"]  = meta.get("total_assessments", 0)
        last = p.get("last_session_date") or ""
        p["engagement"] = "engaged" if last >= _engage_cutoff else "behind"

    _order = {"red": 0, "yellow": 1, "inactive": 2, "green": 3}
    patients.sort(key=lambda p: _order.get(p.get("status", "green"), 3))

    program_reviews = await _get_program_reviews(patient_ids)
    stages = sorted({p["stage"] for p in patients if p.get("stage") is not None})

    review_map = {r["id"]: r["status"] for r in program_reviews}
    modal_patients = [
        {
            "id": p["id"],
            "name": p.get("name") or "",
            "email": p.get("email") or "",
            "stage": p.get("stage"),
            "irritability": p.get("irritability") or "",
            "visa": p.get("latest_visa"),
            "avgPain": p.get("avg_pain_7d"),
            "lastSession": p.get("last_session_date") or "",
            "lastAssessed": p.get("last_assessed") or "",
            "totalAssessments": p.get("total_assessments") or 0,
            "reviewStatus": review_map.get(p["id"], "none"),
            "sides": ", ".join(p.get("injury_sides_list") or []),
        }
        for p in patients
    ]

    await _audit(sup_id, "view_assessments_page")

    return templates.TemplateResponse(
        request, "supervisor_assessments_overview.html",
        {
            "user": supervisor,
            "patients": patients,
            "program_reviews": program_reviews,
            "stages": stages,
            "total": len(patients),
            "modal_patients_json": json.dumps(modal_patients),
        },
    )


@router.get("/supervisor/cases", response_class=HTMLResponse)
async def supervisor_cases(
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
):
    supervisor = await _get_supervisor(teno_session)
    if not supervisor:
        return RedirectResponse("/login", status_code=302)

    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT patient_id FROM supervisor_patients "
            "WHERE supervisor_id = ? AND (status IS NULL OR status = 'active')",
            (supervisor["id"],),
        )
        rows = await cur.fetchall()
        patient_ids = [r[0] for r in rows]
    finally:
        await db.close()

    # Check inactivity for all patients, then build summaries
    patients = []
    for pid in patient_ids:
        await _check_inactivity(pid)
        summary = await _get_patient_summary(pid)
        if summary:
            patients.append(summary)

    # Batch-fetch extra metrics and merge
    extras = await _get_cases_extra(patient_ids)
    _engage_cutoff = (datetime.utcnow() - timedelta(days=4)).date().isoformat()
    for p in patients:
        ex = extras.get(p["id"], {})
        p["avg_pain_7d"]     = ex.get("avg_pain_7d")
        p["days_in_program"] = ex.get("days_in_program")
        p["latest_visa"]     = ex.get("latest_visa")
        p["sessions_per_week"] = round(p.get("sessions_28d", 0) / 4, 1)
        last = p.get("last_session_date") or ""
        p["engagement"] = "engaged" if last >= _engage_cutoff else "behind"

    # Sorted stage values (non-null)
    stages = sorted({p["stage"] for p in patients if p.get("stage") is not None})

    # Sort: red → yellow → inactive → green
    _order = {"red": 0, "yellow": 1, "inactive": 2, "green": 3}
    patients.sort(key=lambda p: _order.get(p.get("status", "green"), 3))

    await _audit(supervisor["id"], "view_cases_page")

    return templates.TemplateResponse(
        request, "supervisor_cases.html",
        {
            "user": supervisor,
            "patients": patients,
            "stages": stages,
            "total": len(patients),
        },
    )


@router.get("/supervisor/patients/{patient_id}/assessment", response_class=HTMLResponse)
async def supervisor_assessment_get(
    patient_id: int,
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
):
    supervisor = await _get_supervisor(teno_session)
    if not supervisor:
        return RedirectResponse("/login", status_code=302)

    # Verify assignment
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT status FROM supervisor_patients WHERE supervisor_id = ? AND patient_id = ?",
            (supervisor["id"], patient_id),
        )
        sp = await cur.fetchone()
    finally:
        await db.close()
    if not sp:
        return RedirectResponse("/supervisor/dashboard", status_code=302)

    # Patient basic info
    db = await get_db()
    try:
        cur = await db.execute("SELECT id, name, email FROM users WHERE id = ?", (patient_id,))
        patient_row = await cur.fetchone()
        if not patient_row:
            return RedirectResponse("/supervisor/dashboard", status_code=302)
        patient = dict(patient_row)

        import json as _json

        # Latest supervisor assessment (for previous notes + risk factors + FC pre-fill)
        cur = await db.execute(
            "SELECT * FROM supervisor_assessments WHERE patient_id = ? ORDER BY created_at DESC LIMIT 1",
            (patient_id,),
        )
        prev_row = await cur.fetchone()
        prev = None
        prev_obj: dict = {}
        if prev_row:
            prev = dict(prev_row)
            for field in ("functional_tests", "risk_factors"):
                if isinstance(prev.get(field), str):
                    try:
                        prev[field] = _json.loads(prev[field])
                    except Exception:
                        prev[field] = {} if field == "functional_tests" else []
            if isinstance(prev.get("objective_info"), str):
                try:
                    prev_obj = _json.loads(prev["objective_info"])
                    if not isinstance(prev_obj, dict):
                        prev_obj = {}
                except Exception:
                    prev_obj = {}

        # All supervisor assessment notes for this patient (version history)
        cur = await db.execute(
            "SELECT notes, created_at FROM supervisor_assessments "
            "WHERE patient_id = ? AND (notes IS NOT NULL AND notes != '') "
            "ORDER BY created_at DESC",
            (patient_id,),
        )
        notes_history = [
            {"notes": r["notes"], "date": (r["created_at"] or "")[:16].replace("T", " ")}
            for r in await cur.fetchall()
        ]

        # Latest patient comment from onboarding assessments
        cur = await db.execute(
            "SELECT comments, created_at FROM onboarding_assessments "
            "WHERE user_id = ? AND comments IS NOT NULL AND comments != '' "
            "ORDER BY created_at DESC LIMIT 1",
            (patient_id,),
        )
        comment_row = await cur.fetchone()
        patient_comment = None
        patient_comment_date = None
        if comment_row:
            patient_comment = comment_row["comments"]
            patient_comment_date = (comment_row["created_at"] or "")[:10]

    finally:
        await db.close()

    await _audit(supervisor["id"], "view_assessment_form", target_patient_id=patient_id)

    return templates.TemplateResponse(
        request, "supervisor_assessment.html",
        {
            "user": supervisor,
            "patient": patient,
            "prev": prev,
            "prev_obj": prev_obj,
            "notes_history": notes_history,
            "patient_comment": patient_comment,
            "patient_comment_date": patient_comment_date,
        },
    )


@router.post("/supervisor/patients/{patient_id}/assessment", response_class=HTMLResponse)
async def supervisor_assessment_post(
    patient_id: int,
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
    # Functional capacity
    calf_raise_reps: Optional[int] = Form(default=None),
    calf_raise_reps_unaffected: Optional[int] = Form(default=None),
    wblt_cm: Optional[int] = Form(default=None),
    wblt_cm_unaffected: Optional[int] = Form(default=None),
    double_leg_hop_cm: Optional[int] = Form(default=None),
    single_leg_hop_cm: Optional[int] = Form(default=None),
    single_leg_hop_cm_unaffected: Optional[int] = Form(default=None),
    double_leg_hop_endurance_reps: Optional[int] = Form(default=None),
    single_leg_hop_endurance_reps: Optional[int] = Form(default=None),
    single_leg_hop_endurance_reps_unaffected: Optional[int] = Form(default=None),
    # Risk factors
    risk_obesity: Optional[str] = Form(default=None),
    risk_hypertension: Optional[str] = Form(default=None),
    risk_diabetes: Optional[str] = Form(default=None),
    risk_steroids: Optional[str] = Form(default=None),
    risk_load_spikes: Optional[str] = Form(default=None),
    risk_family_history: Optional[str] = Form(default=None),
    # Range of motion — involved side flags
    rom_involved_left: Optional[str] = Form(default=None),
    rom_involved_right: Optional[str] = Form(default=None),
    rom_dorsiflexion: Optional[int] = Form(default=None),
    rom_dorsiflexion_unaffected: Optional[int] = Form(default=None),
    rom_plantarflexion: Optional[int] = Form(default=None),
    rom_plantarflexion_unaffected: Optional[int] = Form(default=None),
    rom_inversion: Optional[int] = Form(default=None),
    rom_inversion_unaffected: Optional[int] = Form(default=None),
    rom_eversion: Optional[int] = Form(default=None),
    rom_eversion_unaffected: Optional[int] = Form(default=None),
    # Inspection sub-fields
    inspection_swelling: Optional[str] = Form(default=""),
    inspection_redness: Optional[str] = Form(default=""),
    inspection_tenderness: Optional[str] = Form(default=""),
    inspection_pain_rating: Optional[int] = Form(default=None),
    # Posture sub-fields
    posture_foot: Optional[str] = Form(default=""),
    posture_lower_extremity: Optional[str] = Form(default=""),
    joint_mobility_passive: Optional[str] = Form(default=""),
    joint_mobility_active: Optional[str] = Form(default=""),
    joint_mobility_end_feel: Optional[str] = Form(default=""),
    ms_gait: Optional[str] = Form(default=""),
    ms_squat: Optional[str] = Form(default=""),
    ms_lunge: Optional[str] = Form(default=""),
    ms_single_leg_squat: Optional[str] = Form(default=""),
    ms_y_balance_forward_left: Optional[float] = Form(default=None),
    ms_y_balance_forward_right: Optional[float] = Form(default=None),
    ms_y_balance_back_inward_left: Optional[float] = Form(default=None),
    ms_y_balance_back_inward_right: Optional[float] = Form(default=None),
    ms_y_balance_back_outward_left: Optional[float] = Form(default=None),
    ms_y_balance_back_outward_right: Optional[float] = Form(default=None),
    ms_tandem_ankle: Optional[str] = Form(default=""),
    ms_tandem_lunge: Optional[str] = Form(default=""),
    # Notes
    notes: Optional[str] = Form(default=""),
):
    import json as _json

    supervisor = await _get_supervisor(teno_session)
    if not supervisor:
        return RedirectResponse("/login", status_code=302)

    # Verify assignment
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT status FROM supervisor_patients WHERE supervisor_id = ? AND patient_id = ?",
            (supervisor["id"], patient_id),
        )
        sp = await cur.fetchone()
    finally:
        await db.close()
    if not sp:
        return RedirectResponse("/supervisor/dashboard", status_code=302)

    # Build data structures
    risk_factors = [rf for rf, val in [
        ("obesity", risk_obesity), ("hypertension", risk_hypertension),
        ("diabetes", risk_diabetes), ("steroids", risk_steroids),
        ("load_spikes", risk_load_spikes), ("family_history", risk_family_history),
    ] if val]

    rom = {k: v for k, v in {
        "involved_left": True if rom_involved_left else None,
        "involved_right": True if rom_involved_right else None,
        "dorsiflexion": rom_dorsiflexion,
        "dorsiflexion_unaffected": rom_dorsiflexion_unaffected,
        "plantarflexion": rom_plantarflexion,
        "plantarflexion_unaffected": rom_plantarflexion_unaffected,
        "inversion": rom_inversion,
        "inversion_unaffected": rom_inversion_unaffected,
        "eversion": rom_eversion,
        "eversion_unaffected": rom_eversion_unaffected,
    }.items() if v is not None}

    objective_info = _json.dumps({
        "rom": rom,
        "inspection": {
            "swelling": inspection_swelling or "",
            "redness": inspection_redness or "",
            "tenderness": inspection_tenderness or "",
            "pain_rating": inspection_pain_rating,
        },
        "posture": {
            "foot": posture_foot or "",
            "lower_extremity": posture_lower_extremity or "",
        },
        "joint_mobility": {
            "passive": joint_mobility_passive or "",
            "active": joint_mobility_active or "",
            "end_feel": joint_mobility_end_feel or "",
        },
        "movement_screen": {
            "gait": ms_gait or "",
            "squat": ms_squat or "",
            "lunge": ms_lunge or "",
            "single_leg_squat": ms_single_leg_squat or "",
            "y_balance": {
                "forward_left": ms_y_balance_forward_left,
                "forward_right": ms_y_balance_forward_right,
                "back_inward_left": ms_y_balance_back_inward_left,
                "back_inward_right": ms_y_balance_back_inward_right,
                "back_outward_left": ms_y_balance_back_outward_left,
                "back_outward_right": ms_y_balance_back_outward_right,
            },
            "tandem_ankle": ms_tandem_ankle or "",
            "tandem_lunge": ms_tandem_lunge or "",
        },
    })

    functional_tests = {k: v for k, v in {
        "calf_raise_reps_unaffected": calf_raise_reps_unaffected,
        "wblt_cm": wblt_cm,
        "wblt_cm_unaffected": wblt_cm_unaffected,
        "double_leg_hop_cm": double_leg_hop_cm,
        "single_leg_hop_cm": single_leg_hop_cm,
        "single_leg_hop_cm_unaffected": single_leg_hop_cm_unaffected,
        "double_leg_hop_endurance_reps": double_leg_hop_endurance_reps,
        "single_leg_hop_endurance_reps": single_leg_hop_endurance_reps,
        "single_leg_hop_endurance_reps_unaffected": single_leg_hop_endurance_reps_unaffected,
    }.items() if v is not None}

    db = await get_db()
    try:
        # Save supervisor assessment
        await db.execute(
            """INSERT INTO supervisor_assessments
               (patient_id, supervisor_id, calf_raise_reps, functional_tests,
                risk_factors, objective_info, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                patient_id, supervisor["id"], calf_raise_reps,
                _json.dumps(functional_tests), _json.dumps(risk_factors),
                objective_info or "", notes or "",
            ),
        )

        # Update the patient's latest onboarding assessment with FC + risk data
        # so staging calculations stay current
        if calf_raise_reps is not None:
            cur = await db.execute(
                "SELECT id, functional_tests FROM onboarding_assessments "
                "WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
                (patient_id,),
            )
            oa_row = await cur.fetchone()
            if oa_row:
                # Merge functional_tests
                try:
                    existing_ft = _json.loads(oa_row["functional_tests"] or "{}")
                except Exception:
                    existing_ft = {}
                existing_ft.update(functional_tests)
                await db.execute(
                    "UPDATE onboarding_assessments SET calf_raise_reps = ?, functional_tests = ?, risk_factors = ? WHERE id = ?",
                    (calf_raise_reps, _json.dumps(existing_ft), _json.dumps(risk_factors), oa_row["id"]),
                )

        await db.commit()
    finally:
        await db.close()

    await _audit(supervisor["id"], "submit_assessment", target_patient_id=patient_id,
                 changes={"risk_factors": risk_factors, "calf_raise_reps": calf_raise_reps})

    return RedirectResponse(f"/supervisor/patients/{patient_id}", status_code=302)


@router.get("/supervisor/patients/{patient_id}", response_class=HTMLResponse)
async def supervisor_patient_profile(
    patient_id: int,
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
):
    supervisor = await _get_supervisor(teno_session)
    if not supervisor:
        return RedirectResponse("/login", status_code=302)

    # Verify assignment (active or dismissed — both viewable)
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT status, dismissed_reason, dismissed_at FROM supervisor_patients "
            "WHERE supervisor_id = ? AND patient_id = ?",
            (supervisor["id"], patient_id),
        )
        sp_row = await cur.fetchone()
        if not sp_row:
            return RedirectResponse("/supervisor/dashboard", status_code=302)
        case_status = sp_row["status"] or "active"
        dismissed_reason = sp_row["dismissed_reason"]
        dismissed_at = sp_row["dismissed_at"]
    finally:
        await db.close()

    await _check_inactivity(patient_id)
    patient = await _get_patient_detail(patient_id, supervisor_id=supervisor["id"])

    await _audit(supervisor["id"], "view_patient", target_patient_id=patient_id)

    return templates.TemplateResponse(
        request, "supervisor_patient.html",
        {
            "user": supervisor,
            "patient": patient,
            "case_status": case_status,
            "dismissed_reason": dismissed_reason,
            "dismissed_at": dismissed_at,
        },
    )


_DISMISS_REASONS = {
    "completed_program":   "User completed program",
    "goals_achieved":      "User goals achieved",
    "removed_from_program":"Remove user from program",
    "non_compliance":      "Non-compliance",
    "user_discontinued":   "User discontinued program",
}


@router.post("/supervisor/patients/{patient_id}/dismiss")
async def dismiss_patient(
    patient_id: int,
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
):
    supervisor = await _get_supervisor(teno_session)
    if not supervisor:
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    body = await request.json()
    reason = (body.get("reason") or "").strip()
    if reason not in _DISMISS_REASONS:
        return JSONResponse({"error": "invalid_reason"}, status_code=400)

    _ACCESS_WINDOW_DAYS = 14

    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT status FROM supervisor_patients WHERE supervisor_id = ? AND patient_id = ?",
            (supervisor["id"], patient_id),
        )
        row = await cur.fetchone()
        if not row:
            return JSONResponse({"error": "not_assigned"}, status_code=404)
        if row["status"] == "dismissed":
            return JSONResponse({"error": "already_dismissed"}, status_code=409)

        # Fetch patient info for email
        cur = await db.execute("SELECT name, email FROM users WHERE id = ?", (patient_id,))
        patient_row = await cur.fetchone()
        patient_name  = patient_row["name"]  if patient_row else "Patient"
        patient_email = patient_row["email"] if patient_row else None

        now = datetime.utcnow()
        expires_at = (now + timedelta(days=_ACCESS_WINDOW_DAYS)).date().isoformat()
        now_iso = now.isoformat()

        await db.execute(
            "UPDATE supervisor_patients SET status='dismissed', dismissed_at=?, dismissed_reason=?, dismissed_by=? "
            "WHERE supervisor_id=? AND patient_id=?",
            (now_iso, reason, supervisor["id"], supervisor["id"], patient_id),
        )
        await db.execute(
            "UPDATE users SET dismissed_at=?, access_expires_at=? WHERE id=?",
            (now_iso, expires_at, patient_id),
        )
        await db.commit()
    finally:
        await db.close()

    await _audit(supervisor["id"], "dismiss_patient", target_patient_id=patient_id,
                 changes={"reason": reason, "reason_label": _DISMISS_REASONS[reason],
                          "access_expires_at": expires_at})

    if patient_email:
        import asyncio
        asyncio.create_task(send_dismissal_email(
            to_email=patient_email,
            user_name=patient_name,
            reason_label=_DISMISS_REASONS[reason],
            expires_at=expires_at,
            days_remaining=_ACCESS_WINDOW_DAYS,
        ))

    return JSONResponse({"ok": True})


@router.post("/supervisor/patients/{patient_id}/reinstate")
async def reinstate_patient(
    patient_id: int,
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
):
    supervisor = await _get_supervisor(teno_session)
    if not supervisor:
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT status FROM supervisor_patients WHERE supervisor_id = ? AND patient_id = ?",
            (supervisor["id"], patient_id),
        )
        row = await cur.fetchone()
        if not row:
            return JSONResponse({"error": "not_assigned"}, status_code=404)
        if row["status"] != "dismissed":
            return JSONResponse({"error": "not_dismissed"}, status_code=409)

        await db.execute(
            "UPDATE supervisor_patients SET status='active', dismissed_at=NULL, dismissed_reason=NULL, dismissed_by=NULL "
            "WHERE supervisor_id=? AND patient_id=?",
            (supervisor["id"], patient_id),
        )
        await db.execute(
            "UPDATE users SET dismissed_at=NULL, access_expires_at=NULL WHERE id=?",
            (patient_id,),
        )
        await db.commit()
    finally:
        await db.close()

    await _audit(supervisor["id"], "reinstate_patient", target_patient_id=patient_id)
    return JSONResponse({"ok": True})


@router.post("/supervisor/patients/{patient_id}/delete-profile")
async def delete_patient_profile(
    patient_id: int,
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
):
    supervisor = await _get_supervisor(teno_session)
    if not supervisor or supervisor.get("role") != "superuser":
        return JSONResponse({"error": "forbidden"}, status_code=403)

    db = await get_db()
    try:
        # Verify the patient is assigned to this superuser's visible caseload
        cur = await db.execute("SELECT id FROM users WHERE id = ?", (patient_id,))
        if not await cur.fetchone():
            return JSONResponse({"error": "not_found"}, status_code=404)

        for stmt, params in [
            ("DELETE FROM supervisor_audit_logs WHERE target_patient_id = ?", (patient_id,)),
            ("DELETE FROM supervisor_alerts WHERE patient_id = ?", (patient_id,)),
            ("DELETE FROM supervisor_patients WHERE patient_id = ?", (patient_id,)),
            ("DELETE FROM session_follow_ups WHERE user_id = ?", (patient_id,)),
            ("DELETE FROM schedule_overrides WHERE user_id = ?", (patient_id,)),
            ("DELETE FROM progression_decisions WHERE user_id = ?", (patient_id,)),
            ("DELETE FROM sessions WHERE user_id = ?", (patient_id,)),
            ("DELETE FROM daily_logs WHERE user_id = ?", (patient_id,)),
            ("DELETE FROM rehab_plans WHERE user_id = ?", (patient_id,)),
            ("DELETE FROM visa_a_responses WHERE user_id = ?", (patient_id,)),
            ("DELETE FROM onboarding_assessments WHERE user_id = ?", (patient_id,)),
            ("DELETE FROM tfa_codes WHERE user_id = ?", (patient_id,)),
            ("DELETE FROM users WHERE id = ?", (patient_id,)),
        ]:
            await db.execute(stmt, params)
        await db.commit()
    finally:
        await db.close()

    await _audit(supervisor["id"], "delete_patient_profile", target_patient_id=patient_id)
    return JSONResponse({"ok": True})


@router.post("/supervisor/alerts/{alert_id}/resolve")
async def resolve_alert(
    alert_id: int,
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
):
    supervisor = await _get_supervisor(teno_session)
    if not supervisor:
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    db = await get_db()
    try:
        # Verify the alert belongs to an assigned patient
        cur = await db.execute(
            "SELECT sa.id, sa.patient_id FROM supervisor_alerts sa "
            "JOIN supervisor_patients sp ON sp.patient_id = sa.patient_id "
            "WHERE sa.id = ? AND sp.supervisor_id = ? AND sa.resolved = 0",
            (alert_id, supervisor["id"]),
        )
        row = await cur.fetchone()
        if not row:
            return JSONResponse({"error": "Alert not found"}, status_code=404)

        patient_id = row[1]
        await db.execute(
            "UPDATE supervisor_alerts SET resolved = 1, resolved_at = ? WHERE id = ?",
            (datetime.utcnow().isoformat(), alert_id),
        )
        await db.commit()
    finally:
        await db.close()

    await _audit(
        supervisor["id"], "resolve_alert",
        target_patient_id=patient_id,
        changes={"alert_id": alert_id},
    )

    # Redirect back to patient profile
    return RedirectResponse(f"/supervisor/patients/{patient_id}", status_code=302)


@router.post("/supervisor/patients/{patient_id}/session-comment")
async def save_session_comment(
    patient_id: int,
    teno_session: Optional[str] = Cookie(default=None),
    daily_log_id: int = Form(...),
    comment: str = Form(default=""),
):
    supervisor = await _get_supervisor(teno_session)
    if not supervisor:
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    # Verify the log belongs to this patient
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT id FROM daily_logs WHERE id = ? AND user_id = ?",
            (daily_log_id, patient_id),
        )
        if not await cur.fetchone():
            return JSONResponse({"error": "Not found"}, status_code=404)

        comment_val = comment.strip()[:2000]
        if comment_val:
            await db.execute(
                """INSERT INTO supervisor_session_comments (supervisor_id, daily_log_id, comment, updated_at)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(supervisor_id, daily_log_id)
                   DO UPDATE SET comment = excluded.comment, updated_at = excluded.updated_at""",
                (supervisor["id"], daily_log_id, comment_val, datetime.utcnow().isoformat()),
            )
        else:
            await db.execute(
                "DELETE FROM supervisor_session_comments WHERE supervisor_id = ? AND daily_log_id = ?",
                (supervisor["id"], daily_log_id),
            )
        await db.commit()
    finally:
        await db.close()

    return JSONResponse({"ok": True, "comment": comment.strip()[:2000]})


@router.post("/supervisor/patients/{patient_id}/case-note")
async def save_case_note(
    patient_id: int,
    teno_session: Optional[str] = Cookie(default=None),
    note: str = Form(...),
):
    supervisor = await _get_supervisor(teno_session)
    if not supervisor:
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT id FROM supervisor_patients WHERE supervisor_id = ? AND patient_id = ?",
            (supervisor["id"], patient_id),
        )
        if not await cur.fetchone():
            return JSONResponse({"error": "Not assigned"}, status_code=403)

        note_val = note.strip()[:4000]
        if not note_val:
            return JSONResponse({"error": "Note cannot be empty"}, status_code=400)

        now = datetime.utcnow().isoformat()
        await db.execute(
            "INSERT INTO supervisor_case_notes (patient_id, supervisor_id, note, created_at) VALUES (?, ?, ?, ?)",
            (patient_id, supervisor["id"], note_val, now),
        )
        await db.commit()
    finally:
        await db.close()

    await _audit(supervisor["id"], "case_note_saved", target_patient_id=patient_id)
    return JSONResponse({"ok": True, "created_at": now[:10]})


# ---------------------------------------------------------------------------
# Supervisor messaging routes
# ---------------------------------------------------------------------------

_PATIENTS_BY_SUPERVISOR_SQL = """
SELECT u.id, u.name, u.email,
  (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id AND m.recipient_id = ? AND m.read = 0) as unread,
  (SELECT MAX(m.created_at) FROM messages m WHERE (m.sender_id = u.id AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = u.id)) as last_msg,
  (SELECT m.body FROM messages m WHERE (m.sender_id = u.id AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = u.id) ORDER BY m.created_at DESC LIMIT 1) as last_msg_body
FROM supervisor_patients sp
JOIN users u ON sp.patient_id = u.id
WHERE sp.supervisor_id = ? AND sp.status = 'active'
ORDER BY last_msg DESC, u.name ASC
"""


@router.get("/supervisor/messages", response_class=HTMLResponse)
async def supervisor_messages_list(
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
):
    supervisor = await _get_supervisor(teno_session)
    if not supervisor:
        return RedirectResponse("/login", status_code=302)

    sup_id = supervisor["id"]
    db = await get_db()
    try:
        cur = await db.execute(
            _PATIENTS_BY_SUPERVISOR_SQL,
            (sup_id, sup_id, sup_id, sup_id, sup_id, sup_id),
        )
        rows = await cur.fetchall()
        patients = [
            {"id": r[0], "name": r[1], "email": r[2], "unread": r[3],
             "last_msg": r[4], "last_msg_body": (r[5] or "")[:60]}
            for r in rows
        ]
    finally:
        await db.close()

    return templates.TemplateResponse(
        request, "supervisor_messages.html",
        {
            "user": supervisor,
            "patients": patients,
            "active_patient": None,
            "messages": [],
        },
    )


@router.get("/supervisor/messages/{patient_id}", response_class=HTMLResponse)
async def supervisor_messages_conversation(
    patient_id: int,
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
):
    supervisor = await _get_supervisor(teno_session)
    if not supervisor:
        return RedirectResponse("/login", status_code=302)

    sup_id = supervisor["id"]

    db = await get_db()
    try:
        # Verify assignment
        cur = await db.execute(
            "SELECT patient_id FROM supervisor_patients "
            "WHERE supervisor_id = ? AND patient_id = ? AND status = 'active'",
            (sup_id, patient_id),
        )
        if not await cur.fetchone():
            return RedirectResponse("/supervisor/messages", status_code=302)

        # Fetch conversation
        cur = await db.execute(
            "SELECT id, sender_id, body, read, created_at FROM messages "
            "WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?) "
            "ORDER BY created_at ASC",
            (sup_id, patient_id, patient_id, sup_id),
        )
        rows = await cur.fetchall()
        messages = [
            {
                "id": r[0],
                "sender_id": r[1],
                "body": r[2],
                "read": r[3],
                "created_at": _fmt_alert_date(r[4]),
            }
            for r in rows
        ]

        # Mark patient→supervisor messages as read
        await db.execute(
            "UPDATE messages SET read = 1 WHERE sender_id = ? AND recipient_id = ? AND read = 0",
            (patient_id, sup_id),
        )
        await db.commit()

        # Patient list for sidebar
        cur2 = await db.execute(
            _PATIENTS_BY_SUPERVISOR_SQL,
            (sup_id, sup_id, sup_id, sup_id, sup_id, sup_id),
        )
        rows2 = await cur2.fetchall()
        patients = [
            {"id": r[0], "name": r[1], "email": r[2], "unread": r[3],
             "last_msg": r[4], "last_msg_body": (r[5] or "")[:60]}
            for r in rows2
        ]

        # Active patient info
        cur3 = await db.execute(
            "SELECT id, name, email FROM users WHERE id = ?",
            (patient_id,),
        )
        pt_row = await cur3.fetchone()
        active_patient = {"id": pt_row[0], "name": pt_row[1], "email": pt_row[2]} if pt_row else None
    finally:
        await db.close()

    return templates.TemplateResponse(
        request, "supervisor_messages.html",
        {
            "user": supervisor,
            "patients": patients,
            "active_patient": active_patient,
            "messages": messages,
        },
    )


@router.post("/supervisor/messages/{patient_id}/send")
async def supervisor_messages_send(
    patient_id: int,
    teno_session: Optional[str] = Cookie(default=None),
    body: str = Form(...),
):
    supervisor = await _get_supervisor(teno_session)
    if not supervisor:
        return RedirectResponse("/login", status_code=302)

    sup_id = supervisor["id"]
    body_val = body.strip()[:2000]

    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT patient_id FROM supervisor_patients "
            "WHERE supervisor_id = ? AND patient_id = ? AND status = 'active'",
            (sup_id, patient_id),
        )
        if await cur.fetchone() and body_val:
            await db.execute(
                "INSERT INTO messages (sender_id, recipient_id, body) VALUES (?, ?, ?)",
                (sup_id, patient_id, body_val),
            )
            await db.commit()
    finally:
        await db.close()

    return RedirectResponse(f"/supervisor/messages/{patient_id}", status_code=303)


# ---------------------------------------------------------------------------
# JSON API endpoints for messaging SPA
# ---------------------------------------------------------------------------

@router.get("/supervisor/api/messages/{patient_id}")
async def api_messages_get(
    patient_id: int,
    teno_session: Optional[str] = Cookie(default=None),
):
    supervisor = await _get_supervisor(teno_session)
    if not supervisor:
        return JSONResponse({"ok": False, "error": "Unauthorized"}, status_code=401)

    sup_id = supervisor["id"]
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT patient_id FROM supervisor_patients "
            "WHERE supervisor_id = ? AND patient_id = ? AND status = 'active'",
            (sup_id, patient_id),
        )
        if not await cur.fetchone():
            return JSONResponse({"ok": False, "error": "Not found"}, status_code=404)

        cur = await db.execute(
            "SELECT id, sender_id, body, created_at FROM messages "
            "WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?) "
            "ORDER BY created_at ASC",
            (sup_id, patient_id, patient_id, sup_id),
        )
        rows = await cur.fetchall()
        messages = [
            {
                "id": r[0],
                "sender_id": r[1],
                "body": r[2],
                "created_at": _fmt_alert_date(r[3]),
                "is_mine": r[1] == sup_id,
            }
            for r in rows
        ]

        await db.execute(
            "UPDATE messages SET read = 1 WHERE sender_id = ? AND recipient_id = ? AND read = 0",
            (patient_id, sup_id),
        )
        await db.commit()

        cur2 = await db.execute(
            "SELECT id, name, email FROM users WHERE id = ?", (patient_id,)
        )
        pt = await cur2.fetchone()
        patient = {"id": pt[0], "name": pt[1], "email": pt[2]} if pt else {}
    finally:
        await db.close()

    return JSONResponse({"ok": True, "messages": messages, "patient": patient})


@router.post("/supervisor/api/messages/{patient_id}/send")
async def api_messages_send(
    patient_id: int,
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
):
    supervisor = await _get_supervisor(teno_session)
    if not supervisor:
        return JSONResponse({"ok": False, "error": "Unauthorized"}, status_code=401)

    sup_id = supervisor["id"]
    try:
        payload = await request.json()
        body_val = (payload.get("body") or "").strip()[:2000]
    except Exception:
        return JSONResponse({"ok": False, "error": "Bad request"}, status_code=400)

    if not body_val:
        return JSONResponse({"ok": False, "error": "Empty message"}, status_code=400)

    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT patient_id FROM supervisor_patients "
            "WHERE supervisor_id = ? AND patient_id = ? AND status = 'active'",
            (sup_id, patient_id),
        )
        if not await cur.fetchone():
            return JSONResponse({"ok": False, "error": "Not found"}, status_code=404)

        cur2 = await db.execute(
            "INSERT INTO messages (sender_id, recipient_id, body) VALUES (?, ?, ?)",
            (sup_id, patient_id, body_val),
        )
        await db.commit()
        msg_id = cur2.lastrowid

        cur3 = await db.execute(
            "SELECT created_at FROM messages WHERE id = ?", (msg_id,)
        )
        ts_row = await cur3.fetchone()
        created_at = _fmt_alert_date(ts_row[0]) if ts_row else ""
    finally:
        await db.close()

    return JSONResponse({
        "ok": True,
        "message": {
            "id": msg_id,
            "body": body_val,
            "created_at": created_at,
            "is_mine": True,
        },
    })


# ---------------------------------------------------------------------------
# Alerts management page + JSON resolve API
# ---------------------------------------------------------------------------

@router.get("/supervisor/alerts", response_class=HTMLResponse)
async def supervisor_alerts_page(
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
    show_resolved: int = 0,
):
    supervisor = await _get_supervisor(teno_session)
    if not supervisor:
        return RedirectResponse("/login", status_code=302)

    sup_id = supervisor["id"]
    db = await get_db()
    try:
        resolved_filter = "AND sa.resolved = 0" if not show_resolved else "AND sa.resolved = 1"
        cur = await db.execute(
            f"""SELECT sa.id, sa.patient_id, u.name AS patient_name,
                       sa.type, sa.severity, sa.message,
                       sa.created_at, sa.log_id,
                       sa.resolved, sa.resolved_at
                FROM supervisor_alerts sa
                JOIN users u ON u.id = sa.patient_id
                WHERE sa.patient_id IN (
                    SELECT patient_id FROM supervisor_patients
                    WHERE supervisor_id = ? AND status = 'active'
                )
                {resolved_filter}
                ORDER BY
                    CASE sa.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                    sa.created_at DESC""",
            (sup_id,),
        )
        rows = await cur.fetchall()
        alerts = [
            {
                "id": r[0],
                "patient_id": r[1],
                "patient_name": r[2],
                "type": r[3],
                "severity": r[4],
                "message": r[5],
                "created_at": _fmt_alert_date(r[6]),
                "log_id": r[7],
                "resolved": r[8],
                "resolved_at": _fmt_alert_date(r[9]) if r[9] else None,
            }
            for r in rows
        ]

        # Resolved count for the toggle badge
        cur2 = await db.execute(
            """SELECT COUNT(*) FROM supervisor_alerts sa
               WHERE sa.patient_id IN (
                   SELECT patient_id FROM supervisor_patients
                   WHERE supervisor_id = ? AND status = 'active'
               ) AND sa.resolved = 1""",
            (sup_id,),
        )
        row2 = await cur2.fetchone()
        resolved_count = row2[0] if row2 else 0

        unresolved_count_cur = await db.execute(
            """SELECT COUNT(*) FROM supervisor_alerts sa
               WHERE sa.patient_id IN (
                   SELECT patient_id FROM supervisor_patients
                   WHERE supervisor_id = ? AND status = 'active'
               ) AND sa.resolved = 0""",
            (sup_id,),
        )
        row3 = await unresolved_count_cur.fetchone()
        unresolved_count = row3[0] if row3 else 0

        # Per-type breakdown (always from unresolved alerts)
        bd_cur = await db.execute(
            """SELECT sa.type, sa.patient_id, u.name
               FROM supervisor_alerts sa
               JOIN users u ON u.id = sa.patient_id
               WHERE sa.patient_id IN (
                   SELECT patient_id FROM supervisor_patients
                   WHERE supervisor_id = ? AND status = 'active'
               ) AND sa.resolved = 0""",
            (sup_id,),
        )
        bd_rows = await bd_cur.fetchall()
        _type_order = ["pain", "compliance", "inactivity", "comment"]
        _by_type: dict[str, dict] = {
            t: {"type": t, "count": 0, "patient_count": 0, "names": [], "_seen": set()}
            for t in _type_order
        }
        for bd_row in bd_rows:
            t, pid, pname = bd_row[0], bd_row[1], bd_row[2]
            if t in _by_type:
                _by_type[t]["count"] += 1
                if pid not in _by_type[t]["_seen"]:
                    _by_type[t]["_seen"].add(pid)
                    _by_type[t]["patient_count"] += 1
                    _by_type[t]["names"].append(pname)
        alert_by_type = [
            {k: v for k, v in _by_type[t].items() if k != "_seen"}
            for t in _type_order
        ]
    finally:
        await db.close()

    await _audit(sup_id, "view_alerts_page")

    return templates.TemplateResponse(
        request, "supervisor_alerts.html",
        {
            "user": supervisor,
            "alerts": alerts,
            "show_resolved": bool(show_resolved),
            "resolved_count": resolved_count,
            "unresolved_count": unresolved_count,
            "alert_by_type": alert_by_type,
        },
    )


@router.post("/supervisor/api/alerts/{alert_id}/resolve")
async def api_resolve_alert(
    alert_id: int,
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
):
    supervisor = await _get_supervisor(teno_session)
    if not supervisor:
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT sa.id, sa.patient_id FROM supervisor_alerts sa "
            "JOIN supervisor_patients sp ON sp.patient_id = sa.patient_id "
            "WHERE sa.id = ? AND sp.supervisor_id = ? AND sa.resolved = 0",
            (alert_id, supervisor["id"]),
        )
        row = await cur.fetchone()
        if not row:
            return JSONResponse({"error": "Alert not found"}, status_code=404)

        patient_id = row[1]
        await db.execute(
            "UPDATE supervisor_alerts SET resolved = 1, resolved_at = ? WHERE id = ?",
            (datetime.utcnow().isoformat(), alert_id),
        )
        await db.commit()
    finally:
        await db.close()

    await _audit(
        supervisor["id"], "resolve_alert",
        target_patient_id=patient_id,
        changes={"alert_id": alert_id},
    )
    return JSONResponse({"ok": True})


# ---------------------------------------------------------------------------
# Schedule API — JSON endpoint for the dynamic Upcoming Sessions tile
# ---------------------------------------------------------------------------

@router.get("/supervisor/api/schedule")
async def api_schedule(
    request: Request,
    teno_session: Optional[str] = Cookie(default=None),
    offset: int = 0,   # weeks from current Monday (can be negative)
    days: int = 7,     # 7 | 14 | 21 | 28
):
    """Return schedule data as JSON for the given week offset and day range."""
    supervisor = await _get_supervisor(teno_session)
    if not supervisor:
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    # Clamp days to valid values
    if days not in {7, 14, 21, 28}:
        days = 7

    # Compute start_date: current Monday + offset weeks
    today = datetime.utcnow().date()
    current_monday = today - timedelta(days=today.weekday())
    start_date = current_monday + timedelta(weeks=offset)

    # Fetch active patient IDs for this supervisor
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT patient_id FROM supervisor_patients "
            "WHERE supervisor_id = ? AND (status IS NULL OR status = 'active')",
            (supervisor["id"],),
        )
        rows = await cur.fetchall()
        patient_ids = [r[0] for r in rows]
    finally:
        await db.close()

    result = await _get_schedule_range(patient_ids, start_date, days, offset=offset)

    # Build human-readable range_label
    end_date = start_date + timedelta(days=days - 1)
    if start_date.year != end_date.year:
        # Cross-year: "Dec 29, 2025 – Jan 4, 2026"
        range_label = (
            f"{start_date.strftime('%b')} {start_date.day}, {start_date.year}"
            f" – "
            f"{end_date.strftime('%b')} {end_date.day}, {end_date.year}"
        )
    elif start_date.month != end_date.month:
        # Cross-month same year: "Apr 28 – May 4, 2026"
        range_label = (
            f"{start_date.strftime('%b')} {start_date.day}"
            f" – "
            f"{end_date.strftime('%b')} {end_date.day}, {end_date.year}"
        )
    else:
        # Same month+year: "May 5 – 11, 2026"
        range_label = (
            f"{start_date.strftime('%b')} {start_date.day}"
            f" – "
            f"{end_date.day}, {end_date.year}"
        )

    return JSONResponse({**result, "range_label": range_label})
