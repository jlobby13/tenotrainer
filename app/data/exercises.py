"""
Exercises library for TenoTrainer.
Hardcoded by stage. Dosing modifiers are applied by the rule engine at runtime.
"""

EXERCISES: dict[int, list[dict]] = {
    1: [
        {
            "name": "Isometric Calf Hold",
            "type": "isometric",
            "description": (
                "Stand on the edge of a step or firm surface. Rise onto your toes and hold the raised position "
                "for 45 seconds. There should be no movement — just sustained tension through the calf and tendon."
            ),
            "sets": 5,
            "reps": "45s hold",
            "tempo": "hold",
            "notes": (
                "Pain should not exceed 3/10 during the hold. If pain exceeds 3/10, reduce your range of motion "
                "slightly or perform on flat ground. Isometrics are excellent for pain modulation."
            ),
        },
        {
            "name": "Slow Eccentric Calf Lower",
            "type": "slow_isotonic",
            "description": (
                "Rise up onto both toes using both legs, then transfer weight to the affected leg and lower slowly "
                "over 3–4 seconds. Return to start using both legs."
            ),
            "sets": 3,
            "reps": 15,
            "tempo": "3-0-3",
            "notes": (
                "Perform through mild discomfort only (≤3/10). If pain exceeds this, use both legs for the lowering "
                "phase. Focus on slow, controlled descent."
            ),
        },
    ],
    2: [
        {
            "name": "Heavy Slow Resistance Calf Raise",
            "type": "heavy_slow_resistance",
            "description": (
                "Loaded calf raise on the edge of a step. Rise up slowly over 3 seconds, hold for 1 second at top, "
                "then lower slowly over 3 seconds. Use added weight (backpack, dumbbell) that is challenging for 6–8 reps."
            ),
            "sets": 4,
            "reps": "6-8",
            "tempo": "3-1-3",
            "notes": (
                "Progress load by approximately 2.5 kg weekly if pain remains ≤4/10. "
                "Heavy slow resistance is strongly supported by evidence for mid-stage tendon rehabilitation."
            ),
        },
        {
            "name": "Eccentric Calf Drop",
            "type": "eccentric",
            "description": (
                "Stand with both feet on the edge of a step. Rise onto both toes, then transfer weight to the affected "
                "leg and lower slowly over 6 seconds until heel is below step level."
            ),
            "sets": 3,
            "reps": 15,
            "tempo": "0-0-6",
            "notes": (
                "Classic Alfredson eccentric protocol. Some pain is acceptable during this exercise (≤5/10) — "
                "this is supported by the original research. Do NOT perform if pain exceeds 5/10 or there are red flags."
            ),
        },
    ],
    3: [
        {
            "name": "Double Leg Calf Raise Jump",
            "type": "plyometric",
            "description": (
                "Begin with quick bilateral calf raises progressing to small bilateral hops in place. "
                "Focus on stiffness and springy reactivity rather than height. Keep ground contact time short."
            ),
            "sets": 3,
            "reps": 10,
            "tempo": "reactive",
            "notes": (
                "Only commence Stage 3 exercises if pain ≤2/10 at rest and Stage 2 is fully consolidated. "
                "Begin with calf raises before progressing to true hops."
            ),
        },
        {
            "name": "Single Leg Hop",
            "type": "reactive_strength",
            "description": (
                "Single leg hops in place, progressing to forward hops and lateral hops. "
                "Aim for 200–250 total contacts per session as running readiness builds. "
                "Focus on a stiff, springy ankle and quick ground contact."
            ),
            "sets": 3,
            "reps": "20 contacts",
            "tempo": "reactive",
            "notes": (
                "Running readiness benchmark: stable symptoms + ability to complete 200–250 contacts comfortably. "
                "Return to running is a CLINICIAN decision — do not self-progress to running without clinician clearance."
            ),
        },
    ],
}
