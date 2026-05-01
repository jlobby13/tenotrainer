"""
TenoTrainer — Supervisor System (MVP Phase 1)

Provides a read-only view of assigned patients: status dashboard,
session metrics, program comparison, and auto-generated alerts.

Alert types:
  pain        — pain_during ≥ 7 (high) OR increased ≥ 2 vs recent avg (medium)
  compliance  — overall_compliance < 30% (high) OR < 60% (medium)
  inactivity  — no session in > 5 days (medium)

All supervisor actions are appended to supervisor_audit_logs.
Rule engine outputs are never modified.
"""

from __future__ import annotations

import json
import secrets
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Cookie, Request
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
                 changes: dict = None, note: Optional[str] = None) -> None:
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
) -> None:
    """
    Generate supervisor alerts after a patient session is submitted.
    This is NON-DESTRUCTIVE — rule engine outputs are never touched.
    """
    db = await get_db()
    try:
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


async def _get_weekly_schedule(patient_ids: list[int]) -> dict:
    """Return per-day session counts and patient lists for the current week."""
    today = datetime.utcnow().date()
    week_start_date = today - timedelta(days=today.weekday())  # Monday
    week_start = week_start_date.isoformat()
    week_end = (week_start_date + timedelta(days=6)).isoformat()

    scheduled_by_day: dict[int, list] = {i: [] for i in range(7)}
    completed_by_day: dict[int, list] = {i: [] for i in range(7)}

    if patient_ids:
        db = await get_db()
        try:
            placeholders = ",".join("?" * len(patient_ids))

            cur = await db.execute(
                f"SELECT id, name FROM users WHERE id IN ({placeholders})",
                patient_ids,
            )
            rows = await cur.fetchall()
            patient_names = {r[0]: r[1] for r in rows}

            # Current-week overrides
            cur = await db.execute(
                f"SELECT user_id, session_days FROM schedule_overrides "
                f"WHERE user_id IN ({placeholders}) AND week_start = ?",
                (*patient_ids, week_start),
            )
            scheduled_patients = {r[0]: r[1] for r in await cur.fetchall()}

            # For patients without a current-week override, fall back to their
            # most recent override from any past week (their standing schedule).
            missing = [pid for pid in patient_ids if pid not in scheduled_patients]
            if missing:
                miss_ph = ",".join("?" * len(missing))
                cur = await db.execute(
                    f"SELECT user_id, session_days FROM schedule_overrides "
                    f"WHERE user_id IN ({miss_ph}) "
                    f"GROUP BY user_id HAVING week_start = MAX(week_start)",
                    missing,
                )
                for r in await cur.fetchall():
                    scheduled_patients[r[0]] = r[1]

            for uid, raw in scheduled_patients.items():
                for idx in (json.loads(raw) if raw else []):
                    if 0 <= idx <= 6:
                        scheduled_by_day[idx].append({"id": uid, "name": patient_names.get(uid, "")})

            cur = await db.execute(
                f"SELECT user_id, DATE(created_at) FROM daily_logs "
                f"WHERE user_id IN ({placeholders}) "
                f"AND DATE(created_at) >= ? AND DATE(created_at) <= ?",
                (*patient_ids, week_start, week_end),
            )
            for r in await cur.fetchall():
                uid, log_date = r[0], r[1]
                try:
                    from datetime import date as _date
                    diff = (_date.fromisoformat(log_date) - week_start_date).days
                    if 0 <= diff <= 6:
                        completed_by_day[diff].append({"id": uid, "name": patient_names.get(uid, "")})
                except Exception:
                    pass
        finally:
            await db.close()

    days = []
    for i in range(7):
        d = week_start_date + timedelta(days=i)
        days.append({
            "index": i,
            "label": _DAY_LABELS[i],
            "date": d.isoformat(),
            "day_num": d.day,
            "is_today": d == today,
            "is_past": d < today,
            "scheduled": scheduled_by_day[i],
            "completed": completed_by_day[i],
        })
    return {"week_start": week_start, "days": days}


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
        cur = await db.execute("SELECT id, name, email FROM users WHERE id = ?", (patient_id,))
        row = await cur.fetchone()
        if not row:
            return {}
        p = {"id": row[0], "name": row[1], "email": row[2] or ""}

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
        alert_rows = await cur.fetchall()
        p["alert_count"] = len(alert_rows)
        p["alerts"] = [
            {"id": r[0], "type": r[1], "severity": r[2], "message": r[3], "created_at": r[4]}
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


def _short_date(dt_str: str) -> str:
    """'2024-06-05 10:00:00' → 'Jun 5'"""
    try:
        from datetime import datetime as _dt
        d = _dt.fromisoformat((dt_str or "")[:10])
        return d.strftime("%b ") + str(d.day)
    except Exception:
        return (dt_str or "")[:10]


async def _get_patient_detail(patient_id: int) -> dict:
    """Fetch full detail for patient profile page."""
    db = await get_db()
    try:
        # Basic user info
        cur = await db.execute(
            "SELECT id, name, email, created_at FROM users WHERE id = ?", (patient_id,)
        )
        row = await cur.fetchone()
        if not row:
            return {}
        p = {"id": row[0], "name": row[1], "email": row[2] or "", "member_since": (row[3] or "")[:10]}

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
            "SELECT created_at, pain_during, pain_after, next_day_pain, "
            "morning_stiffness, notes, exercise_log "
            "FROM daily_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
            (patient_id,),
        )
        rows = await cur.fetchall()
        sessions = []
        for r in rows:
            ex_log = {}
            try:
                ex_log = json.loads(r[6]) if r[6] else {}
            except Exception:
                pass
            # overall_compliance lives inside the exercise_log JSON, not as a column
            compliance = ex_log.get("overall_compliance")
            sessions.append({
                "date": (r[0] or "")[:10],
                "pain_during": r[1],
                "pain_after": r[2],
                "next_day_pain": r[3],
                "morning_stiffness": r[4],
                "compliance": compliance,
                "notes": r[5] or "",
                "exercise_log": ex_log,
            })
        p["recent_sessions"] = sessions[:8]  # table shows last 8

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
                "created_at": (r[4] or "")[:16].replace("T", " "),
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
        },
    )


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
    patient = await _get_patient_detail(patient_id)

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
