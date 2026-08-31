"""
Deterministic Rule Engine for TenoTrainer.

ALL clinical decisions originate here. No AI involvement in this module.

Components:
  - Irritability classification
  - FITT dosing by irritability
  - Rehab stage assignment
  - Decision engine (GO/STAY/CAUTION/STOP)
  - Stage progression rules
  - Override logic (under/over-reporting)
  - Conservative bias from risk factors
  - Red flag / safety halt checks
"""

from __future__ import annotations
import json
from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

class Irritability:
    HIGH = "high"
    MODERATE = "moderate"
    LOW = "low"


class Decision:
    GO = "GO"
    STAY = "STAY"
    CAUTION = "CAUTION"
    STOP = "STOP"


FITT_TABLE = {
    Irritability.HIGH: {
        "intensity": "very_low",
        "volume": "low",
        "frequency": "reduced",
        "progression": "slow",
    },
    Irritability.MODERATE: {
        "intensity": "moderate",
        "volume": "moderate",
        "frequency": "normal",
        "progression": "moderate",
    },
    Irritability.LOW: {
        "intensity": "high",
        "volume": "higher",
        "frequency": "full",
        "progression": "faster",
    },
}

# Dosing multipliers applied to sets/reps based on irritability
DOSING_MULTIPLIERS = {
    Irritability.HIGH:     {"sets_factor": 0.6, "reps_factor": 0.6},
    Irritability.MODERATE: {"sets_factor": 1.0, "reps_factor": 1.0},
    Irritability.LOW:      {"sets_factor": 1.0, "reps_factor": 1.2},
}

RED_FLAG_KEYWORDS = {
    "sudden_pop", "pop_sound", "unable_to_plantarflex",
    "complete_loss_plantarflex", "visible_gap", "tendon_gap",
}


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class OnboardingData:
    """Raw inputs from the onboarding form."""
    pain_with_activity: int          # 0–10
    pain_after_activity: int         # 0–10
    next_day_pain: int               # 0–10
    morning_stiffness: int           # 0–10 (higher = worse)
    pain_at_rest: int                # 0–10
    calf_raise_reps: int             # count
    injury_duration: str             # acute / subacute / chronic
    recent_load_change: bool
    risk_factors: list[str] = field(default_factory=list)
    red_flags: list[str] = field(default_factory=list)
    calf_raise_reps_unaffected: Optional[int] = None    # Unaffected side calf raise (for LSI)
    wblt_cm: Optional[int] = None                       # Weight Bearing Lunge Test, affected (cm)
    wblt_cm_unaffected: Optional[int] = None            # Weight Bearing Lunge Test, unaffected (cm)
    double_leg_hop_cm: Optional[int] = None             # Double-leg hop distance (cm)
    single_leg_hop_cm: Optional[int] = None             # Single-leg hop distance (cm)
    double_leg_hop_endurance_reps: Optional[int] = None # Double-leg in-place endurance hop (reps)
    single_leg_hop_endurance_reps: Optional[int] = None # Single-leg in-place endurance hop (reps)


@dataclass
class ClassificationResult:
    irritability: str
    stage: int
    fitt: dict
    has_red_flags: bool
    red_flags_detail: list[str]
    conservative_bias: bool
    rationale: str


@dataclass
class ProgressionAssessment:
    decision: str                    # GO / STAY / CAUTION / STOP
    current_stage: int
    proposed_stage: int
    rationale: str
    override_applied: Optional[str] = None
    can_progress_stage: bool = False


# ---------------------------------------------------------------------------
# Red Flag Check
# ---------------------------------------------------------------------------

def check_red_flags(red_flags: list[str], notes: str = "") -> tuple[bool, list[str]]:
    """
    Check for rupture indicators and severe red flags.
    Returns (has_red_flags, matched_flags).
    This check must run on EVERY form submission.
    """
    matched = []
    notes_lower = notes.lower() if notes else ""

    for flag in red_flags:
        if flag.lower().replace(" ", "_") in RED_FLAG_KEYWORDS:
            matched.append(flag)

    # Text-based heuristic scan for common rupture language
    rupture_phrases = [
        "heard a pop", "felt a pop", "sudden sharp pain",
        "can't point foot", "cannot point foot", "gap in tendon",
        "complete rupture",
    ]
    for phrase in rupture_phrases:
        if phrase in notes_lower:
            matched.append(phrase)

    return bool(matched), matched


# ---------------------------------------------------------------------------
# Irritability Classification
# ---------------------------------------------------------------------------

def classify_irritability(
    pain_with_activity: int,
    pain_after_activity: int,
    next_day_pain: int,
) -> str:
    """
    Classify irritability from the worst pain score across contexts.
    High  : worst pain ≥ 6
    Moderate: worst pain 3–5
    Low   : worst pain ≤ 2
    """
    worst = max(pain_with_activity, pain_after_activity, next_day_pain)
    if worst >= 6:
        return Irritability.HIGH
    elif worst >= 3:
        return Irritability.MODERATE
    else:
        return Irritability.LOW


# ---------------------------------------------------------------------------
# Stage Assignment
# ---------------------------------------------------------------------------

def assign_initial_stage(
    injury_duration: str,
    calf_raise_reps: int,
    irritability: str,
    recent_load_change: bool,
) -> int:
    """
    Stage is a loading strategy axis — NOT symptom-driven.

    Stage 1 — Capacity Initiation (isometrics, slow isotonic):
      - Acute injury (<6 weeks)
      - High irritability (regardless of duration)
      - Very limited capacity (≤5 raises)

    Stage 2 — Strength Development (eccentric, heavy slow resistance):
      - Subacute or chronic with moderate/low irritability
      - Reasonable calf capacity (6–19 raises)

    Stage 3 — Energy Storage & Release (plyometrics, reactive strength):
      - Chronic with low irritability
      - Strong capacity (≥20 raises)
      - No recent load spike
    """
    if irritability == Irritability.HIGH:
        return 1
    if injury_duration == "acute":
        return 1
    if calf_raise_reps <= 5:
        return 1
    if injury_duration == "subacute" and irritability == Irritability.MODERATE:
        return 2
    if calf_raise_reps >= 20 and irritability == Irritability.LOW and injury_duration == "chronic" and not recent_load_change:
        return 3
    if calf_raise_reps >= 6:
        return 2
    return 1


# ---------------------------------------------------------------------------
# Conservative Bias
# ---------------------------------------------------------------------------

RISK_FACTOR_SET = {"obesity", "hypertension", "diabetes", "steroids", "load_spikes", "family_history"}


def has_conservative_bias(risk_factors: list[str]) -> bool:
    """Return True if any known risk factor warrants conservative bias."""
    return bool(set(rf.lower() for rf in risk_factors) & RISK_FACTOR_SET)


# ---------------------------------------------------------------------------
# FITT Dosing
# ---------------------------------------------------------------------------

def get_fitt_dosing(irritability: str) -> dict:
    return FITT_TABLE.get(irritability, FITT_TABLE[Irritability.MODERATE])


def apply_dosing_modifier(exercise: dict, irritability: str) -> dict:
    """
    Return a copy of the exercise dict with sets/reps adjusted for irritability.
    Does NOT mutate the original.
    """
    m = DOSING_MULTIPLIERS.get(irritability, DOSING_MULTIPLIERS[Irritability.MODERATE])
    ex = dict(exercise)

    # Adjust sets (always numeric)
    if isinstance(ex.get("sets"), (int, float)):
        ex["sets"] = max(1, round(ex["sets"] * m["sets_factor"]))

    # Adjust reps only if purely numeric
    if isinstance(ex.get("reps"), (int, float)):
        ex["reps"] = max(1, round(ex["reps"] * m["reps_factor"]))

    # Add a dosing note
    ex["dosing_note"] = _dosing_note(irritability)
    return ex


def _dosing_note(irritability: str) -> str:
    notes = {
        Irritability.HIGH: "High irritability: reduced volume. Keep pain ≤3/10.",
        Irritability.MODERATE: "Moderate irritability: standard dosing. Monitor pain response.",
        Irritability.LOW: "Low irritability: full dosing. Progress load as tolerated.",
    }
    return notes.get(irritability, "Standard dosing applies.")


# ---------------------------------------------------------------------------
# Full Onboarding Classification
# ---------------------------------------------------------------------------

def classify_onboarding(data: OnboardingData) -> ClassificationResult:
    """
    Master classification function called at onboarding.
    Returns irritability, stage, FITT, red flag status, conservative bias, and rationale.
    """
    # 1. Red flags first — safety always takes priority
    has_rf, rf_detail = check_red_flags(data.red_flags)

    # 2. Irritability
    irritability = classify_irritability(
        data.pain_with_activity,
        data.pain_after_activity,
        data.next_day_pain,
    )

    # 3. Stage
    stage = assign_initial_stage(
        data.injury_duration,
        data.calf_raise_reps,
        irritability,
        data.recent_load_change,
    )

    # 4. Conservative bias
    conservative = has_conservative_bias(data.risk_factors)

    # 5. FITT dosing
    fitt = get_fitt_dosing(irritability)
    if conservative:
        # Downgrade dosing by one tier for conservative bias
        fitt = _apply_conservative_bias_to_fitt(fitt)

    # 6. Build rationale
    worst_pain = max(data.pain_with_activity, data.pain_after_activity, data.next_day_pain)
    rationale = _build_onboarding_rationale(
        irritability, stage, worst_pain, data.calf_raise_reps,
        data.injury_duration, conservative, data.risk_factors,
    )

    return ClassificationResult(
        irritability=irritability,
        stage=stage,
        fitt=fitt,
        has_red_flags=has_rf,
        red_flags_detail=rf_detail,
        conservative_bias=conservative,
        rationale=rationale,
    )


def _apply_conservative_bias_to_fitt(fitt: dict) -> dict:
    """Shift FITT dosing toward conservative when risk factors are present."""
    tier_map = {
        "high": "moderate",
        "moderate": "low",
        "very_low": "very_low",
        "higher": "moderate",
        "normal": "reduced",
        "full": "normal",
        "faster": "moderate",
        "slow": "slow",
    }
    return {k: tier_map.get(v, v) for k, v in fitt.items()}


def _build_onboarding_rationale(
    irritability: str,
    stage: int,
    worst_pain: int,
    calf_raise_reps: int,
    injury_duration: str,
    conservative: bool,
    risk_factors: list[str],
) -> str:
    stage_names = {1: "Capacity Initiation", 2: "Strength Development", 3: "Energy Storage & Release"}
    lines = [
        f"Irritability classified as {irritability.upper()} based on worst pain score of {worst_pain}/10.",
        f"Rehab Stage {stage} ({stage_names[stage]}) assigned based on injury duration ({injury_duration}), "
        f"calf raise capacity ({calf_raise_reps} reps), and irritability level.",
    ]
    if conservative:
        lines.append(
            f"Conservative bias applied due to risk factor(s): {', '.join(risk_factors)}. "
            "Dosing is reduced to support safe progression."
        )
    if irritability == Irritability.HIGH:
        lines.append(
            "High irritability: isometric loading recommended to reduce tendon sensitivity without "
            "provocative loading. Stage 1 focus: pain modulation and load tolerance baseline."
        )
    elif irritability == Irritability.MODERATE:
        lines.append(
            "Moderate irritability: graduated loading with careful pain monitoring. "
            "Standard dosing with progression contingent on consistent pain-free sessions."
        )
    else:
        lines.append(
            "Low irritability: full progressive loading appropriate. "
            "Progression gates remain capacity-based, not symptom-based alone."
        )
    return " ".join(lines)


# ---------------------------------------------------------------------------
# Decision Engine — GO / STAY / CAUTION / STOP
# ---------------------------------------------------------------------------

def run_decision_engine(
    recent_logs: list[dict],
    current_stage: int,
    current_irritability: str,
    calf_raise_reps_baseline: int,
    calf_raise_reps_current: int,
    conservative_bias: bool = False,
    loading_context_changes: Optional[list[str]] = None,
) -> ProgressionAssessment:
    """
    Determines GO/STAY/CAUTION/STOP and whether stage progression is warranted.

    recent_logs: list of dicts with keys: pain_during, pain_after, next_day_pain, difficulty, confidence
    loading_context_changes: list of changed factors this session (e.g. ['sport', 'surface', 'footwear'])
    Requires ≥4 recent logs for a GO decision (sufficient exposure).
    """
    context_changes = loading_context_changes or []
    if not recent_logs:
        return ProgressionAssessment(
            decision=Decision.STAY,
            current_stage=current_stage,
            proposed_stage=current_stage,
            rationale="No session logs available. Cannot assess progression. Complete at least 4 sessions.",
            can_progress_stage=False,
        )

    # Compute max pain from most recent log
    latest = recent_logs[-1]
    worst_recent_pain = max(
        latest.get("pain_during", 0),
        latest.get("pain_after", 0),
        latest.get("next_day_pain", 0),
    )

    # Check for STOP condition first
    if worst_recent_pain >= 6:
        return ProgressionAssessment(
            decision=Decision.STOP,
            current_stage=current_stage,
            proposed_stage=current_stage,
            rationale=(
                f"Pain level {worst_recent_pain}/10 exceeds the safety threshold of 6. "
                "Halt current loading. Reduce intensity and consult your clinician if symptoms persist."
            ),
            can_progress_stage=False,
        )

    # CAUTION
    if worst_recent_pain >= 4:
        return ProgressionAssessment(
            decision=Decision.CAUTION,
            current_stage=current_stage,
            proposed_stage=current_stage,
            rationale=(
                f"Pain level {worst_recent_pain}/10 is in the caution range (4–5). "
                "Maintain current dosing. Do not progress until pain stabilises below 4/10."
            ),
            can_progress_stage=False,
        )

    # Loading context change check — novel mechanical demands require caution
    if context_changes:
        change_labels = {"sport": "sport/activity", "surface": "training surface", "footwear": "footwear"}
        changed_str = ", ".join(change_labels.get(c, c) for c in context_changes)
        multi_change = len(context_changes) >= 2

        # Multiple simultaneous changes or any change with elevated pain → CAUTION
        if multi_change or worst_recent_pain >= 4:
            return ProgressionAssessment(
                decision=Decision.CAUTION,
                current_stage=current_stage,
                proposed_stage=current_stage,
                rationale=(
                    f"Loading profile change detected ({changed_str}). "
                    + ("Multiple simultaneous changes represent a significant novel load. " if multi_change else "")
                    + "Do not progress this session. Monitor response over the next 24–48 hours before resuming normal loading."
                ),
                override_applied="loading_context_change",
                can_progress_stage=False,
            )

        # Single change with low pain → STAY with advisory
        return ProgressionAssessment(
            decision=Decision.STAY,
            current_stage=current_stage,
            proposed_stage=current_stage,
            rationale=(
                f"Loading profile change detected ({changed_str}). "
                "Novel mechanical demands require an adaptation window before progression. "
                "Maintain current stage and dosing for at least 2 further sessions to confirm tolerance."
            ),
            override_applied="loading_context_change",
            can_progress_stage=False,
        )

    # Below caution — check consistency gate
    consistent_sessions = len(recent_logs)
    required_sessions = 4

    if consistent_sessions < required_sessions:
        return ProgressionAssessment(
            decision=Decision.STAY,
            current_stage=current_stage,
            proposed_stage=current_stage,
            rationale=(
                f"Only {consistent_sessions} session(s) logged. "
                f"A minimum of {required_sessions} consistent sessions required before progression. "
                "Continue current protocol."
            ),
            can_progress_stage=False,
        )

    # Check pain trending down (load tolerance improving)
    pain_trending_down = _check_pain_trend(recent_logs)

    # Check improved capacity
    capacity_improved = calf_raise_reps_current > calf_raise_reps_baseline

    # Override: under-reporting (low pain + poor performance → block)
    under_reporting = (worst_recent_pain <= 1 and calf_raise_reps_current < calf_raise_reps_baseline)
    # Override: over-reporting (high pain + strong performance → cautious progress)
    over_reporting = (worst_recent_pain >= 4 and calf_raise_reps_current > calf_raise_reps_baseline + 5)

    if under_reporting:
        return ProgressionAssessment(
            decision=Decision.STAY,
            current_stage=current_stage,
            proposed_stage=current_stage,
            rationale=(
                "Under-reporting detected: very low pain but declining performance. "
                "Progression blocked. Reassess objectively."
            ),
            override_applied="under_reporting",
            can_progress_stage=False,
        )

    if over_reporting:
        return ProgressionAssessment(
            decision=Decision.CAUTION,
            current_stage=current_stage,
            proposed_stage=current_stage,
            rationale=(
                "Over-reporting detected: high pain but strong performance. "
                "Cautious progression only. Discuss with clinician."
            ),
            override_applied="over_reporting",
            can_progress_stage=False,
        )

    # Stable irritability check (not HIGH)
    stable_irritability = current_irritability != Irritability.HIGH

    # All gates for stage progression
    can_progress = (
        pain_trending_down
        and capacity_improved
        and stable_irritability
        and consistent_sessions >= required_sessions
        and not conservative_bias  # extra gate for conservative cases
    )

    # Allow conservative to progress but at slower threshold
    if conservative_bias and consistent_sessions >= 6 and pain_trending_down and capacity_improved:
        can_progress = True

    proposed_stage = min(3, current_stage + 1) if can_progress else current_stage

    rationale_parts = [
        f"Pain is {worst_recent_pain}/10 (acceptable range). "
        f"{consistent_sessions} sessions logged."
    ]
    if capacity_improved:
        rationale_parts.append(
            f"Calf raise capacity improved from {calf_raise_reps_baseline} to {calf_raise_reps_current} reps."
        )
    else:
        rationale_parts.append("Calf raise capacity not yet improved — stage progression blocked.")
    if pain_trending_down:
        rationale_parts.append("Pain is trending downward — improved load tolerance confirmed.")
    if can_progress and proposed_stage > current_stage:
        rationale_parts.append(
            f"All progression gates met. Advancing to Stage {proposed_stage}."
        )
    else:
        if not can_progress:
            rationale_parts.append("Continue Stage {} to build further exposure.".format(current_stage))

    return ProgressionAssessment(
        decision=Decision.GO if can_progress else Decision.STAY,
        current_stage=current_stage,
        proposed_stage=proposed_stage,
        rationale=" ".join(rationale_parts),
        can_progress_stage=can_progress,
    )


def _check_pain_trend(logs: list[dict]) -> bool:
    """
    Returns True if pain is trending downward over the last N logs.
    Uses simple comparison: average of first half vs second half.
    """
    if len(logs) < 2:
        return False
    scores = [
        max(log.get("pain_during", 0), log.get("pain_after", 0), log.get("next_day_pain", 0))
        for log in logs
    ]
    mid = len(scores) // 2
    first_half_avg = sum(scores[:mid]) / max(1, mid)
    second_half_avg = sum(scores[mid:]) / max(1, len(scores) - mid)
    return second_half_avg < first_half_avg


# ---------------------------------------------------------------------------
# Update Irritability from Daily Log
# ---------------------------------------------------------------------------

def update_irritability_from_log(
    pain_during: int,
    pain_after: int,
    next_day_pain: int,
) -> str:
    """Re-classify irritability from a single daily log entry."""
    return classify_irritability(pain_during, pain_after, next_day_pain)


# ---------------------------------------------------------------------------
# Exercise Selection with Dosing
# ---------------------------------------------------------------------------

def _lib_ex_to_plan_format(lib_ex: dict) -> dict:
    """Convert a library exercise dict to the flat plan/compliance format."""
    dosage = lib_ex.get("dosage_defaults") or {}
    return {
        "ex_id":       lib_ex.get("ex_id", lib_ex.get("id", "")),
        "name":        lib_ex.get("exercise_name", ""),
        "type":        lib_ex.get("loading_profile", lib_ex.get("category", "")),
        "description": lib_ex.get("patient_facing_explanation") or lib_ex.get("setup_instructions", ""),
        "sets":        dosage.get("sets", 3),
        "reps":        dosage.get("reps_or_hold_time", ""),
        "tempo":       dosage.get("tempo", ""),
        "notes":       lib_ex.get("contraindications_or_cautions", ""),
    }


def select_exercises_for_plan(
    stage: int,
    irritability: str,
    conservative_bias: bool,
    lib_exercises: Optional[list] = None,
    insertional: bool = False,
) -> list[dict]:
    """
    Select exercises for the given stage from the 47-exercise library.

    When lib_exercises is supplied (loaded from DB), uses select_initial_exercises()
    to pick clinically appropriate exercises and returns them in plan/compliance format.
    Falls back to the legacy hardcoded dict only when lib_exercises is None.
    """
    if lib_exercises is not None:
        selected = select_initial_exercises(
            lib_exercises, irritability, stage, insertional, limit=4
        )
        return [_lib_ex_to_plan_format(ex) for ex in selected]

    # Legacy fallback — only reached when lib_exercises is unavailable
    from app.data.exercises import EXERCISES
    base_exercises = EXERCISES.get(stage, EXERCISES[1])
    return [apply_dosing_modifier(ex, irritability) for ex in base_exercises]


# ---------------------------------------------------------------------------
# KB Tag Matching for Citation Selection
# ---------------------------------------------------------------------------

STAGE_TAGS = {
    1: ["stage_1", "isometric", "slow_isotonic", "pain_relief", "irritability"],
    2: ["stage_2", "eccentric", "heavy_slow_resistance", "strength", "alfredson"],
    3: ["stage_3", "plyometric", "reactive_strength", "energy_storage"],
}


def select_relevant_kb_tags(stage: int, irritability: str) -> list[str]:
    """Return KB tags relevant to the current stage and irritability."""
    tags = list(STAGE_TAGS.get(stage, []))
    tags.append("load_management")
    if irritability == Irritability.HIGH:
        tags.append("irritability")
    return tags


# ---------------------------------------------------------------------------
# Session Tolerance Rule Engine
# ---------------------------------------------------------------------------

def evaluate_session_tolerance(report: dict) -> dict:
    """
    Evaluate how the tendon responded to the prescribed session load.
    Returns a session tolerance signal: go | stay | caution | stop.

    Rules evaluated in strict priority order — first match wins:
      1. STOP    (safety threshold breached)
      2. CAUTION (load or symptom response exceeded acceptable threshold)
      3. GO      (all optimal tolerance criteria met)
      4. STAY    (unconditional default)

    report keys: prescribed, completed, symptoms, baseline
    Spec: /specs/session-rule-engine.md
    """
    prescribed = report["prescribed"]
    completed  = report["completed"]
    symptoms   = report["symptoms"]
    baseline   = report["baseline"]

    # Derived variables — computed once, used directly in all rule conditions
    prescribed_sets = prescribed.get("sets", 1) or 1
    dose_match = completed.get("sets", 0) / prescribed_sets
    next_morning_pain_change = symptoms.get("nextMorningPain", 0) - baseline.get("usualMorningPain", 0)
    next_morning_stiffness_change = symptoms.get("nextMorningStiffness", 0) - baseline.get("usualMorningStiffness", 0)
    overdosed  = dose_match > 1.2
    underdosed = dose_match < 0.8

    allowed_pain = prescribed.get("allowedPain", 4)

    # --- STOP rules ---

    if symptoms.get("sharpPain"):
        return {
            "signal": "stop",
            "reason": "Sharp pain reported during session — possible acute injury or structural irritation.",
            "action": "Stop all loading immediately. Do not train. Seek clinical review before continuing.",
        }

    if completed.get("abandonedDueToPain"):
        return {
            "signal": "stop",
            "reason": "Session was abandoned due to pain — the tendon did not tolerate the prescribed load.",
            "action": "Do not repeat this session at the same dose. Reduce load significantly or seek clinical review before the next attempt.",
        }

    if symptoms.get("limpOrFunctionLoss"):
        return {
            "signal": "stop",
            "reason": "Limping or functional loss reported — tendon load capacity compromised.",
            "action": "Cease loading. Rest and monitor. If limp persists beyond 24 hours, seek clinical review.",
        }

    if symptoms.get("swellingIncrease"):
        return {
            "signal": "stop",
            "reason": "Swelling increase reported — inflammatory response exceeds acceptable threshold.",
            "action": "Rest and apply ice. Do not load until swelling has resolved. Seek review if swelling persists.",
        }

    if next_morning_pain_change >= 4:
        return {
            "signal": "stop",
            "reason": (
                f"Next morning pain increased by {next_morning_pain_change} points above baseline "
                f"(baseline: {baseline.get('usualMorningPain', 0)}/10, reported: {symptoms.get('nextMorningPain', 0)}/10) "
                "— severe adverse response."
            ),
            "action": "Stop loading immediately. Do not progress. Seek clinical review.",
        }

    # --- CAUTION rules ---

    if symptoms.get("painDuring", 0) > allowed_pain + 2:
        return {
            "signal": "caution",
            "reason": (
                f"Pain during session ({symptoms.get('painDuring', 0)}/10) exceeded the allowed pain threshold "
                f"by more than 2 points (allowed: {allowed_pain}/10, limit: {allowed_pain + 2}/10)."
            ),
            "action": "Reduce load by 20% next session. Do not increase volume or intensity until pain during exercise is consistently within the allowed limit.",
        }

    if next_morning_pain_change >= 2:
        return {
            "signal": "caution",
            "reason": (
                f"Next morning pain increased by {next_morning_pain_change} points above baseline "
                f"(baseline: {baseline.get('usualMorningPain', 0)}/10, reported: {symptoms.get('nextMorningPain', 0)}/10)."
            ),
            "action": "Repeat session at current or reduced load. Monitor next-morning response before progressing.",
        }

    if next_morning_stiffness_change >= 2:
        return {
            "signal": "caution",
            "reason": (
                f"Next morning stiffness increased by {next_morning_stiffness_change} points above baseline "
                f"(baseline: {baseline.get('usualMorningStiffness', 0)}/10, reported: {symptoms.get('nextMorningStiffness', 0)}/10)."
            ),
            "action": "Maintain current load. Allow full warm-up before loading. Review if stiffness persists across multiple sessions.",
        }

    if underdosed:
        return {
            "signal": "caution",
            "reason": (
                f"Completed sets ({completed.get('sets', 0)}) were less than 80% of the prescribed dose "
                f"({prescribed_sets} sets). Dose match: {round(dose_match * 100)}%."
            ),
            "action": "Investigate reason for under-dosing. If due to fatigue or discomfort, repeat session at the prescribed dose before progressing.",
        }

    if overdosed:
        return {
            "signal": "caution",
            "reason": (
                f"Completed sets ({completed.get('sets', 0)}) exceeded 120% of the prescribed dose "
                f"({prescribed_sets} sets). Overdosing risks a delayed adverse tendon response even when immediate symptoms appear minimal."
            ),
            "action": "Return to the prescribed dose next session. Do not exceed the prescription — tendon adaptation requires consistent, controlled loading.",
        }

    # --- GO — all five conditions must be true ---

    if (
        dose_match >= 0.9
        and symptoms.get("painDuring", 0) <= allowed_pain
        and next_morning_pain_change <= 1
        and next_morning_stiffness_change <= 1
        and not symptoms.get("swellingIncrease")
    ):
        return {
            "signal": "go",
            "reason": (
                f"Session well-tolerated. Prescribed dose completed within pain limits with minimal next-day response. "
                f"Pain during session was {symptoms.get('painDuring', 0)}/10 (allowed: {allowed_pain}/10). "
                "Next morning pain and stiffness were within 1 point of baseline."
            ),
            "action": "Proceed with next session as prescribed. Progress load according to plan if all sessions remain consistent.",
        }

    # --- STAY (default) ---

    return {
        "signal": "stay",
        "reason": "Session completed with acceptable response but not within optimal tolerance parameters. No caution-level thresholds were breached.",
        "action": "Repeat the current session at the same prescribed dose before considering progression.",
    }


# ---------------------------------------------------------------------------
# Exercise Library — Progression / Regression Engine
# ---------------------------------------------------------------------------

# Decision constants for exercise progression
class ExerciseDecision:
    PROGRESS  = "PROGRESS"
    STAY      = "STAY"
    REGRESS   = "REGRESS"
    HOLD      = "HOLD"       # Stay but reduce dose — irritability too high to progress or regress safely


# ---------------------------------------------------------------------------
# WBLT — Dorsiflexion Restriction Assessment and Stretch Indication
# ---------------------------------------------------------------------------

# Evidence-based WBLT thresholds (cm from wall)
# Sources: Bennell et al. 1998, Gatt et al. 2017, Riddle et al. 2003
WBLT_NORMAL_CM = 10           # ≥10 cm = normal
WBLT_MILD_RESTRICTION_CM = 8  # 8–9.9 cm = mild restriction
WBLT_MOD_RESTRICTION_CM = 5   # 5–7.9 cm = moderate restriction
                               # <5 cm = severe restriction
WBLT_ASYMMETRY_THRESHOLD = 2  # ≥2 cm side-to-side = clinically significant


def classify_wblt(
    wblt_cm: Optional[float],
    wblt_cm_unaffected: Optional[float] = None,
) -> dict:
    """
    Classify dorsiflexion restriction severity from WBLT measurements.

    Returns dict with:
      severity        : "normal" | "mild" | "moderate" | "severe" | "unknown"
      has_asymmetry   : bool
      asymmetry_cm    : float | None
      stretch_indicated : bool
      stretch_priority  : "primary" | "adjunct" | "not_indicated"
      rationale       : str
    """
    if wblt_cm is None:
        return {
            "severity": "unknown",
            "has_asymmetry": False,
            "asymmetry_cm": None,
            "stretch_indicated": False,
            "stretch_priority": "not_indicated",
            "rationale": "No WBLT measurement recorded. Reassess dorsiflexion range to determine stretch indication.",
        }

    wblt_cm = float(wblt_cm)

    # Severity
    if wblt_cm >= WBLT_NORMAL_CM:
        severity = "normal"
    elif wblt_cm >= WBLT_MILD_RESTRICTION_CM:
        severity = "mild"
    elif wblt_cm >= WBLT_MOD_RESTRICTION_CM:
        severity = "moderate"
    else:
        severity = "severe"

    # Asymmetry
    asymmetry_cm = None
    has_asymmetry = False
    if wblt_cm_unaffected is not None:
        asymmetry_cm = round(float(wblt_cm_unaffected) - wblt_cm, 1)
        has_asymmetry = asymmetry_cm >= WBLT_ASYMMETRY_THRESHOLD

    # Stretch indication
    if severity == "normal" and not has_asymmetry:
        stretch_indicated = False
        stretch_priority = "not_indicated"
        rationale = (
            f"WBLT {wblt_cm:.1f} cm — within normal range (≥{WBLT_NORMAL_CM} cm). "
            "Dorsiflexion restriction is not a primary impairment. "
            "Stretching is not a priority for this presentation."
        )
    elif severity == "normal" and has_asymmetry:
        stretch_indicated = True
        stretch_priority = "adjunct"
        rationale = (
            f"WBLT {wblt_cm:.1f} cm (affected) vs {wblt_cm_unaffected:.1f} cm (unaffected) — "
            f"{asymmetry_cm:.1f} cm side-to-side deficit exceeds the {WBLT_ASYMMETRY_THRESHOLD} cm clinical threshold. "
            "Include calf stretching as an adjunct to address the asymmetry."
        )
    elif severity == "mild":
        stretch_indicated = True
        stretch_priority = "adjunct"
        rationale = (
            f"WBLT {wblt_cm:.1f} cm — mild dorsiflexion restriction ({WBLT_MILD_RESTRICTION_CM}–{WBLT_NORMAL_CM - 0.1:.1f} cm range). "
            + (f"Side-to-side deficit of {asymmetry_cm:.1f} cm also present. " if has_asymmetry else "")
            + "Include calf stretching as an adjunct alongside loading exercises. "
            "Gastrocnemius and soleus stretching recommended to restore ROM and reduce cumulative tendon load."
        )
    else:  # moderate or severe
        stretch_indicated = True
        stretch_priority = "primary"
        rationale = (
            f"WBLT {wblt_cm:.1f} cm — {'moderate' if severity == 'moderate' else 'severe'} dorsiflexion restriction "
            f"({'<' + str(WBLT_MOD_RESTRICTION_CM) if severity == 'severe' else str(WBLT_MOD_RESTRICTION_CM) + '–' + str(WBLT_MILD_RESTRICTION_CM - 0.1)[:3]} cm range). "
            + (f"Side-to-side deficit of {asymmetry_cm:.1f} cm. " if has_asymmetry else "")
            + "Dorsiflexion restriction is a primary impairment. Calf stretching should be a priority alongside loading. "
            "Restricted dorsiflexion prolongs peak Achilles tendon strain during gait and increases cumulative load."
        )

    return {
        "severity": severity,
        "has_asymmetry": has_asymmetry,
        "asymmetry_cm": asymmetry_cm,
        "stretch_indicated": stretch_indicated,
        "stretch_priority": stretch_priority,
        "rationale": rationale,
    }


def select_stretch_exercises(
    exercises: list[dict],
    wblt_result: dict,
    insertional: bool,
) -> list[dict]:
    """
    Select appropriate stretching exercises based on WBLT result and insertional status.

    Rules:
    - If not stretch_indicated: return []
    - If insertional: only exercises with insertional_safe=True (bent-knee / non-WB stretches)
    - If not insertional: include gastroc and soleus stretches graded by severity
    - Severe restriction → include all stretch types (primary priority)
    - Mild restriction   → soleus + one gastroc stretch (adjunct)
    """
    if not wblt_result.get("stretch_indicated"):
        return []

    stretch_exs = [
        ex for ex in exercises
        if ex.get("category") == "flexibility_mobility"
        and "wblt_indicated" in ex.get("decision_rules_tags", [])
    ]

    if insertional:
        # Only insertional-safe stretches (bent-knee, seated, non-end-range)
        stretch_exs = [ex for ex in stretch_exs if ex.get("insertional_safe")]

    severity = wblt_result.get("severity", "mild")

    # For mild/adjunct: prefer bilateral and lower difficulty first
    stretch_exs.sort(key=lambda ex: (ex.get("difficulty_level", 1), ex.get("exercise_name", "")))

    if severity in ("moderate", "severe"):
        return stretch_exs  # All appropriate stretches
    else:
        # Mild/adjunct: one soleus + one gastroc (if non-insertional)
        out = []
        has_soleus = has_gastroc = False
        for ex in stretch_exs:
            tags = ex.get("decision_rules_tags", [])
            if "soleus_stretch" in tags and not has_soleus:
                out.append(ex)
                has_soleus = True
            elif "gastroc_stretch" in tags and not has_gastroc and not insertional:
                out.append(ex)
                has_gastroc = True
            if has_soleus and (has_gastroc or insertional):
                break
        return out


def filter_exercises_by_state(
    exercises: list[dict],
    irritability: str,
    insertional: bool,
    available_equipment: Optional[list[str]] = None,
) -> list[dict]:
    """
    Filter exercise library entries to those appropriate for the current patient state.

    Args:
        exercises:          Full exercise library as list of dicts (pre-loaded from DB).
        irritability:       "high" | "moderate" | "low"
        insertional:        True if patient has insertional Achilles presentation.
        available_equipment: List of available equipment strings. None means no restriction.

    Returns subset of exercises that match all criteria.
    """
    out = []
    for ex in exercises:
        irr_list = ex.get("irritability_appropriateness", [])
        if isinstance(irr_list, str):
            try:
                irr_list = json.loads(irr_list)
            except (json.JSONDecodeError, TypeError):
                irr_list = []

        # Filter: exercise must be appropriate for this irritability level
        if irritability not in irr_list:
            continue

        # Filter: insertional safety
        if insertional and not ex.get("insertional_safe", True):
            continue

        # Filter: equipment (skip if equipment required but not available)
        if available_equipment is not None:
            req = (ex.get("required_equipment") or "").lower()
            bodyweight_only = req in ("", "none", "bodyweight", "wall or support surface")
            if not bodyweight_only:
                # Check if any piece of available equipment satisfies the requirement
                match = any(eq.lower() in req or req in eq.lower() for eq in available_equipment)
                if not match:
                    continue

        out.append(ex)

    return out


def evaluate_exercise_progression(
    current_exercise: dict,
    session_signal: str,        # "go" | "stay" | "caution" | "stop"
    irritability: str,
    insertional: bool,
    sessions_at_current: int,
    all_exercises: Optional[list[dict]] = None,
) -> dict:
    """
    Determine whether to progress, stay, or regress on a specific exercise.

    Uses:
      - session_signal  from evaluate_session_tolerance()
      - irritability    re-classified from most recent log
      - insertional     from onboarding (presentation type)
      - sessions_at_current  number of times this exercise has been performed

    Returns dict with:
      decision     : PROGRESS | STAY | REGRESS | HOLD
      target_ex_id : exercise ID to assign next session (may be same as current)
      rationale    : plain-text explanation
    """
    ex_id      = current_exercise.get("ex_id") or current_exercise.get("id", "")
    ex_name    = current_exercise.get("exercise_name", ex_id)
    prog_opts  = current_exercise.get("progression_options", [])
    regr_opts  = current_exercise.get("regression_options", [])
    if isinstance(prog_opts, str):
        try: prog_opts = json.loads(prog_opts)
        except Exception: prog_opts = []
    if isinstance(regr_opts, str):
        try: regr_opts = json.loads(regr_opts)
        except Exception: regr_opts = []

    irr_list = current_exercise.get("irritability_appropriateness", [])
    if isinstance(irr_list, str):
        try: irr_list = json.loads(irr_list)
        except Exception: irr_list = []

    # ── Safety override: insertional + high dorsiflexion exercise ──
    requires_df = current_exercise.get("requires_dorsiflexion_depth", "none")
    if insertional and requires_df in ("moderate", "high"):
        # Even if signal is GO — this exercise is not safe for insertional presentation
        target = regr_opts[0] if regr_opts else ex_id
        return {
            "decision":     ExerciseDecision.REGRESS,
            "target_ex_id": target,
            "rationale": (
                f"{ex_name} requires {'moderate' if requires_df == 'moderate' else 'deep'} dorsiflexion, "
                "which compresses the insertion of the Achilles tendon and is contraindicated for insertional "
                "presentations. Regressing to a safer alternative."
            ),
        }

    # ── STOP signal → REGRESS immediately ──
    if session_signal == "stop":
        target = regr_opts[0] if regr_opts else ex_id
        return {
            "decision":     ExerciseDecision.REGRESS if regr_opts else ExerciseDecision.HOLD,
            "target_ex_id": target,
            "rationale": (
                "Session was stopped due to adverse pain response. "
                "Regressing to a less demanding exercise to protect the tendon during recovery."
            ),
        }

    # ── CAUTION signal → STAY (do not progress) ──
    if session_signal == "caution":
        return {
            "decision":     ExerciseDecision.STAY,
            "target_ex_id": ex_id,
            "rationale": (
                "Session signal is CAUTION — pain or compliance issues prevent progression. "
                "Repeat this exercise at the same dose next session and re-evaluate."
            ),
        }

    # ── Irritability mismatch: current exercise is no longer appropriate ──
    # E.g., irritability increased since last session and exercise is not high-irritability safe
    if irritability == Irritability.HIGH and "high" not in irr_list:
        target = regr_opts[0] if regr_opts else ex_id
        return {
            "decision":     ExerciseDecision.REGRESS,
            "target_ex_id": target,
            "rationale": (
                f"Irritability has increased to HIGH. {ex_name} is not rated appropriate for high irritability. "
                "Regressing to a lower-load option to protect the tendon."
            ),
        }

    # ── STAY signal → STAY (no progression) ──
    if session_signal == "stay":
        return {
            "decision":     ExerciseDecision.STAY,
            "target_ex_id": ex_id,
            "rationale": (
                "Session completed with acceptable response but not within optimal parameters. "
                "Repeat this exercise at the current dose before considering progression."
            ),
        }

    # ── GO signal: assess readiness to progress ──
    # Minimum exposure gate: require ≥ 3 sessions at this exercise before progression
    if sessions_at_current < 3:
        return {
            "decision":     ExerciseDecision.STAY,
            "target_ex_id": ex_id,
            "rationale": (
                f"GO signal received. Only {sessions_at_current} session(s) at {ex_name}. "
                "A minimum of 3 consistent sessions is required before progressing. "
                "Continue current exercise to build adequate tendon adaptation."
            ),
        }

    # Ready to progress — find a valid progression target
    if prog_opts:
        # If insertional, filter out progressions that require high dorsiflexion
        valid_progs = prog_opts
        if insertional and all_exercises:
            ex_map = {e.get("ex_id") or e.get("id"): e for e in all_exercises}
            valid_progs = [
                eid for eid in prog_opts
                if ex_map.get(eid, {}).get("requires_dorsiflexion_depth", "none") not in ("moderate", "high")
            ]
        target = valid_progs[0] if valid_progs else ex_id
        progressed = target != ex_id
        return {
            "decision":     ExerciseDecision.PROGRESS if progressed else ExerciseDecision.STAY,
            "target_ex_id": target,
            "rationale": (
                (
                    f"All progression criteria met. Advancing from {ex_name} to the next level exercise. "
                    "Continue to monitor pain response — acceptable pain during loading is ≤3/10."
                ) if progressed else (
                    f"GO signal received but no valid progression found from {ex_name} "
                    "(all options filtered for insertional safety). Staying at current exercise."
                )
            ),
        }

    # No progression options defined — stay at current exercise
    return {
        "decision":     ExerciseDecision.STAY,
        "target_ex_id": ex_id,
        "rationale": (
            f"GO signal received but {ex_name} has no defined progression options. "
            "Continue current exercise and discuss advancement with your clinician."
        ),
    }


def select_initial_exercises(
    exercises: list[dict],
    irritability: str,
    stage: int,
    insertional: bool,
    available_equipment: Optional[list[str]] = None,
    limit: int = 4,
) -> list[dict]:
    """
    Select the initial set of exercises for a new rehab plan.

    Filters by irritability, insertional safety, and stage-appropriate difficulty level.
    Returns up to `limit` exercises ordered by difficulty_level (easiest first).

    Stage → max difficulty_level mapping:
      Stage 1 → levels 1–2
      Stage 2 → levels 2–4
      Stage 3 → levels 5–8
    """
    STAGE_DIFFICULTY_MAP = {1: (1, 2), 2: (2, 4), 3: (5, 8)}
    min_diff, max_diff = STAGE_DIFFICULTY_MAP.get(stage, (1, 2))

    candidates = filter_exercises_by_state(exercises, irritability, insertional, available_equipment)
    candidates = [
        ex for ex in candidates
        if min_diff <= ex.get("difficulty_level", 1) <= max_diff
    ]
    candidates.sort(key=lambda ex: ex.get("difficulty_level", 1))
    return candidates[:limit]


# ---------------------------------------------------------------------------
# Recovery Timeline
# ---------------------------------------------------------------------------

import math as _math


def compute_recovery_timeline(
    stage: int,
    irritability: str,
    conservative_bias: bool,
    injury_duration: str,
    goal_level: str,
    risk_factors,
) -> dict:
    """
    Compute an evidence-based recovery timeline for the user.

    Parameters
    ----------
    stage            : current rehab stage (1, 2, or 3)
    irritability     : "high" / "moderate" / "low"
    conservative_bias: whether conservative bias is applied
    injury_duration  : "acute" / "subacute" / "chronic"
    goal_level       : "daily_function" / "recreational" / "competitive" / "elite"
    risk_factors     : list of risk factor strings (or bool — truthy means conservative)

    Returns a dict with keys: phases, total_min_weeks, total_max_weeks,
    goal_level, confidence, caveats.
    """
    # Normalise goal_level
    valid_goal_levels = {"daily_function", "recreational", "competitive", "elite"}
    if goal_level not in valid_goal_levels:
        goal_level = "recreational"

    # --- Base phase durations by irritability ---
    stage1_ranges = {
        Irritability.HIGH:     (4, 6),
        Irritability.MODERATE: (3, 4),
        Irritability.LOW:      (2, 3),
    }
    stage2_ranges = {
        Irritability.HIGH:     (10, 12),
        Irritability.MODERATE: (8, 10),
        Irritability.LOW:      (6, 8),
    }
    stage3_ranges = {
        "recreational": (6, 10),
        "competitive":  (10, 14),
        "elite":        (14, 20),
    }

    irr = irritability if irritability in stage1_ranges else Irritability.MODERATE

    # --- Build phases list ---
    phases = []

    # Stage 1 — included unless user is already at stage 2 or 3
    if stage <= 1 and goal_level in ("daily_function", "recreational", "competitive", "elite"):
        mn, mx = stage1_ranges[irr]
        if conservative_bias:
            mx = _math.ceil(mx * 1.25)
        phases.append({
            "stage": 1,
            "name": "Capacity Initiation",
            "duration_weeks_min": mn,
            "duration_weeks_max": mx,
            "description": "Isometrics and slow isotonic loading to reduce irritability and restore basic tendon capacity.",
        })

    # Stage 2 — included unless user is already at stage 3, and goal requires it
    if stage <= 2 and goal_level in ("recreational", "competitive", "elite"):
        mn, mx = stage2_ranges[irr]
        if conservative_bias:
            mx = _math.ceil(mx * 1.25)
        phases.append({
            "stage": 2,
            "name": "Strength Development",
            "duration_weeks_min": mn,
            "duration_weeks_max": mx,
            "description": "Heavy slow resistance and eccentric loading to build tensile strength and tendon stiffness.",
        })

    # Stage 3 — only for recreational / competitive / elite
    if goal_level in ("recreational", "competitive", "elite"):
        mn, mx = stage3_ranges.get(goal_level, stage3_ranges["recreational"])
        if conservative_bias:
            mx = _math.ceil(mx * 1.25)
        phases.append({
            "stage": 3,
            "name": "Energy Storage & Release",
            "duration_weeks_min": mn,
            "duration_weeks_max": mx,
            "description": "Plyometric and reactive strength training to restore the tendon's capacity for running, jumping, and sport-specific demands.",
        })

    # If user is at stage 2, they have already passed stage 1 — remove it
    if stage == 2:
        phases = [p for p in phases if p["stage"] != 1]
    # If user is at stage 3, they have already passed stages 1 & 2 — remove them
    elif stage == 3:
        phases = [p for p in phases if p["stage"] == 3]

    # Handle daily_function — only Stage 1 (or up to user's current stage), no Stage 3
    if goal_level == "daily_function":
        phases = [p for p in phases if p["stage"] != 3]
        # If stage 1 is included but user is past it, nothing remains — just show current stage
        if not phases and stage == 1:
            mn, mx = stage1_ranges[irr]
            if conservative_bias:
                mx = _math.ceil(mx * 1.25)
            phases.append({
                "stage": 1,
                "name": "Capacity Initiation",
                "duration_weeks_min": mn,
                "duration_weeks_max": mx,
                "description": "Isometrics and slow isotonic loading to reduce irritability and restore basic tendon capacity.",
            })

    # Totals
    total_min = sum(p["duration_weeks_min"] for p in phases)
    total_max = sum(p["duration_weeks_max"] for p in phases)

    # Confidence
    if irritability == Irritability.LOW and injury_duration == "chronic":
        confidence = "high"
    elif injury_duration == "acute":
        confidence = "low"
    else:
        confidence = "moderate"

    # Caveats
    caveats = [
        "Timeline assumes consistent adherence to the prescribed loading programme."
    ]
    if injury_duration == "acute":
        caveats.append(
            "Acute injuries are less predictable — the timeline may extend if irritability does not reduce as expected."
        )
    if conservative_bias:
        caveats.append(
            "One or more risk factors are present — recovery may take longer and progression should be conservative."
        )
    if goal_level in ("competitive", "elite"):
        caveats.append(
            "Return to competitive sport requires formal clearance from a physiotherapist or sports medicine physician."
        )

    return {
        "phases": phases,
        "total_min_weeks": total_min,
        "total_max_weeks": total_max,
        "goal_level": goal_level,
        "confidence": confidence,
        "caveats": caveats,
    }


def compute_phase_exit_checklist(
    stage: int,
    session_logs: list,
    visa_history: list | None = None,
) -> dict:
    """
    Build a phase-exit checklist for the user's current stage.

    Reads phase_exit_criteria from knowledge_base.json, auto-evaluates
    criteria where auto_checkable=True using session_logs and visa_history,
    and returns a structured checklist dict for the dashboard.
    """
    import os as _os

    # Load KB
    _kb_path = _os.path.join(_os.path.dirname(__file__), "../data/knowledge_base.json")
    try:
        with open(_kb_path) as _f:
            _kb = json.load(_f)
    except Exception:
        return {}

    # Map stage to transition label
    _transition_map = {
        1: "stage_1_to_stage_2",
        2: "stage_2_to_stage_3",
        3: "stage_3_to_return_to_sport",
    }
    _target = _transition_map.get(stage)
    if not _target:
        return {}

    # Gather all criteria for this transition (deduplicate by id)
    _seen: set = set()
    _all: list = []
    for _entry in _kb:
        for _block in _entry.get("phase_exit_criteria", []):
            if _block.get("transition") == _target:
                for _c in _block.get("criteria", []):
                    if _c["id"] not in _seen:
                        _seen.add(_c["id"])
                        _merged = dict(_c)
                        _merged["kb_source"] = _entry.get("id", "")
                        _all.append(_merged)

    # ── Helpers ───────────────────────────────────────────────────────────
    def _recent(logs, key, n):
        return [lg[key] for lg in logs if lg.get(key) is not None][-n:] if logs else []

    def _cmp(val, op, thr):
        return (val <= thr if op == "<=" else
                val < thr  if op == "<"  else
                val >= thr if op == ">=" else
                val > thr  if op == ">"  else False)

    # ── Evaluate ──────────────────────────────────────────────────────────
    _logs = session_logs or []
    _visa = visa_history or []
    _results = []

    for _c in _all:
        _r = dict(_c)
        _r["status"] = "manual"
        _r["current_value"] = None

        if not _c.get("auto_checkable"):
            _results.append(_r)
            continue

        _metric = _c.get("metric", "")
        _thr = _c.get("threshold")
        _op = _c.get("operator", "<=")
        _n = _c.get("sessions_required", 1)

        if _metric == "pain_during":
            _vals = _recent(_logs, "pain_during", _n)
            if len(_vals) >= _n:
                _r["status"] = "pass" if all(_cmp(v, _op, _thr) for v in _vals) else "fail"
                _r["current_value"] = _vals[-1]
            else:
                _r["status"] = "insufficient_data"

        elif _metric == "pain_next_day":
            _vals = _recent(_logs, "next_day_pain", _n)
            if len(_vals) >= _n:
                _r["status"] = "pass" if all(_cmp(v, _op, _thr) for v in _vals) else "fail"
                _r["current_value"] = _vals[-1]
            else:
                _r["status"] = "insufficient_data"

        elif _metric == "visa_a_score":
            if _visa:
                _val = _visa[-1].get("score", 0)
                _r["status"] = "pass" if _cmp(_val, _op, _thr) else "fail"
                _r["current_value"] = _val
            else:
                _r["status"] = "insufficient_data"

        elif _metric == "visa_a_4wk_improvement":
            if len(_visa) >= 2:
                _imp = _visa[-1].get("score", 0) - _visa[0].get("score", 0)
                _r["status"] = "pass" if _cmp(_imp, _op, _thr) else "fail"
                _r["current_value"] = _imp
            else:
                _r["status"] = "insufficient_data"

        elif _metric in ("sessions_count_stage_2", "total_sessions_logged", "sessions_count_stage_1"):
            _cnt = len(_logs)
            _r["status"] = "pass" if _cmp(_cnt, _op, _thr) else "fail"
            _r["current_value"] = _cnt

        elif _metric == "exercise_sets_compliance":
            _recent_logs = _logs[-_n:] if len(_logs) >= _n else _logs
            _ok = 0
            for _lg in _recent_logs:
                _exs = _lg.get("exercises_parsed", [])
                if _exs:
                    _avg = sum(e.get("sets_compliance") or 0 for e in _exs) / len(_exs)
                    if _cmp(_avg, _op, _thr):
                        _ok += 1
            _r["status"] = "pass" if _ok >= _n else "fail"
            _r["current_value"] = _ok

        elif _metric == "pain_weekly_trend":
            # Check if weekly average pain is stable or improving (not worsening)
            if len(_logs) >= 6:
                _week_a = [lg.get("pain_during", 5) for lg in _logs[-6:-3]]
                _week_b = [lg.get("pain_during", 5) for lg in _logs[-3:]]
                _avg_a = sum(_week_a) / len(_week_a) if _week_a else 5
                _avg_b = sum(_week_b) / len(_week_b) if _week_b else 5
                _r["status"] = "pass" if _avg_b <= _avg_a + 0.5 else "fail"
                _r["current_value"] = round(_avg_b, 1)
            else:
                _r["status"] = "insufficient_data"

        else:
            _r["status"] = "insufficient_data"

        _results.append(_r)

    # ── Summary stats ─────────────────────────────────────────────────────
    _pass = sum(1 for r in _results if r["status"] == "pass")
    _fail = sum(1 for r in _results if r["status"] == "fail")
    _manual = sum(1 for r in _results if r["status"] == "manual")
    _no_data = sum(1 for r in _results if r["status"] == "insufficient_data")
    _total = len(_results)
    _auto_total = _pass + _fail + _no_data

    _stage_labels = {
        1: ("Stage 1 → Stage 2", "Strength Development"),
        2: ("Stage 2 → Stage 3", "Reactive & Return to Running"),
        3: ("Stage 3 → Return to Sport", "Full Sport Clearance"),
    }
    _from_label, _to_label = _stage_labels.get(stage, ("Current", "Next"))

    return {
        "transition": _target,
        "from_label": _from_label,
        "to_label": _to_label,
        "criteria": _results,
        "pass_count": _pass,
        "fail_count": _fail,
        "manual_count": _manual,
        "no_data_count": _no_data,
        "total_count": _total,
        "auto_pass_rate": round((_pass / _auto_total * 100) if _auto_total > 0 else 0),
        "ready_auto": _fail == 0 and _auto_total > 0,
        "needs_assessment": _manual > 0,
    }
