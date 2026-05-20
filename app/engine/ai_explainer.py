"""
AI Explanation Layer for TenoTrainer.

Claude is ONLY used here to explain rule engine outputs in patient-friendly language.
Claude receives ONLY: rule engine outputs, plan details, and relevant KB entries.
Claude NEVER makes clinical decisions, modifies plans, or introduces external evidence.

If ANTHROPIC_API_KEY is not set, a static placeholder is returned.
"""

from __future__ import annotations
import os
import logging

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are a coaching assistant for a physiotherapy rehabilitation application called TenoTrainer.

The clinical decisions presented below were made ENTIRELY by a deterministic rule engine. Your ONLY job is to:
1. Explain these decisions in clear, patient-friendly language (avoid medical jargon where possible)
2. Summarize the evidence from the provided citations (only from the citations given — do NOT introduce external evidence)
3. Provide motivating coaching encouragement appropriate to the patient's current stage
4. Help the patient understand WHY the plan is structured the way it is

You MUST NOT:
- Make any clinical decisions
- Modify, override, or second-guess the plan
- Suggest alternative exercises or protocols not in the plan
- Introduce citations or evidence not provided to you
- Make return-to-sport recommendations
- Diagnose or suggest diagnoses
- Give medical advice beyond explaining the provided plan

Keep your response warm, encouraging, and practical. Structure it with:
- A brief welcome/orientation paragraph
- What the plan involves (explain the exercises in simple terms)
- Why this approach (summarise the evidence from the citations)
- Coaching encouragement and what to watch for
- A reminder that their clinician is the final authority

Length: 3–5 paragraphs. Friendly, confident, evidence-grounded."""


FALLBACK_EXPLANATION = """Welcome to your personalised Achilles tendinopathy rehabilitation programme.

Your plan has been carefully determined by our clinical rule engine, which has assessed your pain levels, functional capacity, and injury history to select the most appropriate loading strategy for your current stage of recovery. Achilles tendons respond well to structured, progressive loading — and your programme is designed with exactly that in mind.

The exercises selected for you are based on your current rehab stage and irritability level. Each exercise has been calibrated to challenge your tendon without exceeding its current load tolerance. The key is consistency: small, regular doses of appropriate loading drive tendon adaptation more effectively than occasional intense sessions.

The evidence supporting this approach comes from established clinical research on tendon rehabilitation. Studies show that progressive loading — starting with isometric exercises and advancing through eccentric and heavy slow resistance work — leads to significant improvements in pain, function, and tendon structure over 12–24 weeks.

Stay consistent, respect your body's feedback, and trust the process. If you experience pain above 3/10 during any exercise, reduce the load or range and note it in your daily log. Your clinician has final oversight of your programme and should be consulted for any major concerns.

Keep up the great work — every session is a step toward recovery."""


async def generate_explanation(plan: dict, kb_entries: list[dict], user_name: str) -> str:
    """
    Generate a patient-friendly explanation of the rule-engine-produced plan.

    Args:
        plan: The rehab plan dict (from rule engine output — never raw user input)
        kb_entries: Relevant knowledge base entries (citations only)
        user_name: Patient's first name for personalisation

    Returns:
        str: Patient-friendly explanation text
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        logger.info("ANTHROPIC_API_KEY not set — returning static placeholder explanation.")
        return FALLBACK_EXPLANATION

    try:
        import anthropic

        client = anthropic.AsyncAnthropic(api_key=api_key)

        # Build the user message — rule engine output only, never raw inputs
        user_message = _build_user_message(plan, kb_entries, user_name)

        message = await client.messages.create(
            model="claude-opus-4-5",
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=[
                {"role": "user", "content": user_message}
            ],
        )

        from anthropic.types import TextBlock
        text_block = next((b for b in message.content if isinstance(b, TextBlock)), None)
        return text_block.text if text_block else FALLBACK_EXPLANATION

    except ImportError:
        logger.warning("anthropic package not installed — returning static placeholder.")
        return FALLBACK_EXPLANATION
    except Exception as e:
        logger.error(f"AI explainer error: {e}")
        return FALLBACK_EXPLANATION


def _build_user_message(plan: dict, kb_entries: list[dict], user_name: str) -> str:
    """
    Construct the message sent to Claude.
    Contains ONLY rule engine outputs and KB entries — never raw user inputs.
    """
    stage_names = {1: "Stage 1 — Capacity Initiation", 2: "Stage 2 — Strength Development", 3: "Stage 3 — Energy Storage & Release"}
    stage_label = stage_names.get(plan.get("stage", 1), "Stage 1")

    exercises_text = ""
    for ex in plan.get("exercises", []):
        exercises_text += (
            f"  - {ex['name']} ({ex['type']}): {ex['sets']} sets × {ex['reps']} — {ex['description']}\n"
        )

    citations_text = ""
    for kb in kb_entries:
        citations_text += (
            f"\nCITATION: {kb.get('title', '')} ({kb.get('authors', '')}, {kb.get('year', '')})\n"
            f"  Source: {kb.get('source', '')}\n"
            f"  Summary: {kb.get('summary', '')}\n"
            f"  Key points: {'; '.join(kb.get('key_points', []))}\n"
        )

    fitt = plan.get("fitt", {})
    return f"""Patient name: {user_name}

RULE ENGINE OUTPUT (clinical decisions are final — do not modify):
  Rehab Stage: {stage_label}
  Irritability: {plan.get('irritability', 'moderate').upper()}
  Decision: {plan.get('decision', 'STAY')}
  FITT Dosing: Intensity={fitt.get('intensity', 'moderate')}, Volume={fitt.get('volume', 'moderate')}, Frequency={fitt.get('frequency', 'normal')}, Progression={fitt.get('progression', 'moderate')}
  Rationale (from rule engine): {plan.get('rationale', '')}

PRESCRIBED EXERCISES (from rule engine — do not change):
{exercises_text}

EVIDENCE BASE (only cite from these — no external evidence):
{citations_text}

Please explain this plan to {user_name} using the instructions in your system prompt."""
