import { Resend } from "resend";
import { getConfig } from "./config";
import { getResendApiKey } from "./config/secrets";
import { emailDeliveryDecision, type EmailDeliveryCode } from "./emailPolicy";

const HUMAN_ROLE: Record<string, string> = {
  USER_TESTER: "TenoTrainer User Tester",
  CLINICIAN_ADMIN_TESTER: "TenoTrainer Clinician Tester",
};

export function invitationHtml(opts: {
  inviteUrl: string;
  orgName: string;
  humanRole: string;
  recipientEmail: string;
}): string {
  const { inviteUrl, orgName, humanRole, recipientEmail } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>You're Invited to Try TenoTrainer</title>
<style>
  body { margin: 0; padding: 0; background: #f9fafb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  .wrapper { max-width: 560px; margin: 40px auto; padding: 0 16px; }
  .card { background: #ffffff; border-radius: 12px; border: 1px solid #e5e7eb; padding: 40px 36px; }
  .logo { font-size: 24px; font-weight: 700; color: #2563eb; margin-bottom: 28px; }
  h1 { font-size: 22px; font-weight: 700; color: #111827; margin: 0 0 12px; }
  p { font-size: 15px; line-height: 1.6; color: #4b5563; margin: 0 0 16px; }
  .role-badge { display: inline-block; background: #eff6ff; color: #1d4ed8; border-radius: 6px; font-size: 13px; font-weight: 600; padding: 4px 10px; margin-bottom: 20px; }
  .cta { display: block; margin: 28px 0; text-align: center; }
  .cta a { display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; padding: 14px 32px; border-radius: 8px; }
  .cta a:hover { background: #1d4ed8; }
  .divider { border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }
  .fine-print { font-size: 13px; color: #9ca3af; line-height: 1.6; }
  .url-fallback { font-size: 12px; color: #6b7280; word-break: break-all; background: #f3f4f6; border-radius: 6px; padding: 10px 14px; margin-top: 8px; }
  @media (max-width: 600px) { .card { padding: 28px 20px; } }
</style>
</head>
<body>
<div class="wrapper">
  <div class="card">
    <div class="logo">TenoTrainer</div>

    <h1>Welcome to TenoTrainer</h1>

    <p>You have been invited to help test <strong>TenoTrainer</strong>, which is currently in development.</p>

    <p>Your role: <span class="role-badge">${humanRole}</span></p>

    <p>We'd love for you to try the platform and share your feedback. Your experience will directly help improve:</p>
    <ul style="color:#4b5563;font-size:15px;line-height:1.8;margin:0 0 16px;padding-left:20px;">
      <li>Usability and navigation</li>
      <li>Workflows and guidance</li>
      <li>${humanRole.includes("Clinician") ? "Clinician oversight tools" : "Patient-facing experience"}</li>
    </ul>

    <p>Click below to create your account and join <strong>${orgName}</strong>:</p>

    <div class="cta">
      <a href="${inviteUrl}">Create Your TenoTrainer Account</a>
    </div>

    <hr class="divider" />

    <p class="fine-print">
      This invitation was sent specifically to <strong>${recipientEmail}</strong> and will expire in 7 days.
      If you weren't expecting this invitation, you can safely ignore this email.
    </p>

    <p class="fine-print" style="margin-top:12px;">
      If the button above doesn't work, copy and paste this link into your browser:
    </p>
    <div class="url-fallback">${inviteUrl}</div>
  </div>
</div>
</body>
</html>`;
}

export function invitationText(opts: {
  inviteUrl: string;
  orgName: string;
  humanRole: string;
  recipientEmail: string;
}): string {
  return `Welcome to TenoTrainer

You have been invited to help test TenoTrainer, which is currently in development.

Role: ${opts.humanRole}
Organization: ${opts.orgName}

We'd love for you to try the platform and share your feedback on usability and workflows.

Create your account:
${opts.inviteUrl}

This invitation was sent specifically to ${opts.recipientEmail} and will expire in 7 days.
If you weren't expecting this email, you can safely ignore it.
`;
}

// M3.3 S3c — `reason` is a fixed, non-sensitive code (never provider free
// text, configuration names or values).
export type EmailNotSentReason = EmailDeliveryCode | "email_not_configured" | "email_not_sent";
export type EmailResult =
  | { sent: true }
  | { sent: false; reason: EmailNotSentReason };

// M3.3 S3c — the only invitation-email path to the network. The central
// delivery policy (TENOTRAINER_EMAIL_PROVIDER + the development recipient
// allow-list) decides first; a configured Resend key alone never sends.
// M3.4d — the invitation send is bounded (as the safety provider is): a hung
// provider call must not hold the clinician's request. On timeout the email
// counts as not sent and the one-time link is still shown in the UI.
export const INVITATION_DELIVERY_TIMEOUT_MS = 15000;

// Resolves to the promise's value, or to "timeout" after `ms`.
export async function withDeliveryTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function deliver(message: { to: string; subject: string; html: string; text: string }): Promise<EmailResult> {
  const config = getConfig();
  const decision = emailDeliveryDecision(config, message.to);
  if (!decision.deliver) return { sent: false, reason: decision.code };
  const apiKey = getResendApiKey();
  const from = config.email.from;
  if (!apiKey || !from) return { sent: false, reason: "email_not_configured" };
  try {
    const outcome = await withDeliveryTimeout(new Resend(apiKey).emails.send({ from, ...message }), INVITATION_DELIVERY_TIMEOUT_MS);
    if (outcome === "timeout") return { sent: false, reason: "email_not_sent" };
    return outcome.error ? { sent: false, reason: "email_not_sent" } : { sent: true };
  } catch {
    return { sent: false, reason: "email_not_sent" };
  }
}

export async function sendInvitationEmail(opts: {
  to: string;
  inviteUrl: string;
  orgName: string;
  invitationType: string;
}): Promise<EmailResult> {
  const humanRole = HUMAN_ROLE[opts.invitationType] ?? "TenoTrainer Tester";

  return deliver({
    to: opts.to,
    subject: "You're Invited to Try TenoTrainer",
    html: invitationHtml({
      inviteUrl: opts.inviteUrl,
      orgName: opts.orgName,
      humanRole,
      recipientEmail: opts.to,
    }),
    text: invitationText({
      inviteUrl: opts.inviteUrl,
      orgName: opts.orgName,
      humanRole,
      recipientEmail: opts.to,
    }),
  });
}

// M2 — patient invitation. M3.4d (founder privacy decision): the email names
// only the organization and carries the link. It must not disclose clinician
// identity, care / rehabilitation / treatment wording, diagnosis, injury,
// pain or prescription information (lib/__tests__/invitationEmailPrivacy.test.ts).
export function buildPatientInvitationEmail(opts: { to: string; inviteUrl: string; orgName: string }): { subject: string; text: string; html: string } {
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const subject = "Your TenoTrainer invitation";
  const text = `You've been invited to TenoTrainer by ${opts.orgName}.

Accept your invitation:
${opts.inviteUrl}

This invitation was sent to ${opts.to} and expires in 7 days. If you weren't expecting it, you can ignore this email.
`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:560px;margin:40px auto;padding:0 16px;"><div style="background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;padding:36px;">
<div style="font-size:22px;font-weight:700;color:#2563eb;margin-bottom:24px;">TenoTrainer</div>
<p style="font-size:15px;line-height:1.6;color:#374151;">You've been invited to TenoTrainer by <strong>${esc(opts.orgName)}</strong>.</p>
<p style="margin:28px 0;text-align:center;"><a href="${esc(opts.inviteUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 32px;border-radius:8px;">Accept your invitation</a></p>
<p style="font-size:13px;color:#9ca3af;line-height:1.6;">This invitation was sent to ${esc(opts.to)} and expires in 7 days. If you weren't expecting it, you can ignore this email.</p>
<p style="font-size:12px;color:#6b7280;word-break:break-all;background:#f3f4f6;border-radius:6px;padding:10px 14px;">${esc(opts.inviteUrl)}</p>
</div></div></body></html>`;
  return { subject, text, html };
}

export async function sendPatientInvitationEmail(opts: { to: string; inviteUrl: string; orgName: string }): Promise<EmailResult> {
  const { subject, text, html } = buildPatientInvitationEmail(opts);
  return deliver({ to: opts.to, subject, html, text });
}
