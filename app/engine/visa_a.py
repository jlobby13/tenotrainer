"""
VISA-A Scoring Engine for TenoTrainer.

Deterministic only. AI must NOT calculate or modify scores.

Simplified validated VISA-A (max 80):
  Q1: Morning stiffness (0=severe, 10=none)
  Q2: Pain stretching Achilles (0=severe, 10=none)
  Q3: Pain walking on flat (0=severe, 10=none)
  Q4: Pain on stairs (0=severe, 10=none)
  Q5: Pain with squatting (0=severe, 10=none)
  Q6: Pain with running (0=cannot run, 10=no pain) — 0 if not running
  Q7: Single-leg calf raises (scored 0,2,4,6,8,10 for 0,1-4,5-9,10-19,20-24,≥25)
  Q8: Activity level (0=not active, 4=reduced, 7=full with pain, 10=full no pain)

  Total max = 80
"""

from __future__ import annotations
from dataclasses import dataclass


QUESTIONS = [
    {
        "id": "q1",
        "number": 1,
        "text": "How much morning stiffness do you have in your Achilles tendon region on first rising?",
        "type": "scale",
        "min": 0,
        "max": 10,
        "min_label": "Severe stiffness",
        "max_label": "No stiffness",
    },
    {
        "id": "q2",
        "number": 2,
        "text": "When you stretch your Achilles tendon fully, do you feel pain?",
        "type": "scale",
        "min": 0,
        "max": 10,
        "min_label": "Severe pain",
        "max_label": "No pain",
    },
    {
        "id": "q3",
        "number": 3,
        "text": "Do you have pain when walking on flat ground?",
        "type": "scale",
        "min": 0,
        "max": 10,
        "min_label": "Very severe pain",
        "max_label": "No pain",
    },
    {
        "id": "q4",
        "number": 4,
        "text": "Do you have pain when climbing stairs?",
        "type": "scale",
        "min": 0,
        "max": 10,
        "min_label": "Very severe pain",
        "max_label": "No pain",
    },
    {
        "id": "q5",
        "number": 5,
        "text": "Do you have pain when squatting?",
        "type": "scale",
        "min": 0,
        "max": 10,
        "min_label": "Very severe pain",
        "max_label": "No pain",
    },
    {
        "id": "q6",
        "number": 6,
        "text": "Do you have pain during or immediately after running? (Score 0 if you are unable to run)",
        "type": "scale",
        "min": 0,
        "max": 10,
        "min_label": "Cannot run / Severe pain",
        "max_label": "No pain when running",
    },
    {
        "id": "q7",
        "number": 7,
        "text": "How many single-leg heel raises can you do on the affected leg (pain-free)?",
        "type": "select",
        "options": [
            {"value": 0, "label": "0 raises", "score": 0},
            {"value": 1, "label": "1–4 raises", "score": 2},
            {"value": 2, "label": "5–9 raises", "score": 4},
            {"value": 3, "label": "10–19 raises", "score": 6},
            {"value": 4, "label": "20–24 raises", "score": 8},
            {"value": 5, "label": "25 or more raises", "score": 10},
        ],
    },
    {
        "id": "q8",
        "number": 8,
        "text": "What is your current activity level?",
        "type": "select",
        "options": [
            {"value": 0, "label": "Not participating in any sport or physical activity", "score": 0},
            {"value": 1, "label": "Participating in modified training and/or competition (reduced volume/intensity)", "score": 4},
            {"value": 2, "label": "Full training and/or competition but still affected by Achilles pain", "score": 7},
            {"value": 3, "label": "Competing at same or higher level as before injury, with no Achilles problems", "score": 10},
        ],
    },
]

# Lookup maps for Q7 and Q8 from raw input value → score
Q7_SCORE_MAP = {0: 0, 1: 2, 2: 4, 3: 6, 4: 8, 5: 10}
Q8_SCORE_MAP = {0: 0, 1: 4, 2: 7, 3: 10}

MAX_SCORE = 80


@dataclass
class VisaAResult:
    q1: int
    q2: int
    q3: int
    q4: int
    q5: int
    q6: int
    q7_raw: int      # raw select value (0–5)
    q8_raw: int      # raw select value (0–3)
    q7_score: int    # scored value
    q8_score: int    # scored value
    total_score: int
    interpretation: str
    severity: str    # mild / moderate / severe


def score_visa_a(q1: int, q2: int, q3: int, q4: int, q5: int, q6: int, q7: int, q8: int) -> VisaAResult:
    """
    Compute the VISA-A score deterministically.
    q7 and q8 are raw option indices (0-based).
    Returns VisaAResult with all scores and interpretation.

    This function is the SOLE scorer — AI must not call scoring logic.
    """
    # Clamp Q1–Q6 to 0–10
    scores_raw = [q1, q2, q3, q4, q5, q6]
    clamped = [max(0, min(10, int(s))) for s in scores_raw]

    q7_score = Q7_SCORE_MAP.get(int(q7), 0)
    q8_score = Q8_SCORE_MAP.get(int(q8), 0)

    total = sum(clamped) + q7_score + q8_score
    total = max(0, min(MAX_SCORE, total))

    severity = _severity_label(total)
    interpretation = _interpret_score(total, severity)

    return VisaAResult(
        q1=clamped[0],
        q2=clamped[1],
        q3=clamped[2],
        q4=clamped[3],
        q5=clamped[4],
        q6=clamped[5],
        q7_raw=int(q7),
        q8_raw=int(q8),
        q7_score=q7_score,
        q8_score=q8_score,
        total_score=total,
        interpretation=interpretation,
        severity=severity,
    )


def _severity_label(total: int) -> str:
    if total >= 64:
        return "mild"
    elif total >= 40:
        return "moderate"
    else:
        return "severe"


def _interpret_score(total: int, severity: str) -> str:
    pct = round(total / MAX_SCORE * 100)
    base = f"VISA-A Score: {total}/80 ({pct}% function) — {severity.capitalize()} impairment."
    guidance = {
        "mild": (
            " Tendon function is relatively good. Maintain progressive loading and monitor for flares. "
            "Reassess every 2 weeks."
        ),
        "moderate": (
            " Moderate tendon impairment. A structured progressive loading programme is strongly indicated. "
            "Focus on irritability management and consistent exposure."
        ),
        "severe": (
            " Severe impairment. Symptoms are significantly limiting function. "
            "Begin with Stage 1 (isometric) loading and prioritise pain modulation. "
            "Clinician review recommended."
        ),
    }
    return base + guidance.get(severity, "")


def get_questions() -> list[dict]:
    """Return question definitions for template rendering."""
    return QUESTIONS


def visa_a_score_from_form(form_data: dict) -> VisaAResult:
    """
    Helper to parse and score from raw form POST data.
    form_data keys: q1..q8 (strings)
    """
    def safe_int(v, default=0):
        try:
            return int(v)
        except (TypeError, ValueError):
            return default

    return score_visa_a(
        q1=safe_int(form_data.get("q1")),
        q2=safe_int(form_data.get("q2")),
        q3=safe_int(form_data.get("q3")),
        q4=safe_int(form_data.get("q4")),
        q5=safe_int(form_data.get("q5")),
        q6=safe_int(form_data.get("q6")),
        q7=safe_int(form_data.get("q7")),
        q8=safe_int(form_data.get("q8")),
    )
