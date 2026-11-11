// Alpha 1 — the TenoTrainer Alpha 1 Participation Agreement (with its
// privacy notice). Plain data only (no server imports), so the invitation
// page can render it. The authoritative hash and the form check live in
// alpha1AgreementServer.ts.
//
// Changing ANY wording here changes the agreement: bump
// ALPHA1_AGREEMENT_VERSION and update the pinned hash in
// lib/__tests__/alpha1Agreement.test.ts in the same change.

export const ALPHA1_AGREEMENT_KEY = "alpha1_participation";
export const ALPHA1_AGREEMENT_VERSION = "1.1";
export const ALPHA1_AGREEMENT_TITLE = "TenoTrainer Alpha 1 Participation Agreement";
export const ALPHA1_AGREEMENT_CHECKBOX_LABEL = "I have read and agree to the TenoTrainer Alpha 1 Participation Agreement.";
export const ALPHA1_CONTACT_EMAIL = "tenotrainer@tenotrainer.com";

export type AgreementBlock = string | { strong: string } | { list: string[] };
export type AgreementSection = { heading: string; blocks: AgreementBlock[] };

export const ALPHA1_AGREEMENT_SECTIONS: AgreementSection[] = [
  {
    heading: "About Alpha 1",
    blocks: [
      "TenoTrainer Alpha 1 is an early evaluation of software that is still being developed. Its purpose is to test exercise tracking, rehabilitation workflows, usability and overall functionality. Features may be incomplete, inaccurate or unavailable.",
    ],
  },
  {
    heading: "Your exercise information",
    blocks: [
      "You may record real exercise-performance information from activities you choose to do on your own, such as:",
      { list: ["exercises performed", "sets and repetitions", "resistance or weight used", "whether you completed an exercise", "other workout-performance information"] },
      "TenoTrainer's prescriptions, loading recommendations and progression decisions are not instructions for your actual workouts. Do not perform an exercise only because TenoTrainer prescribes it.",
      "Do not enter real exercise information that reveals an actual injury, diagnosis, medical condition or treatment history. If you did not actually perform a prescribed exercise, you may enter made-up performance information to test the tracking screens.",
    ],
  },
  {
    heading: "Injury and symptom information must be fictional",
    blocks: [
      "Everything you enter about injuries or symptoms must be made up. This includes:",
      { list: ["Achilles injury history", "rehabilitation and treatment history", "pain ratings", "morning stiffness", "how long symptoms lasted", "changes in symptoms", "any other injury-related clinical information"] },
      "Do not enter real patient information, or medical information that could identify anyone else.",
    ],
  },
  {
    heading: "Not medical care",
    blocks: [
      "TenoTrainer Alpha 1 is not a medical service, and taking part does not create a clinician–patient relationship. Do not use it to diagnose, treat, monitor or manage an actual injury or medical condition. Its exercise prescriptions, progression recommendations and clinical interpretations are experimental software features. Do not rely on them for medical decisions.",
    ],
  },
  {
    heading: "Safety notifications",
    blocks: [
      "Safety alerts and escalation are experimental software features. They are not emergency monitoring, and they do not guarantee that a clinician will respond. Do not rely on TenoTrainer for urgent medical help.",
      { strong: "In a medical emergency, call 911." },
      "Please do not deliberately trigger an urgent safety report unless the TenoTrainer testing administrator asks you to.",
    ],
  },
  {
    heading: "Taking part is voluntary",
    blocks: [
      `Taking part is voluntary, and you can stop testing at any time. To withdraw, or to ask for your account or testing information to be deleted, email ${ALPHA1_CONTACT_EMAIL}. Deletion is subject to the limits described in the privacy notice below.`,
    ],
  },
  {
    heading: "Privacy notice",
    blocks: [
      "What we collect: your name and email address; your sign-in and account settings, such as your time zone and reminder time; the exercise-performance information you record; the check-in answers and notes you enter, where injury and symptom details must be fictional; and technical information needed to run and secure the service, such as sign-in records and our hosting provider's request logs.",
      "Why: to run Alpha 1, show you your program, share your entries with the clinician who invited you, operate the safety features, keep the service secure, and evaluate and improve TenoTrainer.",
      "Who can see it: the clinician who invited you and the TenoTrainer team running the test.",
      "Service providers: Vercel hosts the application. Supabase stores the data and handles sign-in. Resend delivers TenoTrainer's emails, such as invitations, password resets and safety notifications to clinicians.",
      "How long we keep it: Alpha 1 has no automatic deletion schedule. Your information is kept until it is deleted, for example at your request.",
      `Deletion: to ask for your account to be deleted, email ${ALPHA1_CONTACT_EMAIL}. If your account has no protected safety records, we will delete your account and your testing information from TenoTrainer's active database. If it has protected safety records, those records cannot be deleted, so we will close your account instead. Closing blocks access to your account and removes identifying account details, including your name and email address. Your safety records and your other testing information stay linked to the closed account, and these retained records, including any free text you entered, may still contain personal information. Closing an account is not complete deletion and does not guarantee anonymity.`,
      "In either case, some information may remain in our service providers' systems, such as Supabase database backups and authentication logs, Vercel logs and Resend email records, under those providers' own retention.",
      `TenoTrainer Alpha 1 is experimental software and is not intended for medical care. Privacy questions and support: ${ALPHA1_CONTACT_EMAIL}.`,
    ],
  },
];

// The exact text that is hashed and recorded. Deterministic: title, version,
// then each heading and block, list items prefixed "- ", joined by "\n".
export function alpha1AgreementCanonicalText(): string {
  const lines: string[] = [ALPHA1_AGREEMENT_TITLE, `Version ${ALPHA1_AGREEMENT_VERSION}`];
  for (const section of ALPHA1_AGREEMENT_SECTIONS) {
    lines.push("", section.heading);
    for (const block of section.blocks) {
      if (typeof block === "string") lines.push(block);
      else if ("strong" in block) lines.push(block.strong);
      else for (const item of block.list) lines.push(`- ${item}`);
    }
  }
  lines.push("", ALPHA1_AGREEMENT_CHECKBOX_LABEL);
  return lines.join("\n");
}
