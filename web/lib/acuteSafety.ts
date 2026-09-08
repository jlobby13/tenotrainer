// Acute Safety Gate + Resolution Lifecycle — pure, deterministic domain
// logic. Client-safe (no server-only import, no DB access). Mirrors the
// guidance.ts / toleranceEvaluation.ts split of "pure decision logic" from
// "server-only DB wiring" (see acuteSafetyServer.ts for the latter).
//
// Three independent pure algorithms live here:
//   1. computeRecurrenceWindow — the anchored 14-day Level 4 Recurrent
//      window (Section 10). NOT a sliding "4 events in the last 14 days"
//      query — see the function's own comment.
//   2. evaluateReleaseEligibility — the Level 3/4/5 brake-release rules
//      (Section 6/11/13).
//   3. describeBrakeState — patient-facing copy (Section 20/21), calm and
//      non-diagnostic, never exposing raw internal reason codes.
//
// TenoTrainer v1 clinician-designed thresholds used below (Section 32) —
// NOT validated biological/pathology boundaries, and never presented to the
// patient as such:
//   - Level 4 Persistent: unresolved > 48 hours (also enforced in SQL —
//     see get_patient_acute_brake_status() in the acute-safety migration)
//   - Level 4 Persistent: >= 3 blocked scheduled rehab opportunities
//   - Level 4 Recurrent: >= 4 distinct Level 3 episodes inside an anchored
//     14-day observation window

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

export type PriorEpisodeForWindow = {
  id: string;
  confirmedAt: string; // ISO
  // NULL means this episode IS an anchor (either the first ever, or the
  // first one confirmed after a prior window expired).
  recurrenceWindowAnchorId: string | null;
  recurrenceSequenceInWindow: number;
};

export type RecurrenceWindowResult = {
  anchorId: string | null;
  sequenceInWindow: number;
  level4Recurrent: boolean;
};

// priorEpisodes MUST be every prior confirmed episode for this patient,
// sorted ascending by confirmedAt (oldest first) — only the LAST one is
// actually read (its own frozen anchor/sequence already encodes the whole
// history up to that point), but the anchor episode itself must be
// findable within the list to read its confirmedAt.
export function computeRecurrenceWindow(
  priorEpisodes: PriorEpisodeForWindow[],
  newConfirmedAt: string
): RecurrenceWindowResult {
  if (priorEpisodes.length === 0) {
    return { anchorId: null, sequenceInWindow: 1, level4Recurrent: false };
  }

  const last = priorEpisodes[priorEpisodes.length - 1];
  const anchorId = last.recurrenceWindowAnchorId ?? last.id;
  const anchor = anchorId === last.id ? last : priorEpisodes.find((e) => e.id === anchorId);
  if (!anchor) {
    throw new Error(`computeRecurrenceWindow: anchor episode ${anchorId} not found in provided prior-episode history`);
  }

  const windowEndMs = new Date(anchor.confirmedAt).getTime() + FOURTEEN_DAYS_MS;
  const newMs = new Date(newConfirmedAt).getTime();

  if (newMs <= windowEndMs) {
    // Continues the currently-active window — increment, never re-anchor.
    const sequenceInWindow = last.recurrenceSequenceInWindow + 1;
    return { anchorId, sequenceInWindow, level4Recurrent: sequenceInWindow >= 4 };
  }

  // Window expired — this episode becomes the anchor of a NEW window.
  return { anchorId: null, sequenceInWindow: 1, level4Recurrent: false };
}

export type EffectiveLevel = 3 | 4 | 5;

export type ReassessmentAnswers = {
  suddenOrSharpPainResolved: boolean | null;
  newFunctionalDifficultyResolved: boolean | null;
  evaluatedByProfessional: boolean;
  clearedByProfessional: boolean | null;
};

export type ReleaseEligibilityInput = {
  episode: {
    initialLevel: 3 | 5;
    initialSuddenOrSharpPain: boolean;
    initialNewFunctionalDifficulty: boolean;
    effectiveLevel: EffectiveLevel;
  };
  latestReassessment: ReassessmentAnswers | null;
  // True iff ANY reassessment ever submitted for this episode had
  // evaluated=true AND cleared=false. Once true, this episode has entered
  // the "professional hold" state PERMANENTLY (Section 6C) — a LATER
  // reassessment reporting cleared=true no longer takes the ordinary
  // no-prescription-required path; it now also needs a newer prescription,
  // exactly like Level 4/5. Self-resolution (evaluated=No) is also no
  // longer reachable once this is true.
  hasEverBeenProfessionallyHeld: boolean;
  // A prescription_versions row exists for this patient with created_at
  // after the episode's confirmed_at. Chronology only — this function
  // never infers that its existence means a clinician reviewed the episode
  // (see guidance.ts's identical LOCKED distinction); it is only ever
  // combined with, never substituted for, actual reported clearance.
  newerPrescriptionVersionExists: boolean;
};

export type ReleaseEligibilityResult =
  | { eligible: false }
  | {
      eligible: true;
      releasePath: "self_resolved_no_evaluation" | "professional_clearance" | "professional_clearance_with_prescription";
    };

export function evaluateReleaseEligibility(input: ReleaseEligibilityInput): ReleaseEligibilityResult {
  const { episode, latestReassessment, hasEverBeenProfessionallyHeld, newerPrescriptionVersionExists } = input;

  if (!latestReassessment) return { eligible: false };

  // Level 4/5, OR a Level 3 episode that has ever entered professional
  // hold: BOTH clearance AND a newer prescription are required. Neither
  // alone releases (Section 6C/11/13) — chronology is not intent, and a
  // later symptom improvement alone is never sufficient once this state
  // has been reached.
  const requiresClearanceAndPrescription =
    episode.effectiveLevel >= 4 || episode.initialLevel === 5 || hasEverBeenProfessionallyHeld;

  if (requiresClearanceAndPrescription) {
    if (latestReassessment.evaluatedByProfessional && latestReassessment.clearedByProfessional === true && newerPrescriptionVersionExists) {
      return { eligible: true, releasePath: "professional_clearance_with_prescription" };
    }
    return { eligible: false };
  }

  // Ordinary Level 3 only, never yet professionally held.
  if (latestReassessment.evaluatedByProfessional) {
    if (latestReassessment.clearedByProfessional === true) {
      // Explicitly locked (Section 6B): no updated prescription required
      // for ordinary Level 3 professional clearance.
      return { eligible: true, releasePath: "professional_clearance" };
    }
    // evaluated=true, cleared=false (or, defensively, not yet answered) —
    // this IS the professional-hold-entering case. The caller is
    // responsible for recording hasEverBeenProfessionallyHeld=true for any
    // FUTURE evaluation of this episode once this reassessment is
    // persisted — this function only decides eligibility for the CURRENT
    // reassessment being evaluated.
    return { eligible: false };
  }

  // evaluated=false — self-resolution path. ALL findings that were
  // actually present in the original episode must be resolved. A finding
  // never reported in the first place is never required to be "resolved."
  const suddenOk = !episode.initialSuddenOrSharpPain || latestReassessment.suddenOrSharpPainResolved === true;
  const functionalOk = !episode.initialNewFunctionalDifficulty || latestReassessment.newFunctionalDifficultyResolved === true;
  if (suddenOk && functionalOk) {
    return { eligible: true, releasePath: "self_resolved_no_evaluation" };
  }
  return { eligible: false };
}

// ---------------------------------------------------------------------------
// Patient-facing copy — calm, specific, non-diagnostic (Section 20/21).
// Never: "you damaged your tendon," "ruptured," "unsafe," "failed session,"
// "you ignored the recommendation," "chronic." Never claims TenoTrainer
// contacted a clinician unless that actually happened (it doesn't, in this
// milestone).
// ---------------------------------------------------------------------------

export type BrakeDisplayState =
  | { kind: "none" }
  | { kind: "level3_unresolved"; title: string; body: string; symptomsStillPresent: boolean }
  | { kind: "level3_released_self"; title: string; body: string }
  | { kind: "level3_released_cleared"; title: string; body: string }
  | { kind: "level3_professional_hold"; title: string; body: string; waitingOnPrescription: boolean }
  | { kind: "level4"; title: string; body: string; symptomsImproved: boolean; waitingOnPrescription: boolean }
  | { kind: "level5"; title: string; body: string; waitingOnPrescription: boolean };

export function describeActiveBrake(params: {
  effectiveLevel: EffectiveLevel;
  hasEverBeenProfessionallyHeld: boolean;
  latestReassessment: ReassessmentAnswers | null;
  symptomsStillPresent: boolean; // per the latest reassessment (or true if none submitted yet)
}): BrakeDisplayState {
  const { effectiveLevel, hasEverBeenProfessionallyHeld, latestReassessment, symptomsStillPresent } = params;

  if (effectiveLevel === 5) {
    const waitingOnPrescription = latestReassessment?.evaluatedByProfessional === true && latestReassessment.clearedByProfessional === true;
    return {
      kind: "level5",
      title: "Stop Loading",
      body: waitingOnPrescription
        ? "You've reported that you were cleared to resume rehabilitation. TenoTrainer is waiting for an updated exercise prescription before your next rehab session."
        : "Do not continue your Achilles exercises. Protect and offload the affected leg. Seek prompt medical evaluation.",
      waitingOnPrescription,
    };
  }

  if (effectiveLevel === 4) {
    const waitingOnPrescription = latestReassessment?.evaluatedByProfessional === true && latestReassessment.clearedByProfessional === true;
    return {
      kind: "level4",
      title: "Professional review recommended",
      body: waitingOnPrescription
        ? "You've reported that you were cleared to resume rehabilitation. TenoTrainer is waiting for an updated exercise prescription before your next rehab session."
        : symptomsStillPresent
          ? "Your recent Achilles concerns have persisted or occurred repeatedly. Before continuing your prescribed rehab, we recommend review by a healthcare professional."
          : "It's encouraging that your symptoms have improved, but because this concern has persisted or recurred, professional review is still recommended before you resume prescribed loading.",
      symptomsImproved: !symptomsStillPresent,
      waitingOnPrescription,
    };
  }

  // effectiveLevel === 3
  if (hasEverBeenProfessionallyHeld) {
    const waitingOnPrescription = latestReassessment?.evaluatedByProfessional === true && latestReassessment.clearedByProfessional === true;
    return {
      kind: "level3_professional_hold",
      title: "Rehab on hold",
      body: waitingOnPrescription
        ? "Your rehab will remain on hold until clearance and an updated exercise prescription are available."
        : "You reported that you were evaluated but have not been cleared to resume rehabilitation. TenoTrainer will keep your rehab on hold.",
      waitingOnPrescription,
    };
  }

  return {
    kind: "level3_unresolved",
    title: "A quick follow-up is needed",
    body: symptomsStillPresent
      ? "Your recent report needs a quick follow-up before your next rehab session. Your symptoms are still present. Avoid further Achilles loading for now and give the area time to recover."
      : "Your recent report needs a quick follow-up before your next rehab session.",
    symptomsStillPresent,
  };
}

export function describeReleasedBrake(
  releasePath: "self_resolved_no_evaluation" | "professional_clearance" | "professional_clearance_with_prescription"
): Extract<BrakeDisplayState, { kind: "level3_released_self" | "level3_released_cleared" }> {
  if (releasePath === "self_resolved_no_evaluation") {
    return {
      kind: "level3_released_self",
      title: "Cleared to continue",
      body: "Your reported symptoms have resolved. Return to your prescribed rehab cautiously and monitor how your Achilles responds.",
    };
  }
  return {
    kind: "level3_released_cleared",
    title: "Cleared to continue",
    body: "You reported that you were evaluated and cleared to resume rehabilitation. Return to your prescribed rehab cautiously and monitor your response.",
  };
}

// Cautious-return guidance for the first session after release (Section 7).
// Never rewrites the prescription — this is advisory framing only.
export const CAUTIOUS_RETURN_GUIDANCE = {
  title: "Returning after a recent concern",
  body: "You're returning to prescribed rehab after a recent Achilles concern. Consider temporarily easing training load or volume where appropriate, limiting other Achilles-relevant activity, and prioritizing recovery. Watch for sharp or pulling pain and new functional difficulty — if either returns, stop and re-enter the safety check-in.",
};
