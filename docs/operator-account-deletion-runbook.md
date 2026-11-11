# Operator runbook: Alpha 1 participant account deletion requests

Operator-only. There is no self-service deletion, route, API or UI. Use the
CLI `web/scripts/operatorDeleteAccount.mjs`. It works on **one** patient
account at a time and defaults to a **dry run** that changes nothing.

## Deletion versus closure

| Outcome | When | What happens | What to tell the participant |
|---|---|---|---|
| **DELETE** | The account has **no** protected safety history | The account and every record about it are removed: sign-in identity, profile, membership, clinician assignment, invitations, program, sessions and check-ins, the Participation Agreement record. The tool re-checks that nothing in the database still references the account | "Your account and testing information have been deleted from TenoTrainer's database" (plus the provider limits below) |
| **CLOSE** | The account **has** protected safety history (acute safety episodes, safety notifications and their delivery records) | The safety records are **kept unchanged**, because their protections are never switched off. The account is closed: sign-in blocked, sessions revoked, email replaced with `closed+<id>@deleted.invalid`, name, profile details and time zone cleared, clinician assignment ended (clinicians lose in-app access), pending invitations cancelled. Testing records (sessions, check-ins, program) and the agreement record stay attached to the closed account | "Your account has been closed and your name and email address removed from it. Safety records cannot be deleted and are kept, together with your other testing records" (plus the provider limits below). **Never call a closure a deletion, and never call it anonymization:** the retained records can still contain personal information (section 5). |
| **REFUSED** | Unknown account, email ≠ account, any non-patient role (clinician, clinician admin, super user, tester), the account authored records about other people, or the account is already closed | Nothing | Escalate to the founder. Staff accounts are never removed with this tool |

## 1. Receive the request
- Requests arrive at **tenotrainer@tenotrainer.com**.
- Log it straight away (see section 8). Record the date it was received and the address it came from.

## 2. Verify ownership
- Act **only** on a request sent **from the account's registered email address**.
- Reply to that address and ask the participant to confirm. Proceed only once they confirm **from that same address**.
- Never act on a request made on someone else's behalf, or sent from a different address.

## 3. Find the account (read-only)
Use the Management API's read-only endpoint against the target project:
```sql
SELECT id, created_at FROM auth.users WHERE lower(email) = lower('<address>');
```
Exactly one row is expected. The CLI needs both the UUID and the email address, and refuses if they don't belong to the same account.

## 4. Dry run (changes nothing)
Run the CLI from `web/`, in the **prod-ops** worktree checked out at a commit that contains this tool. For Production, both confirmations are required:
```bash
node scripts/operatorDeleteAccount.mjs --project wfaalpfobpmojohetjlr --production --confirm-project wfaalpfobpmojohetjlr \
  --user-id <uuid> --email <address>
```
Development is `--project kpdxlzqtvueiytwjamiw` with no `--production` flag.

The CLI:
- confirms the project through the Management API and prints its name and environment;
- runs the inventory inside a transaction that is **rolled back**;
- prints the outcome (DELETE / CLOSE / REFUSED), the records that would be removed, any protected safety records, any records about other people, what a closure would retain, and a **plan hash**;
- writes an audit record to `~/.tenotrainer-account-deletions/`. The record holds the email's hash, never the email itself.

The access token comes from `SUPABASE_ACCESS_TOKEN` or `~/.supabase/access-token` and is never printed.

## 5. Review
- **REFUSED:** stop and escalate.
- **CLOSE:** read the "identifiable data a closure retains" section:
  - free-text morning check-in notes (a submitted check-in can't be changed);
  - free-text "other contributor" text in sessions, and session event notes;
  - clinician release notes;
  - the time zones recorded on sessions;
  - Supabase Auth sign-in log entries (email, IP address).

  A closed account is **not anonymous**: the account's identity fields are removed, but these records stay linked to it and may identify the participant. Say so in the reply (section 7).
- **Unexpected records** (anything that isn't this participant's own testing data): stop and escalate.

## 6. Authorize and apply
1. The founder approves, in writing, **this account, this outcome and this plan hash**. Record that approval in the log.
2. Run the apply with the same arguments plus `--apply --plan-hash <hash from the dry run>`.

Use a **scoped** access token for Production (see section 10), passed in the environment:
```bash
read -s -p "Token: " SUPABASE_ACCESS_TOKEN; echo; export SUPABASE_ACCESS_TOKEN
# … dry run / apply …
unset SUPABASE_ACCESS_TOKEN
```

**What apply does:**
- **One transaction:** it locks the account, re-derives the plan, and **refuses if the hash differs** (the account changed since the dry run). In that case, run a new dry run.
- **Checks before committing:**
  - **DELETE:** no table references the account any more;
  - **CLOSE:** the account is closed and de-identified, its sessions are gone, and the protected record counts are unchanged;
  - **both:** every trigger is still enabled.

  Any failure rolls back **everything**.
- **Afterwards,** a separate run confirms the result (`account_not_found` after a delete, `already_closed` after a closure).

**After a CLOSE: re-check once the participant's last token has expired (wait at least 60 minutes).**
An access token issued before the closure stays cryptographically valid for up to one hour (`jwt_exp` 3600).

Measured on Development, a closed account's old tokens:
- are **rejected by the application**, because every request re-validates with Supabase Auth and the session is gone;
- **cannot be refreshed**;
- **cannot sign in** with the old address;
- get **401 from the Data API without the API key**.

However, **with** the project's API key (which the application never sends to browsers), the old token could still edit the participant's **own** profile until it expires. So after 60 minutes, run a dry run addressed by the placeholder:
```bash
node scripts/operatorDeleteAccount.mjs … --user-id <uuid> --email closed+<uuid>@deleted.invalid
```
- **REFUSED `already_closed`:** the closure is intact. Done.
- **CLOSE with `RE-CLOSE`:** something was changed, and the drift is listed. Get approval and apply with the new plan hash; that re-applies the same de-identification. Then re-check again.

## 7. Communicate
- Say what actually happened: **deleted** or **closed and de-identified**.
- Describe the provider limits honestly (section 9).
- Don't promise anything about backups or provider logs beyond those limits.
- Reply only to the verified address. After a deletion, that address is no longer stored in TenoTrainer's database.

## 8. Record the request and its resolution
Keep the log **outside** the application database, in the operator's private records. One entry per request:
- date received, and date of the ownership confirmation;
- account UUID; **not** the email, or only its SHA-256;
- dry-run plan hash and outcome;
- the founder's approval, with date;
- apply time, result and post-check;
- path of the CLI audit file;
- date the reply was sent.

## 9. Data TenoTrainer cannot remove with this tool
| Where | Holds | Under TenoTrainer's control? |
|---|---|---|
| Supabase database backups | Earlier copies of all data, including the deleted account | No. They expire on Supabase's backup schedule for the plan |
| Supabase Auth sign-in log (`auth.audit_log_entries`) and Supabase platform logs | Sign-in events, IP address, email | The in-database table is Supabase Auth's internal log; this tool leaves Auth's internals alone. Platform logs follow Supabase's retention |
| Vercel request and runtime logs | IP addresses, request paths, timestamps | No. They follow Vercel's retention for the plan |
| Resend delivery records | Recipient email address of invitation and password-reset emails | Provider-held, under Resend's retention. Deleting them would need a provider request |
| The tenotrainer@tenotrainer.com mailbox | The request and the conversation | Yes, managed by the operator |
| The operator's audit files and log | Account UUID, email hash, outcome | Yes. Kept as the record of the request |

## 10. Credential for Production
Do **not** use a classic (full-access) personal token. Supabase supports **scoped personal access tokens**, limited to chosen projects and permissions and with a custom expiry. For this tool, create one just before an approved run:
- project: **Production only**;
- permissions: **Database: Read-write** (to run the transaction) and **Project Settings: Read** (the CLI confirms the project's identity);
- expiry: **as short as possible**, for example one day.

**Revoke it after use.** Record its creation and revocation in the request log.

Within that project, the database query endpoint can still run any SQL. The scoping limits *which project and which API*, not which tables. Only the founder-approved CLI runs with it. Never paste the token into a terminal command line or a file; enter it at the hidden prompt shown in section 6.
