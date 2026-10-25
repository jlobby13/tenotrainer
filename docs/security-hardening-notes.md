# Security Hardening Notes

Items audited 2026-09-01. Critical and high-severity issues are fixed.
Items below are documented for future hardening — they do not block safe production use.

## Fixed (Critical / High)

| Issue | Fix applied |
|---|---|
| `/setup` privilege escalation — any self-registered user could become `super_user` | Added "no org exists" guard: setup blocked once any organization is in the database |
| Password minimum length: 6 | Raised to 8 in Supabase Auth config |
| Password change required no reauthentication | `security_update_password_require_reauthentication` enabled |
| SSL not enforced on database connections | `ssl-enforcement` endpoint → `database: true` |
| Security notification emails disabled | `mailer_notifications_password_changed_enabled` and `mailer_notifications_mfa_factor_enrolled_enabled` both enabled |

## Confirmed Safe (no action needed)

- All 22 tables have RLS enabled; all 55+ policies verified by audit
- `granted_role` always derived server-side from `INVITATION_ROLE_MAP` — browser never submits a role
- `organization_id`, `accepted_by` never from browser input
- Invitation replay protection: atomic `UPDATE WHERE status='pending' AND expires_at > NOW()`
- Invitation token entropy: 256-bit (`crypto.randomBytes(32)`)
- Bridge token: 60-second TTL, single-use enforced, 256-bit entropy
- `SUPABASE_SERVICE_ROLE_KEY` and `BRIDGE_SECRET` — all usages confirmed server-only, zero `NEXT_PUBLIC_` exposure
- SQL in `supervisor.py`: f-strings build `?` placeholder counts from server-controlled ID lists only — no user input interpolated
- JWT expiry: 1 hour
- Custom SMTP via Resend, email confirmations required, secure email-change confirmation enabled

## Medium — Recommended before scale / compliance

### Session inactivity timeout
`sessions_inactivity_timeout_enabled` is not set. For a healthcare app, sessions should expire
after a period of inactivity (e.g., 8 hours). Enable via Supabase Dashboard →
Authentication → Sessions → Timebox / Inactivity timeout.

### MFA requirement for admin accounts
TOTP MFA is available to all users but not enforced. Super-user and clinician_admin accounts
should be required to enroll MFA before accessing sensitive dashboards. This requires either:
- Supabase Auth hook to enforce MFA at login for specific roles, or
- Application-level check: if `session.amr` does not include `totp`, redirect to MFA enrollment

### HIBP leaked password protection
`password_hibp_enabled` requires Supabase Pro plan. Upgrade to Pro to enable checking passwords
against the HaveIBeenPwned breach database at sign-up and password change.

### Public self-registration
M2 (2026-10-25): `/register` is no longer an onboarding path — it redirects to
`/login` with invitation-required copy, and the app's public sign-up action was
deleted. Accounts are created only by accepting an invitation. The Supabase
public sign-up endpoint itself is still enabled at the project level and must be
disabled in production (M3 environment configuration); an orphan account has no
membership, no clinician and sees only "No active program".

## Low — Post-launch hardening

### Bridge token multi-instance limitation
`web/lib/bridge.ts` stores OTT bridge tokens in-process memory. A horizontally scaled
production deployment (multiple Next.js instances behind a load balancer) would lose tokens
if a request hits a different instance. Fix before scaling: back the token store with Redis
or a short-TTL database table.

### MFA unenrollment notification emails
`mailer_notifications_mfa_factor_unenrolled_enabled` is not enabled. If an attacker removes
a user's MFA factor, no email is sent. Enable alongside the enrolled notification.

### Rate limit on invitation sends
Invitations can be created in bulk without email rate limiting (only 2 auth emails/hour
are rate-limited, not transactional invitation emails via Resend). Since M2, clinicians
can also send PATIENT invitations (role fixed to `member`); invitation tokens are stored
only as SHA-256 hashes and all invitation writes are server-side.

### Audit log retention
`supervisor_audit_logs` captures supervisor actions. No retention or rotation policy is
defined. Consider adding a `created_at < NOW() - INTERVAL '2 years'` cleanup job before
the table grows large.
