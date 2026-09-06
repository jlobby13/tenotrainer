"""
Regression coverage for the pre-Milestone-4 "UNKNOWN != ZERO" cleanup.

No test framework is set up for the Python side of this repo — this is a
plain, dependency-free script (run with `python3 -m app.tests.test_unknown_not_zero`
from the repo root), mirroring the same style already used for the
TypeScript pure-function tests.

Covers: missing values stay None (never 0), explicit 0 is preserved,
aggregation/trend never treats missing data as symptom-free, and incomplete
required data can never produce a normal favorable tolerance or progression
result.
"""
from app.engine.rules import (
    classify_irritability,
    update_irritability_from_log,
    run_decision_engine,
    _check_pain_trend,
    evaluate_session_tolerance,
    evaluate_exercise_progression,
    ExerciseDecision,
    Decision,
    Irritability,
)

pass_count = 0
fail_count = 0


def test(name, fn):
    global pass_count, fail_count
    try:
        fn()
        pass_count += 1
        print(f"PASS  {name}")
    except AssertionError as e:
        fail_count += 1
        print(f"FAIL  {name}\n      {e}")
    except Exception as e:
        fail_count += 1
        print(f"ERROR {name}\n      {type(e).__name__}: {e}")


# ---------------------------------------------------------------------------
# 1/2/8. classify_irritability / update_irritability_from_log: missing stays
# missing, explicit 0 stays 0, and complete 0/0/0 is valid data.
# ---------------------------------------------------------------------------

def t_classify_irritability_missing_excluded():
    # next_day_pain unknown; pain_during=2 known -> classified from 2 alone, not max(2, ?, 0)
    result = classify_irritability(2, None, None)
    assert result == Irritability.LOW, f"expected LOW from known-only pain=2, got {result}"


def t_classify_irritability_missing_does_not_mask_high_known_value():
    # A known HIGH value must still classify HIGH even with other fields unknown.
    result = classify_irritability(7, None, None)
    assert result == Irritability.HIGH, f"expected HIGH, got {result}"


def t_classify_irritability_explicit_zero_zero_zero_is_valid_low():
    result = classify_irritability(0, 0, 0)
    assert result == Irritability.LOW


def t_classify_irritability_all_none_raises_rather_than_fabricating():
    try:
        classify_irritability(None, None, None)
        raise AssertionError("expected ValueError, classification silently succeeded")
    except ValueError:
        pass


def t_update_irritability_from_log_accepts_none_delayed_fields():
    result = update_irritability_from_log(6, None, None)
    assert result == Irritability.HIGH


# ---------------------------------------------------------------------------
# 6/7. run_decision_engine: missing latest-log delayed data must defer
# progression (never a normal favorable GO), while STOP/CAUTION safety
# checks still fire eagerly on whatever same-day pain IS known.
# ---------------------------------------------------------------------------

def t_run_decision_engine_defers_progression_when_latest_incomplete():
    logs: list[dict] = [
        {"pain_during": 1, "pain_after": 0, "next_day_pain": 0, "difficulty": 2, "confidence": 4}
        for _ in range(4)
    ]
    # Latest log's delayed fields not yet collected.
    logs.append({"pain_during": 1, "pain_after": None, "next_day_pain": None, "difficulty": 2, "confidence": 4})
    result = run_decision_engine(
        recent_logs=logs, current_stage=1, current_irritability=Irritability.LOW,
        calf_raise_reps_baseline=10, calf_raise_reps_current=15,
    )
    assert result.decision == Decision.STAY, f"expected STAY pending data, got {result.decision}"
    assert result.can_progress_stage is False
    assert "next-morning" in result.rationale.lower() or "not been collected" in result.rationale.lower()


def t_run_decision_engine_stop_still_fires_on_known_high_pain_despite_missing_delayed_fields():
    logs = [{"pain_during": 8, "pain_after": None, "next_day_pain": None, "difficulty": 2, "confidence": 4}]
    result = run_decision_engine(
        recent_logs=logs, current_stage=1, current_irritability=Irritability.LOW,
        calf_raise_reps_baseline=10, calf_raise_reps_current=10,
    )
    assert result.decision == Decision.STOP, f"expected STOP from known pain=8, got {result.decision}"


def t_run_decision_engine_does_not_crash_on_none_values():
    # Historically this would TypeError (max() of int and None) once storage
    # stopped coercing missing values to 0 — must not crash.
    logs = [{"pain_during": 3, "pain_after": None, "next_day_pain": None, "difficulty": 2, "confidence": 4}]
    run_decision_engine(
        recent_logs=logs, current_stage=1, current_irritability=Irritability.LOW,
        calf_raise_reps_baseline=10, calf_raise_reps_current=10,
    )


# ---------------------------------------------------------------------------
# 6. _check_pain_trend: incomplete logs excluded, not scored as low-pain.
# ---------------------------------------------------------------------------

def t_check_pain_trend_excludes_incomplete_logs():
    # Two complete logs showing a clear downward trend; incomplete logs
    # interleaved with unknown (not fabricated-0) delayed fields must not
    # count as "0 pain" data points that would otherwise flatten/skew it.
    logs = [
        {"pain_during": 7, "pain_after": 7, "next_day_pain": 7},   # complete, high
        {"pain_during": 5, "pain_after": None, "next_day_pain": None},  # incomplete — must be excluded
        {"pain_during": 2, "pain_after": 2, "next_day_pain": 2},   # complete, low
    ]
    assert _check_pain_trend(logs) is True


def t_check_pain_trend_returns_false_with_fewer_than_two_complete_logs():
    logs = [
        {"pain_during": 7, "pain_after": None, "next_day_pain": None},
        {"pain_during": 2, "pain_after": None, "next_day_pain": None},
    ]
    assert _check_pain_trend(logs) is False


# ---------------------------------------------------------------------------
# 4/5/7. evaluate_session_tolerance: missing next-morning data yields
# insufficient_data, never a fabricated GO; explicit complete data still
# reaches a real verdict.
# ---------------------------------------------------------------------------

def _base_report(**overrides):
    report = {
        "prescribed": {"sets": 3, "allowedPain": 4},
        "completed": {"sets": 3, "completed": True, "abandonedDueToPain": False},
        "symptoms": {
            "painDuring": 2, "painAfter": None, "painLaterSameDay": None,
            "nextMorningPain": None, "nextMorningStiffness": None,
            "swellingIncrease": False, "sharpPain": False, "limpOrFunctionLoss": False,
        },
        "baseline": {"usualMorningPain": 1, "usualMorningStiffness": 1},
    }
    for k, v in overrides.items():
        report[k] = v
    return report


def t_evaluate_session_tolerance_insufficient_data_when_next_morning_missing():
    result = evaluate_session_tolerance(_base_report())
    assert result["signal"] == "insufficient_data", f"expected insufficient_data, got {result['signal']}"


def t_evaluate_session_tolerance_never_returns_go_with_missing_next_morning_data():
    # Dose/pain-during look perfect — the old code would have computed
    # nextMorningPain=0-1=-1 (<=1) and returned GO/"Well Tolerated" here.
    report = _base_report()
    result = evaluate_session_tolerance(report)
    assert result["signal"] != "go", "must never fabricate a favorable GO from missing next-morning data"


def t_evaluate_session_tolerance_complete_data_can_still_reach_go():
    report = _base_report(symptoms={
        "painDuring": 2, "painAfter": 1, "painLaterSameDay": 1,
        "nextMorningPain": 1, "nextMorningStiffness": 1,
        "swellingIncrease": False, "sharpPain": False, "limpOrFunctionLoss": False,
    })
    result = evaluate_session_tolerance(report)
    assert result["signal"] == "go", f"expected go with fully favorable complete data, got {result['signal']}"


def t_evaluate_session_tolerance_explicit_zero_zero_is_valid_complete_data():
    # Baseline 0, next-morning explicitly reported as 0 — a real, complete,
    # maximally-favorable answer, not "missing".
    report = _base_report(
        baseline={"usualMorningPain": 0, "usualMorningStiffness": 0},
        symptoms={
            "painDuring": 0, "painAfter": 0, "painLaterSameDay": 0,
            "nextMorningPain": 0, "nextMorningStiffness": 0,
            "swellingIncrease": False, "sharpPain": False, "limpOrFunctionLoss": False,
        },
    )
    result = evaluate_session_tolerance(report)
    assert result["signal"] == "go", f"expected go, got {result['signal']}"


def t_evaluate_session_tolerance_same_day_stop_fires_even_with_missing_next_morning_data():
    report = _base_report(symptoms={**_base_report()["symptoms"], "sharpPain": True})
    result = evaluate_session_tolerance(report)
    assert result["signal"] == "stop"


# ---------------------------------------------------------------------------
# 7. evaluate_exercise_progression: insufficient_data must map to STAY, and
# must NOT fall through to a PROGRESS recommendation.
# ---------------------------------------------------------------------------

def t_evaluate_exercise_progression_insufficient_data_stays_not_progresses():
    exercise = {
        "ex_id": "ex1", "exercise_name": "Test Exercise",
        "progression_options": ["ex2"], "regression_options": [],
        "irritability_appropriateness": ["low", "moderate", "high"],
        "requires_dorsiflexion_depth": "none",
    }
    rec = evaluate_exercise_progression(
        current_exercise=exercise, session_signal="insufficient_data",
        irritability=Irritability.LOW, insertional=False, sessions_at_current=5,
    )
    assert rec["decision"] == ExerciseDecision.STAY, (
        f"insufficient_data must never fall through to PROGRESS, got {rec['decision']}"
    )


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    tests = [v for k, v in list(globals().items()) if k.startswith("t_")]
    for fn in tests:
        test(fn.__name__, fn)
    print(f"\n{pass_count} passed, {fail_count} failed")
    raise SystemExit(1 if fail_count else 0)
