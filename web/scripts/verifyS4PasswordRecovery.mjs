// M3.5 S4 — password recovery, live end to end over the real Next.js
// boundary against the DEVELOPMENT project only (assertDevTestTarget).
//
// No email is ever sent: the development email policy suppresses recovery
// requests for these @example.invalid fixtures, and the success path gets
// its one-time token from auth.admin.generateLink({ type: "recovery" }),
// which creates the token without sending anything. Fixtures (one
// clinician, one patient, one invited patient) are deleted at the end.
//
// Server: the development server (default http://localhost:3000; nothing is
// restarted). Run from web/:
//   TENOTRAINER_MODE=development node scripts/verifyS4PasswordRecovery.mjs [baseUrl]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { loadEnv } from "./lib/harnessEnv.mjs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
const RUN = randomUUID().slice(0, 8);
const OLD_PASSWORD = `s4-original-${RUN}-pw`;
const NEW_PASSWORD = `s4-recovered-${RUN}-pw!`;
const NEW_PASSWORD_2 = `s4-changed-again-${RUN}`;
const emailOf = (label) => `s4-${label}-${RUN}@example.invalid`;

const env = loadEnv(".env.local");
assertDevTestTarget(env);
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const WORK = mkdtempSync(join(tmpdir(), "s4-"));

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? `\n      ${String(detail).slice(0, 500)}` : ""}`); }
};
const section = (t) => console.log(`\n--- ${t} ---`);
function sqlExec(sql) {
  const path = join(WORK, `q-${randomUUID()}.sql`);
  writeFileSync(path, sql);
  execFileSync("supabase", ["db", "query", "--linked", "--file", path], { cwd: "..", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// ---------------------------------------------------------------- fixtures
const createdUsers = [];
async function makeUser(label, role) {
  const email = emailOf(label);
  const { data, error } = await admin.auth.admin.createUser({ email, password: OLD_PASSWORD, email_confirm: true });
  if (error) throw error;
  createdUsers.push(data.user.id);
  await admin.from("profiles").upsert({ id: data.user.id, name: `S4 ${label}`, timezone: "America/New_York" });
  const { error: e } = await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: data.user.id, role });
  if (e) throw e;
  return { id: data.user.id, email };
}
async function userIdByEmail(email) {
  for (let page = 1; page <= 20; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    const u = data?.users?.find((x) => x.email === email);
    if (u) return u.id;
    if (!data?.users?.length || data.users.length < 1000) return null;
  }
  return null;
}
async function memberships(userId) {
  const { data } = await admin.from("organization_members").select("organization_id, role").eq("user_id", userId).order("role");
  return JSON.stringify(data ?? []);
}
async function recoveryHash(email) {
  const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email });
  if (error) throw error;
  return data.properties.hashed_token;
}
async function teardown() {
  const invited = await userIdByEmail(emailOf("invited"));
  if (invited && !createdUsers.includes(invited)) createdUsers.push(invited);
  await admin.from("supervisor_patients").delete().in("patient_id", createdUsers);
  await admin.from("invitations").delete().like("email", `s4-%-${RUN}@example.invalid`);
  await admin.from("organization_members").delete().in("user_id", createdUsers);
  const leftovers = [];
  for (const id of createdUsers) {
    await admin.from("profiles").delete().eq("id", id);
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) leftovers.push(`${id}: ${error.message}`);
  }
  return leftovers;
}

// ---------------------------------------------------------------- browser
async function newCtx(browser) {
  return browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
}
async function login(ctx, email, password) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForLoadState("domcontentloaded");
  await page.waitForURL((u) => u.pathname !== "/login" || u.searchParams.has("error"), { timeout: 60000 });
  const url = new URL(page.url());
  await page.close();
  return url;
}
async function submitPassword(page, password, confirmation = password) {
  // Start from a clean URL each time, so the wait below can only see THIS
  // submission's outcome (a previous ?error= must not satisfy it).
  const clean = new URL(page.url());
  clean.search = clean.searchParams.get("recovery") === "1" ? "?recovery=1" : "";
  await page.goto(clean.href);
  // Bypass the browser's own checks (maxlength would silently truncate): the
  // server policy is what is under test.
  await page.evaluate(() => document.querySelectorAll("input").forEach((i) => i.removeAttribute("maxlength")));
  await page.fill("#password", password);
  await page.fill("#confirm_password", confirmation);
  await page.locator("form").first().evaluate((f) => { f.noValidate = true; });
  await page.getByTestId("save-password").click();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForURL((u) => u.searchParams.has("error") || u.searchParams.has("updated"), { timeout: 60000 });
  return new URL(page.url());
}
const confirmUrl = (hash, extra = "") => `${BASE}/auth/confirm?token_hash=${hash}&type=recovery${extra}`;

async function main() {
  section("0. setup (development fixtures)");
  const clinician = await makeUser("clinician", "clinician");
  const patient = await makeUser("patient", "member");
  const clinicianMembershipsBefore = await memberships(clinician.id);
  const patientMembershipsBefore = await memberships(patient.id);
  check("fixtures created (clinician + patient, @example.invalid)", !!clinician.id && !!patient.id);

  const browser = await chromium.launch();
  try {
    section("1. entry point and enumeration-safe request");
    {
      const ctx = await newCtx(browser);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/login`);
      const link = page.getByTestId("forgot-password-link");
      check("login shows a Forgot password? link to /login/forgot", (await link.count()) === 1 && (await link.getAttribute("href")) === "/login/forgot");
      const outcomes = [];
      for (const email of [patient.email, emailOf("nobody"), patient.email, patient.email, "not-an-email"]) {
        await page.goto(`${BASE}/login/forgot`);
        await page.fill("#email", email);
        // Skip the browser's own email-format check: the server's handling is under test.
        await page.locator("form").first().evaluate((f) => { f.noValidate = true; });
        await page.getByTestId("request-recovery").click();
        await page.getByTestId("recovery-requested").waitFor({ timeout: 60000 });
        outcomes.push({ url: page.url().replace(BASE, ""), text: (await page.getByTestId("recovery-requested").innerText()).trim() });
      }
      const same = outcomes.every((o) => o.url === outcomes[0].url && o.text === outcomes[0].text);
      check("known, unknown, repeated and malformed addresses get the identical response and URL", same && outcomes[0].url === "/login/forgot?sent=1", JSON.stringify(outcomes.map((o) => o.url)));
      check("the response never echoes the address", !outcomes.some((o) => o.text.includes("@") || o.url.includes("@")));
      const { data: u } = await admin.auth.admin.getUserById(patient.id);
      check("development email containment: no recovery was issued for a non-allow-listed address (recovery_sent_at unset)", !u.user.recovery_sent_at, String(u.user.recovery_sent_at));
      await ctx.close();
    }

    section("2. invalid, malformed and expired links");
    {
      const ctx = await newCtx(browser);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/auth/confirm?token_hash=not-a-hash&type=recovery`);
      check("malformed token → neutral problem page, no button", (await page.getByTestId("recovery-link-problem").count()) === 1 && (await page.getByTestId("confirm-recovery").count()) === 0);
      await page.goto(`${BASE}/auth/confirm?token_hash=${"a".repeat(56)}&type=signup`);
      check("wrong link type → problem page", (await page.getByTestId("recovery-link-problem").count()) === 1);
      await page.goto(confirmUrl(randomBytes(28).toString("hex")));
      await page.getByTestId("confirm-recovery").click();
      await page.waitForURL((u) => u.searchParams.get("error") === "invalid", { timeout: 60000 });
      check("well-formed but unknown token → POST refused → /auth/confirm?error=invalid (token gone from URL)",
        new URL(page.url()).pathname === "/auth/confirm" && !page.url().includes("token_hash"), page.url());

      const expired = await recoveryHash(patient.email);
      sqlExec(`UPDATE auth.users SET recovery_sent_at = now() - interval '2 hours' WHERE id = '${patient.id}';`);
      await page.goto(confirmUrl(expired));
      await page.getByTestId("confirm-recovery").click();
      await page.waitForURL((u) => u.searchParams.has("error"), { timeout: 60000 });
      check("expired token (issued > 1 h ago) → the same neutral invalid outcome", new URL(page.url()).searchParams.get("error") === "invalid", page.url());
      const r = await page.goto(`${BASE}/account/password`);
      check("no session was created by a refused link (/account/password → login)", new URL(page.url()).pathname === "/login", `${r?.status()} ${page.url()}`);
      await ctx.close();
    }

    section("3. patient recovery: prefetch-safe, single use, policy, role preserved");
    let patientHash;
    {
      patientHash = await recoveryHash(patient.email);
      // Link scanners / prefetchers: plain GETs (no cookies) must not spend the token.
      for (let i = 0; i < 3; i++) await fetch(confirmUrl(patientHash), { redirect: "manual" });
      const ctx = await newCtx(browser);
      const page = await ctx.newPage();
      await page.goto(confirmUrl(patientHash, "&next=https://evil.example/&redirect_to=https://evil.example/"));
      check("GET renders only the confirmation button", (await page.getByTestId("confirm-recovery").count()) === 1);
      await page.getByTestId("confirm-recovery").click();
      await page.waitForURL((u) => u.pathname === "/account/password" || u.searchParams.has("error"), { timeout: 60000 });
      const landed = new URL(page.url());
      check("after 3 prefetch GETs the token still verifies (GET never spends it)", landed.pathname === "/account/password", page.url());
      check("injected next / redirect_to are ignored: lands on same-origin /account/password?recovery=1",
        landed.origin === new URL(BASE).origin && landed.searchParams.get("recovery") === "1", page.url());
      check("recovery page: 'Choose a new password' for the right account",
        (await page.locator("h1").innerText()).includes("Choose a new password") && (await page.locator("main, body").first().innerText()).includes(patient.email));

      const cases = [
        ["9-character password", "abcdefghi", undefined, "too_short"],
        ["confirmation mismatch", NEW_PASSWORD, `${NEW_PASSWORD}x`, "mismatch"],
        ["the account's own email", patient.email, undefined, "same_as_email"],
        ["only spaces", " ".repeat(12), undefined, "blank"],
        ["more than 72 bytes", "x".repeat(73), undefined, "too_long"],
        ["the current password", OLD_PASSWORD, undefined, "same_password"],
      ];
      for (const [label, pw, conf, expected] of cases) {
        const url = await submitPassword(page, pw, conf);
        check(`${label} → refused (${expected}), fixed copy shown`, url.searchParams.get("error") === expected && (await page.getByTestId("password-error").count()) === 1, url.search);
      }
      const ok = await submitPassword(page, NEW_PASSWORD);
      check("valid new password → Password updated", ok.searchParams.get("updated") === "1" && (await page.getByTestId("password-updated").count()) === 1, ok.search);
      await page.getByTestId("continue-after-password").click();
      await page.waitForURL((u) => u.pathname !== "/dashboard" && u.pathname !== "/account/password", { timeout: 60000 });
      check("Continue → the patient's own home (/patient/dashboard)", new URL(page.url()).pathname === "/patient/dashboard", page.url());
      await ctx.close();

      const reuse = await newCtx(browser);
      const rp = await reuse.newPage();
      await rp.goto(confirmUrl(patientHash));
      await rp.getByTestId("confirm-recovery").click();
      await rp.waitForURL((u) => u.searchParams.has("error") || u.pathname === "/account/password", { timeout: 60000 });
      check("reusing the spent link → invalid (single use)", new URL(rp.url()).searchParams.get("error") === "invalid", rp.url());
      await reuse.close();

      const fresh = await newCtx(browser);
      check("the new password logs in", (await login(fresh, patient.email, NEW_PASSWORD)).pathname !== "/login");
      const bad = await newCtx(browser);
      const old = await login(bad, patient.email, OLD_PASSWORD);
      check("the old password no longer works (fixed code invalid_credentials)", old.searchParams.get("error") === "invalid_credentials", old.search);
      await bad.close();
      check("patient memberships unchanged", (await memberships(patient.id)) === patientMembershipsBefore);

      section("4. signed-in password change (not recovery)");
      const page2 = await fresh.newPage();
      await page2.goto(`${BASE}/patient/settings`);
      const settingsLink = page2.getByTestId("change-password-link");
      check("patient Settings links to /account/password", (await settingsLink.count()) === 1 && (await settingsLink.getAttribute("href")) === "/account/password");
      await page2.goto(`${BASE}/account/password`);
      check("signed-in page reads 'Change your password'", (await page2.locator("h1").innerText()).includes("Change your password"));
      const changed = await submitPassword(page2, NEW_PASSWORD_2);
      check("signed-in change succeeds", changed.searchParams.get("updated") === "1", changed.search);
      await fresh.close();
    }

    section("5. clinician recovery and session revocation");
    {
      // Session B: an ordinary browser login. Session C: a direct API session
      // (to observe refresh tokens and access tokens precisely).
      const ctxB = await newCtx(browser);
      check("clinician session B logged in", (await login(ctxB, clinician.email, OLD_PASSWORD)).pathname !== "/login");
      const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data: cSess, error: cErr } = await anon.auth.signInWithPassword({ email: clinician.email, password: OLD_PASSWORD });
      check("clinician session C (API) signed in", !cErr && !!cSess?.session, cErr?.message);
      const cAccess = cSess?.session?.access_token;
      const cRefresh = cSess?.session?.refresh_token;
      // C's tokens are used explicitly below (no client-side session state).
      const asC = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${cAccess}` } },
      });
      const { data: preRows } = await asC.from("profiles").select("id").eq("id", clinician.id);
      check("before the reset, C's access token reads its own profile at the Data API", preRows?.length === 1);

      const hash = await recoveryHash(clinician.email);
      const ctxA = await newCtx(browser);
      const pa = await ctxA.newPage();
      await pa.goto(confirmUrl(hash));
      await pa.getByTestId("confirm-recovery").click();
      await pa.waitForURL((u) => u.pathname === "/account/password", { timeout: 60000 });
      const done = await submitPassword(pa, NEW_PASSWORD);
      check("clinician recovery: password updated", done.searchParams.get("updated") === "1", done.search);
      await pa.getByTestId("continue-after-password").click();
      await pa.waitForURL((u) => u.pathname !== "/dashboard" && u.pathname !== "/account/password", { timeout: 60000 });
      check("Continue → the clinician's own home (/clinician/dashboard)", new URL(pa.url()).pathname === "/clinician/dashboard", pa.url());
      const staffLink = pa.getByTestId("staff-password-link");
      check("staff navigation links to /account/password", (await staffLink.count()) >= 1 && (await staffLink.first().getAttribute("href")) === "/account/password");

      const resA = await pa.goto(`${BASE}/clinician/dashboard`);
      check("the session that reset the password survives (A stays signed in)", new URL(pa.url()).pathname === "/clinician/dashboard" && resA?.status() === 200, pa.url());
      const pb = await ctxB.newPage();
      await pb.goto(`${BASE}/clinician/dashboard`);
      check("other browser session B is signed out immediately (server getUser → session_not_found → /login)", new URL(pb.url()).pathname === "/login", pb.url());
      // Raw call: auth-js maps the server's 403 session_not_found to a
      // client-side AuthSessionMissingError, so ask the Auth server directly.
      const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${cAccess}` } });
      const userBody = await userRes.json().catch(() => ({}));
      check("session C: Auth /user refuses its access token (403 session_not_found)", userRes.status === 403 && userBody.error_code === "session_not_found", `${userRes.status} ${userBody.error_code}`);
      const refresher = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data: refreshed, error: refreshErr } = await refresher.auth.refreshSession({ refresh_token: cRefresh });
      check("session C: its refresh token is revoked (refresh refused)", !!refreshErr && !refreshed?.session, `${refreshErr?.status} ${refreshErr?.code}`);
      const { data: rows, error: restErr } = await asC.from("profiles").select("id").eq("id", clinician.id);
      const stillValid = !restErr && rows?.length === 1;
      console.log(`      NOTE  session C's existing ACCESS token at the Data API after revocation: ${stillValid ? "still accepted until it expires (JWT exp ≤ 1 h)" : `refused (${restErr?.code ?? "no rows"})`}`);
      check("Data API behaviour of an unexpired access token after revocation recorded (documented limitation)", true);
      check("clinician memberships unchanged (role preserved)", (await memberships(clinician.id)) === clinicianMembershipsBefore);
      await ctxA.close();
      await ctxB.close();
    }

    section("6. login hardening and redirects");
    {
      const ctx = await newCtx(browser);
      const wrong = await login(ctx, clinician.email, "definitely-not-the-password");
      check("wrong password → fixed code invalid_credentials", wrong.searchParams.get("error") === "invalid_credentials", wrong.search);
      const unknown = await login(ctx, emailOf("nobody"), "definitely-not-the-password");
      check("unknown account → the identical code (no enumeration)", unknown.searchParams.get("error") === "invalid_credentials", unknown.search);
      const page = await ctx.newPage();
      const crafted = "Your account is locked. Call 555-0100 now";
      await page.goto(`${BASE}/login?error=${encodeURIComponent(crafted)}`);
      const shown = await page.getByTestId("login-error").innerText();
      check("free text in ?error= is never rendered (generic copy instead)", !shown.includes("555") && shown.includes("Something went wrong"), shown);
      await page.goto(`${BASE}/auth/callback?error=access_denied&error_description=${encodeURIComponent(crafted)}`);
      check("auth callback errors become a fixed code (link_invalid), description not echoed",
        new URL(page.url()).searchParams.get("error") === "link_invalid" && !(await page.locator("body").innerText()).includes("555"), page.url());
      const nextEvil = await newCtx(browser);
      const lp = await nextEvil.newPage();
      await lp.goto(`${BASE}/login?next=${encodeURIComponent("https://evil.example/steal")}`);
      await lp.fill("#email", clinician.email);
      await lp.fill("#password", NEW_PASSWORD);
      await lp.click('button[type="submit"]');
      await lp.waitForURL((u) => u.pathname !== "/login", { timeout: 60000 });
      check("login with an off-site next stays on our origin", new URL(lp.url()).origin === new URL(BASE).origin, lp.url());
      await nextEvil.close();
      await ctx.close();
    }

    section("7. invitation acceptance uses the shared policy");
    {
      const ctxC = await newCtx(browser);
      await login(ctxC, clinician.email, NEW_PASSWORD);
      const ip = await ctxC.newPage();
      await ip.goto(`${BASE}/clinician/invitations`);
      await ip.getByTestId("invite-email").fill(emailOf("invited"));
      await ip.getByTestId("send-invitation").click();
      await ip.getByTestId("invite-result").first().waitFor({ timeout: 60000 });
      const result = await ip.getByTestId("invite-result").first().getAttribute("data-result");
      const link = result === "created" ? (await ip.getByTestId("invite-link").first().innerText()).trim() : null;
      check("clinician created a patient invitation (link shown; email delivery disabled in development)", !!link, result);
      await ctxC.close();
      if (link) {
        const u = new URL(link);
        const target = `${BASE}${u.pathname}${u.search}`;
        const ctx = await newCtx(browser);
        const page = await ctx.newPage();
        const attempt = async (pw) => {
          await page.goto(target);
          await page.fill("#name", "S4 Invited");
          await page.fill("#password", pw);
          await page.locator("form").first().evaluate((f) => { f.noValidate = true; });
          await page.locator('form button[type="submit"]').first().click();
          await page.waitForLoadState("domcontentloaded");
          await page.waitForURL((x) => x.searchParams.has("error") || !x.pathname.startsWith("/invite"), { timeout: 60000 });
          return new URL(page.url());
        };
        const short = await attempt("abcdefghi");
        check("invitation: 9-character password refused (password_too_short)", short.searchParams.get("error") === "password_too_short", short.search);
        const same = await attempt(emailOf("invited"));
        check("invitation: password = invited email refused (password_same_as_email)", same.searchParams.get("error") === "password_same_as_email", same.search);
        const okUrl = await attempt(`s4-invited-${RUN}-password`);
        check("invitation: a 10+ character password is accepted → patient dashboard", okUrl.pathname === "/patient/dashboard", okUrl.href);
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (e) {
  check("suite completed", false, e.stack ?? e.message);
} finally {
  const leftovers = await teardown();
  check("teardown: every fixture account deleted", leftovers.length === 0, leftovers.join("; "));
  const remaining = [];
  for (const label of ["clinician", "patient", "invited"]) if (await userIdByEmail(emailOf(label))) remaining.push(label);
  check("no s4 fixture account remains", remaining.length === 0, remaining.join(","));
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
