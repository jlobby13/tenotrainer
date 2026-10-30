// M3.2 — the minimum clinician safety email (founder D3 + PHI decision).
// Contains NO patient name, initials, id, episode id, symptom, body region,
// numeric level or event date. Only: the process-language subject, the
// clinician's organization name, and an opaque, authenticated link to the
// recipient's own notification. No tracking, no marketing.
import type { SafetyEmailMessage } from "./provider";

export type SafetyEmailTier = "clinician_review" | "urgent_clinician_review";

export const SAFETY_EMAIL_SUBJECTS: Record<SafetyEmailTier, string> = {
  clinician_review: "TenoTrainer: clinician review required",
  urgent_clinician_review: "TenoTrainer: urgent clinician review required",
};

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function notificationLink(appUrl: string, recipientId: string): string {
  return `${appUrl.replace(/\/+$/, "")}/clinician/notifications/${encodeURIComponent(recipientId)}`;
}

export function buildSafetyEmail(input: {
  to: string;
  tier: SafetyEmailTier;
  organizationName: string | null;
  link: string;
}): SafetyEmailMessage {
  const subject = SAFETY_EMAIL_SUBJECTS[input.tier];
  const who = input.organizationName ? `A patient in ${input.organizationName}` : "A patient";
  const lead = input.tier === "urgent_clinician_review"
    ? `${who} has a safety update that needs urgent clinician review.`
    : `${who} has a safety update that needs clinician review.`;
  const text = `${lead}

Sign in to TenoTrainer to view it:
${input.link}

You are receiving this because you are responsible for this patient's care in TenoTrainer.
`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:560px;margin:40px auto;padding:0 16px;"><div style="background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;padding:32px;">
<div style="font-size:20px;font-weight:700;color:#2563eb;margin-bottom:20px;">TenoTrainer</div>
<p style="font-size:15px;line-height:1.6;color:#111827;margin:0 0 20px;">${esc(lead)}</p>
<p style="margin:24px 0;text-align:center;"><a href="${esc(input.link)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 28px;border-radius:8px;">Sign in to view</a></p>
<p style="font-size:12px;color:#6b7280;line-height:1.6;margin:0;">You are receiving this because you are responsible for this patient's care in TenoTrainer.</p>
</div></div></body></html>`;
  return { to: input.to, subject, text, html };
}
