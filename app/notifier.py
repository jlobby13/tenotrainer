"""
TenoTrainer — 2FA email notification sender.

Reads credentials from environment variables:
  SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS, SMTP_FROM

If credentials are not configured the code is printed to the server log
so development works without an external mail service.
"""

import logging
import os
import random

logger = logging.getLogger("tenotrainer.notifier")


def generate_code() -> str:
    """Return a zero-padded 6-digit string."""
    return f"{random.randint(0, 999999):06d}"


def mask_email(email: str) -> str:
    if not email or "@" not in email:
        return "****"
    local, domain = email.split("@", 1)
    masked_local = local[:2] + "*" * max(2, len(local) - 2)
    parts = domain.rsplit(".", 1)
    tld = parts[1] if len(parts) == 2 else ""
    masked_domain = parts[0][:2] + "*" * max(1, len(parts[0]) - 2)
    return f"{masked_local}@{masked_domain}.{tld}"


async def send_2fa_email(to_email: str, code: str, user_name: str) -> bool:
    """Send 2FA code by email. Returns True on success."""
    smtp_host = os.getenv("SMTP_HOST")
    smtp_user = os.getenv("SMTP_USER")
    smtp_pass = os.getenv("SMTP_PASS")
    smtp_from = os.getenv("SMTP_FROM") or smtp_user
    smtp_port = int(os.getenv("SMTP_PORT", "587"))

    if not smtp_host or not smtp_user:
        logger.warning("[2FA EMAIL — dev mode] To: %s | Code: %s", to_email, code)
        return True

    try:
        import aiosmtplib
        from email.mime.multipart import MIMEMultipart
        from email.mime.text import MIMEText

        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"Your TenoTrainer verification code: {code}"
        msg["From"] = smtp_from
        msg["To"] = to_email

        plain = (
            f"Hi {user_name},\n\n"
            f"Your TenoTrainer verification code is:\n\n"
            f"  {code}\n\n"
            f"This code expires in 10 minutes. Do not share it with anyone.\n\n"
            f"If you did not request this code, you can safely ignore this message.\n\n"
            f"— TenoTrainer"
        )

        html = f"""<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 16px;color:#1e293b;background:#ffffff;">
  <p style="font-size:14px;color:#64748b;margin:0 0 20px;">Hi {user_name},</p>
  <p style="font-size:14px;margin:0 0 20px;">Your TenoTrainer verification code is:</p>
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:28px;text-align:center;margin:0 0 24px;">
    <span style="font-size:40px;font-weight:800;letter-spacing:0.2em;color:#0284c7;font-family:monospace;">{code}</span>
  </div>
  <p style="font-size:12px;color:#94a3b8;margin:0 0 8px;">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
  <p style="font-size:12px;color:#94a3b8;margin:0 0 24px;">If you did not request this, you can safely ignore this message.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 16px;">
  <p style="font-size:11px;color:#cbd5e1;margin:0;">TenoTrainer — Achilles Tendinopathy Rehabilitation</p>
</body>
</html>"""

        msg.attach(MIMEText(plain, "plain"))
        msg.attach(MIMEText(html, "html"))

        await aiosmtplib.send(
            msg,
            hostname=smtp_host,
            port=smtp_port,
            username=smtp_user,
            password=smtp_pass,
            start_tls=True,
        )
        return True
    except Exception as exc:
        logger.error("Failed to send 2FA email to %s: %s", to_email, exc)
        return False


async def send_2fa_code(user: dict, code: str) -> bool:
    """Send a 2FA code to the user's registered email address."""
    return await send_2fa_email(
        user.get("email", ""),
        code,
        user.get("name", "User"),
    )


async def send_dismissal_email(
    to_email: str,
    user_name: str,
    reason_label: str,
    expires_at: str,
    days_remaining: int,
) -> bool:
    """Notify a patient that their case has been dismissed with a 14-day access window."""
    smtp_host = os.getenv("SMTP_HOST")
    smtp_user = os.getenv("SMTP_USER")
    smtp_pass = os.getenv("SMTP_PASS")
    smtp_from = os.getenv("SMTP_FROM") or smtp_user
    smtp_port = int(os.getenv("SMTP_PORT", "587"))

    if not smtp_host or not smtp_user:
        logger.warning(
            "[DISMISSAL EMAIL — dev mode] To: %s | Reason: %s | Expires: %s",
            to_email, reason_label, expires_at,
        )
        return True

    try:
        import aiosmtplib
        from email.mime.multipart import MIMEMultipart
        from email.mime.text import MIMEText

        msg = MIMEMultipart("alternative")
        msg["Subject"] = "Important: Your TenoTrainer case has been closed"
        msg["From"] = smtp_from
        msg["To"] = to_email

        plain = (
            f"Hi {user_name},\n\n"
            f"Your TenoTrainer rehabilitation case has been closed by your supervisor.\n\n"
            f"Reason: {reason_label}\n\n"
            f"You will retain full access to your account and data for {days_remaining} days "
            f"(until {expires_at}). After this date your login will be deactivated.\n\n"
            f"If you believe this is an error or have questions, please contact your supervisor.\n\n"
            f"— TenoTrainer"
        )

        html = f"""<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 16px;color:#1e293b;background:#ffffff;">
  <p style="font-size:14px;color:#64748b;margin:0 0 20px;">Hi {user_name},</p>
  <p style="font-size:14px;margin:0 0 16px;">Your TenoTrainer rehabilitation case has been closed by your supervisor.</p>
  <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:20px;margin:0 0 20px;">
    <p style="font-size:12px;font-weight:700;color:#b91c1c;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 6px;">Reason</p>
    <p style="font-size:14px;color:#991b1b;margin:0;">{reason_label}</p>
  </div>
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin:0 0 24px;">
    <p style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px;">Access Window</p>
    <p style="font-size:14px;color:#334155;margin:0 0 4px;">You retain full access to your account for <strong>{days_remaining} days</strong>.</p>
    <p style="font-size:14px;color:#334155;margin:0;">Your login will be deactivated on <strong>{expires_at}</strong>.</p>
  </div>
  <p style="font-size:12px;color:#94a3b8;margin:0 0 24px;">If you believe this is an error or have questions, please contact your supervisor directly.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 16px;">
  <p style="font-size:11px;color:#cbd5e1;margin:0;">TenoTrainer — Achilles Tendinopathy Rehabilitation</p>
</body>
</html>"""

        msg.attach(MIMEText(plain, "plain"))
        msg.attach(MIMEText(html, "html"))

        await aiosmtplib.send(
            msg,
            hostname=smtp_host,
            port=smtp_port,
            username=smtp_user,
            password=smtp_pass,
            start_tls=True,
        )
        return True
    except Exception as exc:
        logger.error("Failed to send dismissal email to %s: %s", to_email, exc)
        return False
