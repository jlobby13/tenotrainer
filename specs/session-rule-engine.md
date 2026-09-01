# Session Rule Engine — Specification

## Purpose

Evaluate a completed rehabilitation session and determine how the tendon responded
to the prescribed load. The engine compares prescribed dose, completed dose, and
symptom response to return a single session tolerance signal.

This engine handles **session tolerance only**. It does NOT make progression decisions.

---

## Signal Definitions

| Signal     | Meaning                                                   |
|------------|-----------------------------------------------------------|
| `"go"`     | Session well-tolerated. Proceed with next session as prescribed. |
| `"stay"`   | Adequate tolerance but not optimal. Repeat current dose.  |
| `"caution"`| Load or symptom response exceeded acceptable threshold. Modify next session. |
| `"stop"`   | Safety threshold breached. Do not load until reviewed.    |

---

## Data Structures

```typescript
type SessionReport = {
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

type SignalResult = {
  signal: "go" | "stay" | "caution" | "stop";
  reason: string;
  action: string;
};
```

---

## Derived Variables

Computed once before rule evaluation. Used directly in all rule conditions.

```
doseMatch                = completed.sets / prescribed.sets
nextMorningPainChange    = symptoms.nextMorningPain - baseline.usualMorningPain
nextMorningStiffnessChange = symptoms.nextMorningStiffness - baseline.usualMorningStiffness
overdosed                = doseMatch > 1.2
underdosed               = doseMatch < 0.8
```

---

## Rule Evaluation Order

Rules are evaluated in strict priority order. On first match, return immediately.
No rule aggregation. No bleeding between tiers.

```
1. STOP   (adverse)      — checked first
2. CAUTION (suboptimal)  — checked second
3. GO     (optimal)      — checked third
4. STAY   (acceptable)   — unconditional default
```

---

## Rule Definitions

### STOP — return on first matching condition

| # | Condition                                          | Reason                                                                                  | Action                                                                              |
|---|----------------------------------------------------|-----------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------|
| 1 | `symptoms.sharpPain === true`                      | Sharp pain reported during session — possible acute injury or structural irritation.    | Stop all loading immediately. Do not train. Seek clinical review before continuing. |
| 2 | `completed.abandonedDueToPain === true`            | Session was abandoned due to pain — tendon did not tolerate the prescribed load.        | Do not repeat this session. Reduce load or seek clinical review before next attempt.|
| 3 | `symptoms.limpOrFunctionLoss === true`             | Limping or functional loss reported — tendon load capacity compromised.                 | Cease loading. Rest and monitor. If limp persists beyond 24 hours, seek review.     |
| 4 | `symptoms.swellingIncrease === true`               | Swelling increase reported — inflammatory response exceeds acceptable threshold.        | Rest and apply ice. Do not load until swelling has resolved. Seek review if persistent. |
| 5 | `nextMorningPainChange >= 4`                       | Next morning pain increased by 4 or more points above baseline — severe adverse response. | Stop loading immediately. Do not progress. Seek clinical review.                  |

### CAUTION — return on first matching condition

| # | Condition                                          | Reason                                                                                  | Action                                                                              |
|---|----------------------------------------------------|-----------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------|
| 1 | `symptoms.painDuring > prescribed.allowedPain + 2`| Pain during session exceeded the allowed threshold by more than 2 points.               | Reduce load by 20% next session. Do not increase volume or intensity until pain is within limits. |
| 2 | `nextMorningPainChange >= 2`                       | Next morning pain increased by 2 or more points above baseline.                         | Repeat session at current or reduced load. Monitor next-morning response before progressing. |
| 3 | `nextMorningStiffnessChange >= 2`                  | Next morning stiffness increased by 2 or more points above baseline.                    | Maintain current load. Allow full warm-up before loading. Review if stiffness persists. |
| 4 | `underdosed` (doseMatch < 0.8)                     | Completed sets were less than 80% of the prescribed dose.                               | Investigate reason for under-dosing. If due to fatigue or discomfort, repeat session at prescribed dose before progressing. |
| 5 | `overdosed` (doseMatch > 1.2)                      | Completed sets exceeded 120% of the prescribed dose.                                    | Return to prescribed dose next session. Overdosing risks delayed adverse response — do not exceed prescription. |

### GO — all conditions must be true

| Condition                              | Description                                      |
|----------------------------------------|--------------------------------------------------|
| `doseMatch >= 0.9`                     | At least 90% of prescribed sets completed        |
| `symptoms.painDuring <= prescribed.allowedPain` | Pain during session within allowed limit |
| `nextMorningPainChange <= 1`           | Next morning pain no more than 1 point above baseline |
| `nextMorningStiffnessChange <= 1`      | Next morning stiffness no more than 1 point above baseline |
| `symptoms.swellingIncrease === false`  | No swelling increase reported                    |

Reason: Session well-tolerated. Prescribed dose completed within pain limits with minimal next-day response.
Action: Proceed with next session as prescribed. Progress load according to plan if all sessions consistent.

### STAY — unconditional default

Reached when no STOP, CAUTION, or GO condition was met.

Reason: Session completed with acceptable response but not within optimal tolerance parameters.
Action: Repeat the current session at the same prescribed dose before considering progression.

---

## Test Cases

### Test 1 — Perfect Tolerance → `"go"`

**Input:**
```json
{
  "prescribed": { "sets": 4, "allowedPain": 3 },
  "completed": { "sets": 4, "completed": true, "abandonedDueToPain": false },
  "symptoms": {
    "painDuring": 2,
    "painAfter": 1,
    "painLaterSameDay": 1,
    "nextMorningPain": 1,
    "nextMorningStiffness": 2,
    "swellingIncrease": false,
    "sharpPain": false,
    "limpOrFunctionLoss": false
  },
  "baseline": { "usualMorningPain": 1, "usualMorningStiffness": 2 }
}
```

**Derived:**
- doseMatch = 1.0
- nextMorningPainChange = 0
- nextMorningStiffnessChange = 0
- overdosed = false, underdosed = false

**Rule trace:**
- STOP: none match
- CAUTION: none match
- GO: doseMatch(1.0) >= 0.9 ✓ | painDuring(2) <= allowedPain(3) ✓ | painChange(0) <= 1 ✓ | stiffnessChange(0) <= 1 ✓ | swelling false ✓ → ALL PASS

**Expected output:**
```json
{
  "signal": "go",
  "reason": "Session well-tolerated. Prescribed dose completed within pain limits with minimal next-day response. Pain during session was 2/10 (allowed: 3/10). Next morning pain and stiffness were unchanged from baseline.",
  "action": "Proceed with next session as prescribed. Progress load according to plan if all sessions remain consistent."
}
```

---

### Test 2 — Mild Increase Next Day → `"stay"`

**Input:**
```json
{
  "prescribed": { "sets": 4, "allowedPain": 3 },
  "completed": { "sets": 4, "completed": true, "abandonedDueToPain": false },
  "symptoms": {
    "painDuring": 4,
    "painAfter": 3,
    "painLaterSameDay": 3,
    "nextMorningPain": 2,
    "nextMorningStiffness": 2,
    "swellingIncrease": false,
    "sharpPain": false,
    "limpOrFunctionLoss": false
  },
  "baseline": { "usualMorningPain": 1, "usualMorningStiffness": 1 }
}
```

**Derived:**
- doseMatch = 1.0
- nextMorningPainChange = 1
- nextMorningStiffnessChange = 1
- overdosed = false, underdosed = false

**Rule trace:**
- STOP: none match
- CAUTION: painDuring(4) > allowedPain+2(5)? No | painChange(1) >= 2? No | stiffnessChange(1) >= 2? No | underdosed? No | overdosed? No → none match
- GO: doseMatch(1.0) >= 0.9 ✓ | painDuring(4) <= allowedPain(3)? NO ✗ → fails
- DEFAULT → STAY

**Expected output:**
```json
{
  "signal": "stay",
  "reason": "Session completed but pain during exercise (4/10) exceeded the allowed limit (3/10). No caution-level thresholds were breached. Next morning response was within 1 point of baseline.",
  "action": "Repeat the current session at the same prescribed dose before considering progression."
}
```

---

### Test 3 — Overload With Symptoms → `"caution"`

**Input:**
```json
{
  "prescribed": { "sets": 4, "allowedPain": 3 },
  "completed": { "sets": 4, "completed": true, "abandonedDueToPain": false },
  "symptoms": {
    "painDuring": 6,
    "painAfter": 5,
    "painLaterSameDay": 4,
    "nextMorningPain": 2,
    "nextMorningStiffness": 2,
    "swellingIncrease": false,
    "sharpPain": false,
    "limpOrFunctionLoss": false
  },
  "baseline": { "usualMorningPain": 1, "usualMorningStiffness": 1 }
}
```

**Derived:**
- doseMatch = 1.0
- nextMorningPainChange = 1
- nextMorningStiffnessChange = 1
- overdosed = false, underdosed = false

**Rule trace:**
- STOP: none match (no sharp, no abandoned, no limp, no swelling, painChange=1 < 4)
- CAUTION: painDuring(6) > allowedPain+2(5)? YES → match

**Expected output:**
```json
{
  "signal": "caution",
  "reason": "Pain during session (6/10) exceeded the allowed pain threshold by more than 2 points (allowed: 3/10, limit: 5/10).",
  "action": "Reduce load by 20% next session. Do not increase volume or intensity until pain during exercise is consistently within the allowed limit."
}
```

---

### Test 4 — Aborted Due to Pain → `"stop"`

**Input:**
```json
{
  "prescribed": { "sets": 4, "allowedPain": 3 },
  "completed": { "sets": 2, "completed": false, "abandonedDueToPain": true },
  "symptoms": {
    "painDuring": 7,
    "painAfter": 6,
    "painLaterSameDay": 5,
    "nextMorningPain": 3,
    "nextMorningStiffness": 3,
    "swellingIncrease": false,
    "sharpPain": false,
    "limpOrFunctionLoss": false
  },
  "baseline": { "usualMorningPain": 1, "usualMorningStiffness": 1 }
}
```

**Derived:**
- doseMatch = 0.5
- nextMorningPainChange = 2
- nextMorningStiffnessChange = 2
- overdosed = false, underdosed = true

**Rule trace:**
- STOP: sharpPain? No | abandonedDueToPain? YES → match

**Expected output:**
```json
{
  "signal": "stop",
  "reason": "Session was abandoned due to pain — the tendon did not tolerate the prescribed load.",
  "action": "Do not repeat this session at the same dose. Reduce load significantly or seek clinical review before the next attempt."
}
```

---

### Test 5 — Overdosed but Minimal Symptoms → `"caution"`

**Input:**
```json
{
  "prescribed": { "sets": 4, "allowedPain": 3 },
  "completed": { "sets": 6, "completed": true, "abandonedDueToPain": false },
  "symptoms": {
    "painDuring": 2,
    "painAfter": 1,
    "painLaterSameDay": 1,
    "nextMorningPain": 1,
    "nextMorningStiffness": 2,
    "swellingIncrease": false,
    "sharpPain": false,
    "limpOrFunctionLoss": false
  },
  "baseline": { "usualMorningPain": 1, "usualMorningStiffness": 2 }
}
```

**Derived:**
- doseMatch = 1.5
- nextMorningPainChange = 0
- nextMorningStiffnessChange = 0
- overdosed = true, underdosed = false

**Rule trace:**
- STOP: none match
- CAUTION: painDuring(2) > 5? No | painChange(0) >= 2? No | stiffnessChange(0) >= 2? No | underdosed? No | overdosed? YES → match

**Expected output:**
```json
{
  "signal": "caution",
  "reason": "Completed sets (6) exceeded 120% of the prescribed dose (4 sets). Overdosing risks a delayed adverse tendon response even when immediate symptoms appear minimal.",
  "action": "Return to the prescribed dose of 4 sets next session. Do not exceed the prescription — tendon adaptation requires consistent, controlled loading."
}
```
