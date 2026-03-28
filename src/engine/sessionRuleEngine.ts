/**
 * TenoTrainer — Session Tolerance Rule Engine
 *
 * Evaluates a completed rehabilitation session and returns a single session
 * tolerance signal based on prescribed dose, completed dose, and symptom response.
 *
 * This module handles SESSION TOLERANCE ONLY. It does NOT make progression decisions.
 *
 * Rules are evaluated in strict priority order. First match wins. No aggregation.
 *   1. STOP    — safety threshold breached
 *   2. CAUTION — load or symptom response exceeded acceptable threshold
 *   3. GO      — all optimal tolerance criteria met
 *   4. STAY    — unconditional default
 *
 * Spec: /specs/session-rule-engine.md
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionReport = {
  prescribed: {
    sets: number;
    reps?: number;
    durationSec?: number;
    load?: number;
    allowedPain: number;
  };
  completed: {
    sets: number;
    reps?: number;
    durationSec?: number;
    load?: number;
    completed: boolean;
    abandonedDueToPain: boolean;
  };
  symptoms: {
    painDuring: number;
    painAfter: number;
    painLaterSameDay: number;
    nextMorningPain: number;
    nextMorningStiffness: number;
    swellingIncrease: boolean;
    sharpPain: boolean;
    limpOrFunctionLoss: boolean;
  };
  baseline: {
    usualMorningPain: number;
    usualMorningStiffness: number;
  };
};

export type SignalResult = {
  signal: "go" | "stay" | "caution" | "stop";
  reason: string;
  action: string;
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export function evaluateSessionTolerance(report: SessionReport): SignalResult {
  const { prescribed, completed, symptoms, baseline } = report;

  // --- Derived variables — computed once, used directly in all rule conditions ---
  const doseMatch = completed.sets / prescribed.sets;
  const nextMorningPainChange = symptoms.nextMorningPain - baseline.usualMorningPain;
  const nextMorningStiffnessChange = symptoms.nextMorningStiffness - baseline.usualMorningStiffness;
  const overdosed = doseMatch > 1.2;
  const underdosed = doseMatch < 0.8;

  // ---------------------------------------------------------------------------
  // STOP rules — checked first, return immediately on first match
  // ---------------------------------------------------------------------------

  // STOP 1: Sharp pain reported
  if (symptoms.sharpPain === true) {
    return {
      signal: "stop",
      reason:
        "Sharp pain reported during session — possible acute injury or structural irritation.",
      action:
        "Stop all loading immediately. Do not train. Seek clinical review before continuing.",
    };
  }

  // STOP 2: Session abandoned due to pain
  if (completed.abandonedDueToPain === true) {
    return {
      signal: "stop",
      reason:
        "Session was abandoned due to pain — the tendon did not tolerate the prescribed load.",
      action:
        "Do not repeat this session at the same dose. Reduce load significantly or seek clinical review before the next attempt.",
    };
  }

  // STOP 3: Limping or functional loss
  if (symptoms.limpOrFunctionLoss === true) {
    return {
      signal: "stop",
      reason:
        "Limping or functional loss reported — tendon load capacity compromised.",
      action:
        "Cease loading. Rest and monitor. If limp persists beyond 24 hours, seek clinical review.",
    };
  }

  // STOP 4: Swelling increase
  if (symptoms.swellingIncrease === true) {
    return {
      signal: "stop",
      reason:
        "Swelling increase reported — inflammatory response exceeds acceptable threshold.",
      action:
        "Rest and apply ice. Do not load until swelling has resolved. Seek review if swelling persists.",
    };
  }

  // STOP 5: Next morning pain increased by 4 or more points above baseline
  if (nextMorningPainChange >= 4) {
    return {
      signal: "stop",
      reason: `Next morning pain increased by ${nextMorningPainChange} points above baseline (baseline: ${baseline.usualMorningPain}/10, reported: ${symptoms.nextMorningPain}/10) — severe adverse response.`,
      action:
        "Stop loading immediately. Do not progress. Seek clinical review.",
    };
  }

  // ---------------------------------------------------------------------------
  // CAUTION rules — checked second, return immediately on first match
  // ---------------------------------------------------------------------------

  // CAUTION 1: Pain during session exceeded allowed threshold by more than 2 points
  if (symptoms.painDuring > prescribed.allowedPain + 2) {
    return {
      signal: "caution",
      reason: `Pain during session (${symptoms.painDuring}/10) exceeded the allowed pain threshold by more than 2 points (allowed: ${prescribed.allowedPain}/10, limit: ${prescribed.allowedPain + 2}/10).`,
      action:
        "Reduce load by 20% next session. Do not increase volume or intensity until pain during exercise is consistently within the allowed limit.",
    };
  }

  // CAUTION 2: Next morning pain increased by 2 or more points above baseline
  if (nextMorningPainChange >= 2) {
    return {
      signal: "caution",
      reason: `Next morning pain increased by ${nextMorningPainChange} points above baseline (baseline: ${baseline.usualMorningPain}/10, reported: ${symptoms.nextMorningPain}/10).`,
      action:
        "Repeat session at current or reduced load. Monitor next-morning response before progressing.",
    };
  }

  // CAUTION 3: Next morning stiffness increased by 2 or more points above baseline
  if (nextMorningStiffnessChange >= 2) {
    return {
      signal: "caution",
      reason: `Next morning stiffness increased by ${nextMorningStiffnessChange} points above baseline (baseline: ${baseline.usualMorningStiffness}/10, reported: ${symptoms.nextMorningStiffness}/10).`,
      action:
        "Maintain current load. Allow full warm-up before loading. Review if stiffness persists across multiple sessions.",
    };
  }

  // CAUTION 4: Underdosed — completed sets less than 80% of prescribed
  if (underdosed) {
    return {
      signal: "caution",
      reason: `Completed sets (${completed.sets}) were less than 80% of the prescribed dose (${prescribed.sets} sets). Dose match: ${Math.round(doseMatch * 100)}%.`,
      action:
        "Investigate reason for under-dosing. If due to fatigue or discomfort, repeat session at the prescribed dose before progressing.",
    };
  }

  // CAUTION 5: Overdosed — completed sets exceeded 120% of prescribed
  if (overdosed) {
    return {
      signal: "caution",
      reason: `Completed sets (${completed.sets}) exceeded 120% of the prescribed dose (${prescribed.sets} sets). Overdosing risks a delayed adverse tendon response even when immediate symptoms appear minimal.`,
      action:
        "Return to the prescribed dose next session. Do not exceed the prescription — tendon adaptation requires consistent, controlled loading.",
    };
  }

  // ---------------------------------------------------------------------------
  // GO — all five conditions must be true
  // ---------------------------------------------------------------------------

  if (
    doseMatch >= 0.9 &&
    symptoms.painDuring <= prescribed.allowedPain &&
    nextMorningPainChange <= 1 &&
    nextMorningStiffnessChange <= 1 &&
    symptoms.swellingIncrease === false
  ) {
    return {
      signal: "go",
      reason: `Session well-tolerated. Prescribed dose completed within pain limits with minimal next-day response. Pain during session was ${symptoms.painDuring}/10 (allowed: ${prescribed.allowedPain}/10). Next morning pain and stiffness were within 1 point of baseline.`,
      action:
        "Proceed with next session as prescribed. Progress load according to plan if all sessions remain consistent.",
    };
  }

  // ---------------------------------------------------------------------------
  // STAY — unconditional default
  // ---------------------------------------------------------------------------

  return {
    signal: "stay",
    reason:
      "Session completed with acceptable response but not within optimal tolerance parameters. No caution-level thresholds were breached.",
    action:
      "Repeat the current session at the same prescribed dose before considering progression.",
  };
}
