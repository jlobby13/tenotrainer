// M2 — native onboarding, assignment authority & clinician controls, live
// end-to-end over the REAL authenticated Next.js boundary, with FastAPI
// UNREACHABLE. The core M2 release gate:
//
//   invite -> accept -> authorize clinician -> create draft -> publish
//          -> pause -> resume -> release a professional-review hold
//
// all succeed while the server's FASTAPI_URL points at a CLOSED port, and a
// clinician who holds only a LEGACY (SQLite) assignment is refused — there
// is no silent fallback to legacy authority. The database-level matrix lives
// in verifyM2NativeOnboarding.sql.
//
// Server (isolated; never the user's :3000 / :8000). From web/ after
// `next build`:
//   C5_PATIENT_RUNTIME_ENABLED=true C5_PRESCRIPTION_PUBLISH_ENABLED=true \
//   FASTAPI_URL=http://127.0.0.1:59999 RESEND_API_KEY= npx next start -p 3001
// (RESEND_API_KEY= keeps the test from sending real email; the clinician UI
// then shows the one-time link, which the test follows.)
//
// Run from web/:
//   node scripts/verifyM2NativeOnboardingUi.mjs [onUrl] [deadFastapiUrl]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { sqlLocalDate, sqlLocalInstant } from "./lib/patientLocalDate.mjs";
import { guardedFixtureTeardown } from "./lib/safetyFixturePurge.mjs";

const ON = process.argv[2] ?? "http://localhost:3001";
const DEAD_FASTAPI = process.argv[3] ?? "http://127.0.0.1:59999";
const REPO_ROOT = "..";
const LEGACY_DB_PATH = "../app/tenotrainer.db";
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
const TZ = "America/New_York";
const PASSWORD = "throwaway-verification-1!";

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const eq = t.indexOf("=");
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}
const env = loadEnv(".env.local");
// M3.1 — refuse unless TENOTRAINER_MODE=development and the target project is allow-listed.
assertDevTestTarget(env);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const WORK = mkdtempSync(join(tmpdir(), "m2-"));
const RUN = randomUUID().slice(0, 8);

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}
function section(t) {
  console.log(`\n--- ${t} ---`);
}
function sqlExec(sql) {
  const path = join(WORK, `q-${randomUUID()}.sql`);
  writeFileSync(path, sql);
  execFileSync("supabase", ["db", "query", "--linked", "--file", path], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// ---------------------------------------------------------------- fixtures
const RUN_STARTED_AT = new Date(Date.now() - 60_000).toISOString();
const createdUsers = [];
const createdOrgs = [];
const legacyUserIds = [];
const legacyLinkIds = [];
const exerciseIds = [];
const emailOf = (label) => `m2-${label}-${RUN}@example.invalid`;

async function makeUser(label, { role = null, org = REAL_ORG_ID, name = null } = {}) {
  const email = emailOf(label);
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  createdUsers.push(data.user.id);
  await admin.from("profiles").upsert({ id: data.user.id, name: name ?? `M2 ${label}`, timezone: TZ });
  if (role) {
    const { error: e } = await admin.from("organization_members").insert({ organization_id: org, user_id: data.user.id, role });
    if (e) throw e;
  }
  return { userId: data.user.id, email, label, name: name ?? `M2 ${label}` };
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
function legacy(fn) {
  const db = new DatabaseSync(LEGACY_DB_PATH);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function teardown() {
  // M3.2 — the guarded exact-id purge (safety-notification history is
  // immutable, so ordinary deletes can no longer remove these fixtures).
  // Pending invitations to this run's (never-registered) addresses are
  // scoped by the unique run token.
  guardedFixtureTeardown(env, { userIds: createdUsers, organizationIds: createdOrgs, exerciseIds, runStartedAt: RUN_STARTED_AT });
  const { error: invError } = await admin.from("invitations").delete().like("email", `m2-%-${RUN}@example.invalid`);
  if (invError) throw new Error(`invitation cleanup failed: ${invError.message}`);
  legacy((db) => {
    for (const id of legacyLinkIds) db.prepare("DELETE FROM supervisor_patients WHERE id = ?").run(id);
    for (const id of legacyUserIds) db.prepare("DELETE FROM users WHERE id = ?").run(id);
  });
}

// ---------------------------------------------------------------- browser / API
async function newCtx(browser) {
  return browser.newContext({ viewport: { width: 1280, height: 900 } });
}
async function login(browser, email, next = null) {
  const context = await newCtx(browser);
  const page = await context.newPage();
  await page.goto(`${ON}/login${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
  await page.close();
  return context;
}
async function api(ctx, method, path, data) {
  const res = await ctx.request.fetch(`${ON}${path}`, { method, data, failOnStatusCode: false, maxRedirects: 0 });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON
  }
  return { status: res.status(), body };
}
async function pageText(ctx, path) {
  const page = await ctx.newPage();
  const res = await page.goto(`${ON}${path}`);
  const body = await page.locator("body").innerText();
  return { page, status: res?.status() ?? 0, body };
}

// Clinician UI: invite a patient; returns the one-time link (or the error code).
async function inviteViaUi(ctx, email) {
  const page = await ctx.newPage();
  await page.goto(`${ON}/clinician/invitations`);
  await page.getByTestId("invite-email").fill(email);
  await page.getByTestId("send-invitation").click();
  await page.getByTestId("invite-result").first().waitFor({ timeout: 20000 });
  const result = await page.getByTestId("invite-result").first().getAttribute("data-result");
  const link = result === "created" ? (await page.getByTestId("invite-link").first().innerText()).trim() : null;
  await page.close();
  return { result, link, token: link ? new URL(link).searchParams.get("token") : null };
}
const onUrl = (link) => {
  const u = new URL(link);
  return `${ON}${u.pathname}${u.search}`;
};

async function invitationRow(token) {
  const { data } = await admin.from("invitations").select("*").eq("token_hash", sha256(token)).maybeSingle();
  return data;
}
async function activeAssignments(patientId) {
  const { data } = await admin.from("supervisor_patients").select("*").eq("patient_id", patientId).eq("status", "active");
  return data ?? [];
}

async function main() {
  // ------------------------------------------------------------ preconditions
  section("0. FastAPI is unreachable for this verification");
  {
    let refused = false;
    try {
      await fetch(`${DEAD_FASTAPI}/api/internal/supervisor-status`, { signal: AbortSignal.timeout(3000) });
    } catch {
      refused = true;
    }
    check(`the configured FastAPI URL (${DEAD_FASTAPI}) refuses connections`, refused);
    const probe = await fetch(`${ON}/api/clinician/patients/${randomUUID()}/prescription/pause`, { method: "POST" });
    check("isolated gate-on server reachable (unauthenticated pause -> 401)", probe.status === 401, `status ${probe.status}`);
  }

  const clin1 = await makeUser("clin1", { role: "clinician", name: "Dana Inviter" });
  const clin2 = await makeUser("clin2", { role: "clinician", name: "Sam Second" });
  const clinOther = await makeUser("clin-other", { role: "clinician", name: "Lee Unrelated" });
  const orgAdmin = await makeUser("admin", { role: "clinician_admin", name: "Ari Admin" });
  const existing = await makeUser("existing-patient", { role: "member" });
  const { data: orgB, error: orgBErr } = await admin.from("organizations").insert({ name: `M2 Other Clinic ${RUN}`, slug: `m2-other-${RUN}` }).select("id").single();
  if (orgBErr) throw orgBErr;
  createdOrgs.push(orgB.id);
  const clinB = await makeUser("clin-b", { role: "clinician", org: orgB.id, name: "Bo OtherOrg" });
  const newEmail = emailOf("new-patient");

  const browser = await chromium.launch();
  try {
    const ctx1 = await login(browser, clin1.email);

    // ------------------------------------------------------------ invite
    section("1. Clinician creates a patient invitation (native UI)");
    let inv = null;
    {
      const page = await ctx1.newPage();
      await page.goto(`${ON}/clinician/dashboard`);
      await page.getByTestId("nav-invite-patient").click();
      await page.waitForURL(/\/clinician\/invitations/);
      check("clinician dashboard links to Invite patient", page.url().endsWith("/clinician/invitations"));
      await page.close();
      inv = await inviteViaUi(ctx1, newEmail);
      check("1. invitation created; one-time link shown once in the response (no email configured)", inv.result === "created" && !!inv.token, JSON.stringify(inv));
      const row = await invitationRow(inv.token);
      check("1. stored: type PATIENT, role member, inviter = clinician, SHA-256 hash only (no plaintext column)",
        row?.invitation_type === "PATIENT" && row.granted_role === "member" && row.invited_by === clin1.userId && row.status === "pending"
          && row.token_hash === sha256(inv.token) && !("token" in row), JSON.stringify(row));
      const { body } = await pageText(ctx1, "/clinician/invitations");
      check("the clinician's invitation list shows it as pending", body.includes(newEmail) && body.includes("pending"));
      const staff = await inviteViaUi(ctx1, clinOther.email);
      check("13. inviting a staff address of the clinic is refused at creation", staff.result === "staff_account", JSON.stringify(staff));
    }

    // ------------------------------------------------------------ new patient accepts
    section("2/4/38. New patient accepts natively; gate-on patient with no program stays native");
    let patient = null;
    let ctxP = null;
    {
      ctxP = await newCtx(browser);
      const page = await ctxP.newPage();
      await page.goto(onUrl(inv.link));
      const inviter = await page.getByTestId("invite-inviter").innerText();
      check("5/D5. acceptance page names the inviting clinician", inviter.includes("Dana Inviter"), inviter);
      const orgName = await page.getByTestId("invite-organization").innerText();
      const { data: realOrg } = await admin.from("organizations").select("name").eq("id", REAL_ORG_ID).single();
      check("acceptance page shows the organization name", orgName === realOrg.name, `${orgName} vs ${realOrg.name}`);
      check("explicit 'Accept invitation' action, no extra checkbox", (await page.getByTestId("accept-invitation").innerText()).trim() === "Accept invitation" && (await page.locator('input[type="checkbox"]').count()) === 0);
      await page.fill("#name", "Pat Newcomer");
      await page.fill("#password", PASSWORD);
      await page.getByTestId("accept-invitation").click();
      await page.waitForURL((u) => u.pathname === "/patient/dashboard", { timeout: 30000 });
      check("2. success routes into native Next.js (/patient/dashboard), never the FastAPI bridge", new URL(page.url()).pathname === "/patient/dashboard");
      const body = await page.locator("body").innerText();
      check("38. gate-on patient with no prescription stays in the native C5 app: 'No active program'", body.includes("No active program") && !/Track Session|Exercise Library/.test(body), body.slice(0, 300));
      await page.close();
      const id = await userIdByEmail(newEmail);
      createdUsers.push(id);
      patient = { userId: id, email: newEmail };
      await admin.from("profiles").update({ timezone: TZ }).eq("id", id);
      const { data: mem } = await admin.from("organization_members").select("organization_id, role").eq("user_id", id);
      const sp = await activeAssignments(id);
      const row = await invitationRow(inv.token);
      check("4. one transaction: member membership + active assignment (org, inviter, source invitation) + accepted state",
        mem?.length === 1 && mem[0].role === "member" && mem[0].organization_id === REAL_ORG_ID
          && sp.length === 1 && sp[0].supervisor_id === clin1.userId && sp[0].organization_id === REAL_ORG_ID && sp[0].source_invitation_id === row.id
          && row.status === "accepted" && row.accepted_by === id, JSON.stringify({ mem, sp, status: row?.status }));
    }

    section("5/11. Replay");
    {
      const page = await ctxP.newPage();
      await page.goto(onUrl(inv.link));
      check("5. same-user replay shows an idempotent success state", (await page.getByTestId("invite-state").getAttribute("data-state")) === "already_accepted");
      await page.close();
      check("5. no duplicate assignment after replay", (await activeAssignments(patient.userId)).length === 1);
      const ctxE = await login(browser, existing.email);
      const p2 = await ctxE.newPage();
      await p2.goto(onUrl(inv.link));
      check("11. another user opening the consumed link sees 'already accepted' (no form)", (await p2.getByTestId("invite-state").getAttribute("data-state")) === "already_used" && (await p2.getByTestId("accept-invitation").count()) === 0);
      await p2.close();
      await ctxE.close();
      const { data: r } = await admin.rpc("accept_patient_invitation", { p_token_hash: sha256(inv.token), p_user_id: existing.userId });
      check("11. the consumed token cannot be claimed by another user (RPC)", r?.result === "already_used" && (await activeAssignments(existing.userId)).length === 0, JSON.stringify(r));
    }

    section("3. Existing patient account accepts (login handoff with a safe next)");
    {
      const i2 = await inviteViaUi(ctx1, existing.email);
      const ctx = await newCtx(browser);
      const page = await ctx.newPage();
      await page.goto(onUrl(i2.link));
      await page.getByTestId("invite-login").click();
      await page.waitForURL(/\/login/);
      await page.fill("#email", existing.email);
      await page.fill("#password", PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForURL((u) => u.pathname === "/invite/accept", { timeout: 20000 });
      check("login returns to the invitation (validated internal next)", new URL(page.url()).searchParams.get("token") === i2.token);
      await page.getByTestId("accept-invitation").click();
      await page.waitForURL((u) => u.pathname === "/patient/dashboard", { timeout: 20000 });
      const sp = await activeAssignments(existing.userId);
      const { data: mem } = await admin.from("organization_members").select("role").eq("user_id", existing.userId);
      check("3. existing patient accepted: assignment created, membership unchanged", sp.length === 1 && sp[0].supervisor_id === clin1.userId && mem.length === 1 && mem[0].role === "member", JSON.stringify({ sp, mem }));
      await page.close();
      await ctx.close();
    }

    section("12/9/10. Wrong account, expired, cancelled");
    {
      const other = emailOf("someone-else");
      const i3 = await inviteViaUi(ctx1, other);
      const ctxE = await login(browser, existing.email);
      const page = await ctxE.newPage();
      await page.goto(onUrl(i3.link));
      check("12. wrong signed-in account: wrong-account notice, no accept form", (await page.getByTestId("invite-wrong-account").count()) === 1 && (await page.getByTestId("accept-invitation").count()) === 0);
      await page.close();
      await ctxE.close();
      check("12. invitation still pending", (await invitationRow(i3.token)).status === "pending");

      await admin.from("invitations").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("token_hash", sha256(i3.token));
      const ctxAnon = await newCtx(browser);
      const p2 = await ctxAnon.newPage();
      await p2.goto(onUrl(i3.link));
      check("9. expired invitation: expired state, no form", (await p2.getByTestId("invite-state").getAttribute("data-state")) === "expired" && (await p2.getByTestId("accept-invitation").count()) === 0);

      const i4 = await inviteViaUi(ctx1, emailOf("to-cancel"));
      const lp = await ctx1.newPage();
      await lp.goto(`${ON}/clinician/invitations`);
      await lp.locator(`[data-testid="invitation-row"][data-email="${emailOf("to-cancel")}"] [data-testid="cancel-invitation"]`).click();
      await lp.waitForURL(/cancelled=1/);
      await lp.close();
      await p2.goto(onUrl(i4.link));
      check("10. cancelled invitation (cancelled by the clinician in the UI): cancelled state", (await p2.getByTestId("invite-state").getAttribute("data-state")) === "cancelled");
      await p2.close();
      await ctxAnon.close();
    }

    section("14. Concurrent acceptance");
    {
      const raceEmail = emailOf("race");
      const { data: u } = await admin.auth.admin.createUser({ email: raceEmail, password: PASSWORD, email_confirm: true });
      createdUsers.push(u.user.id);
      const i5 = await inviteViaUi(ctx1, raceEmail);
      const results = await Promise.all(
        [1, 2, 3, 4, 5, 6].map(() => admin.rpc("accept_patient_invitation", { p_token_hash: sha256(i5.token), p_user_id: u.user.id }))
      );
      const kinds = results.map((r) => r.data?.result ?? r.error?.message);
      check("14. six simultaneous acceptances: exactly one 'accepted', the rest idempotent", kinds.filter((k) => k === "accepted").length === 1 && kinds.filter((k) => k === "already_accepted").length === 5, kinds.join(","));
      const { data: rows } = await admin.from("supervisor_patients").select("id").eq("patient_id", u.user.id);
      const { data: mem } = await admin.from("organization_members").select("id").eq("user_id", u.user.id);
      check("14. one assignment row and one membership row", rows.length === 1 && mem.length === 1);
    }

    // ------------------------------------------------------------ authorization with FastAPI down
    section("18/19/22/23. Authorization, create draft and publish with FastAPI unreachable");
    let versionId = null;
    let workout = null;
    {
      // Negative control: a clinician with ONLY a legacy SQLite assignment.
      legacy((db) => {
        const ins = db.prepare("INSERT INTO users (name, email, role, supabase_id) VALUES (?, ?, ?, ?)");
        const lc = ins.run(`m2-legacy-clin-${RUN}`, clinOther.email, "supervisor", clinOther.userId).lastInsertRowid;
        const lp = ins.run(`m2-legacy-pat-${RUN}`, patient.email, "patient", patient.userId).lastInsertRowid;
        legacyUserIds.push(lc, lp);
        legacyLinkIds.push(db.prepare("INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (?, ?, 'active')").run(lc, lp).lastInsertRowid);
      });
      const ctxO = await login(browser, clinOther.email);
      const r = await api(ctxO, "POST", `/api/clinician/patients/${patient.userId}/prescription-drafts`, { source: "empty" });
      check("18. unrelated clinician (legacy SQLite assignment only) cannot create a draft — no legacy fallback", r.status === 403 && r.body?.error === "PATIENT_NOT_AUTHORIZED", JSON.stringify(r));
      const { status } = await pageText(ctxO, `/clinician/patients/${patient.userId}`);
      check("18. unrelated clinician cannot open the patient (404)", status === 404, `status ${status}`);
      await ctxO.close();

      const { status: s1 } = await pageText(ctx1, `/clinician/patients/${patient.userId}`);
      check("19. the assigned clinician opens the patient", s1 === 200, `status ${s1}`);
      const created = await api(ctx1, "POST", `/api/clinician/patients/${patient.userId}/prescription-drafts`, { source: "empty" });
      check("22. create draft succeeds with FastAPI unreachable (201)", created.status === 201 && !!created.body?.draftId, JSON.stringify(created));
      const draftId = created.body?.draftId;

      const { data: ex, error: exErr } = await admin.from("canonical_exercises").insert({ name: `M2 Heel raise ${RUN}`, visibility: "global", active: true }).select("id").single();
      if (exErr) throw exErr;
      exerciseIds.push(ex.id);
      await admin.from("prescription_drafts").update({ scheduling_mode: "sequence", target_sessions_per_week: 3 }).eq("id", draftId);
      const { data: w } = await admin.from("prescription_workouts").insert({ prescription_draft_id: draftId, label: "A", order_index: 0 }).select("id").single();
      const { data: pe } = await admin.from("prescription_exercises").insert({ prescription_workout_id: w.id, canonical_exercise_id: ex.id, order_index: 0 }).select("id").single();
      await admin.from("prescription_exercise_dosage").insert({ prescription_exercise_id: pe.id, dosage_type: "repetition", sets: 3, reps_mode: "exact", reps_exact: 8, load_type: "not_applicable" });

      const pub = await api(ctx1, "POST", `/api/clinician/prescription-drafts/${draftId}/publish`, {});
      check("23. publish succeeds with FastAPI unreachable (200, version 1)", pub.status === 200 && pub.body?.versionNumber === 1, JSON.stringify(pub));
      versionId = pub.body?.versionId;
      const { data: ws } = await admin.from("prescription_workouts").select("id, prescription_exercises(id)").eq("prescription_version_id", versionId);
      workout = { id: ws[0].id, exerciseId: ws[0].prescription_exercises[0].id };
    }

    section("27/28. Patients cannot pause or resume");
    {
      const r1 = await api(ctxP, "POST", `/api/clinician/patients/${patient.userId}/prescription/pause`, {});
      const r2 = await api(ctxP, "POST", `/api/clinician/patients/${patient.userId}/prescription/resume`, {});
      const { data: pp } = await admin.from("patient_prescriptions").select("operational_status").eq("patient_id", patient.userId).single();
      check("27. patient cannot invoke pause (403)", r1.status === 403 && pp.operational_status === "active", JSON.stringify(r1));
      check("28. patient cannot invoke resume (403)", r2.status === 403, JSON.stringify(r2));
    }

    section("24/25/30/31/32-35. Pause / resume controls, started sessions, patient notices");
    {
      const start = await api(ctxP, "POST", "/api/patient/c5/start", {
        clientRequestId: randomUUID(), expectedVersionId: versionId, workoutId: workout.id,
        performance: { exercise_id: workout.exerciseId, unit_index: 0, outcome: "completed", actual_reps: 8 }, preStartSkips: [], sequenceChoice: null,
      });
      const { data: started } = await admin.from("rehab_sessions").select("id, training_status").eq("user_id", patient.userId).not("training_status", "is", null);
      check("patient starts a session before the pause", start.status === 200 && started.length === 1 && started[0].training_status === "started", JSON.stringify(start.body).slice(0, 200));

      const page = await ctx1.newPage();
      await page.goto(`${ON}/clinician/patients/${patient.userId}/prescription`);
      await page.getByTestId("pause-program").click();
      const semantics = await page.getByTestId("pause-semantics").innerText();
      check("30. pause confirmation states the locked semantics",
        semantics.includes("blocks new sessions") && semantics.includes("already started is not ended") && semantics.includes("finish it or stop it") && semantics.includes("No workout is cancelled or rescheduled"), semantics);
      await page.getByTestId("confirm-pause").click();
      await page.waitForURL(/notice=paused/, { timeout: 20000 });
      const ctxt = await page.getByTestId("pause-context").innerText();
      check("24. pause succeeds with FastAPI unreachable; Program shows paused state + context (since … by clinician)",
        (await page.getByTestId("program-pause-control").getAttribute("data-status")) === "paused" && ctxt.includes("Dana Inviter") && ctxt.includes("since"), ctxt);
      const { data: ppP } = await admin.from("patient_prescriptions").select("operational_status, paused_by").eq("patient_id", patient.userId).single();
      check("24. one authoritative pause state (patient_prescriptions + pause period)", ppP.operational_status === "paused" && ppP.paused_by === clin1.userId);

      const st = await api(ctxP, "GET", "/api/patient/c5/state");
      check("30. the Started session is NOT terminated by the pause (still resumable, marked paused)",
        st.body?.state?.kind === "resume" && st.body.state.paused === true, JSON.stringify(st.body?.state).slice(0, 200));
      const fin = await api(ctxP, "POST", `/api/patient/c5/session/${started[0].id}/finish`, {});
      check("30. the patient can still finish the started session", fin.status === 200 && fin.body?.result === "closed", JSON.stringify(fin.body).slice(0, 200));
      const again = await api(ctxP, "POST", "/api/patient/c5/start", {
        clientRequestId: randomUUID(), expectedVersionId: versionId, workoutId: workout.id,
        performance: { exercise_id: workout.exerciseId, unit_index: 0, outcome: "completed", actual_reps: 8 }, preStartSkips: [], sequenceChoice: null,
      });
      const { data: count1 } = await admin.from("rehab_sessions").select("id").eq("user_id", patient.userId).not("training_status", "is", null);
      check("30. pause blocks NEW sessions", count1.length === 1 && again.body?.result !== "started", JSON.stringify(again.body).slice(0, 200));

      const dash = await pageText(ctxP, "/patient/dashboard");
      const types = await dash.page.locator('[data-testid="program-notice"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-type")));
      check("32. patient sees the paused notice (fixed neutral copy)", types.includes("prescription_paused") && dash.body.includes("Your clinician has paused your program"), types.join(","));
      check("34. patient sees the program-published notice", types.includes("prescription_published") && dash.body.includes("Your clinician has shared your program"), types.join(","));
      await dash.page.close();

      await page.getByTestId("resume-program").click();
      const rs = await page.getByTestId("resume-semantics").innerText();
      check("31. resume confirmation: future eligible training available again; does not start a session", rs.includes("future eligible training") && rs.includes("does not start a session"), rs);
      await page.getByTestId("confirm-resume").click();
      await page.waitForURL(/notice=resumed/, { timeout: 20000 });
      check("25. resume succeeds with FastAPI unreachable", (await page.getByTestId("program-pause-control").getAttribute("data-status")) === "active");
      await page.close();
      const { data: count2 } = await admin.from("rehab_sessions").select("id").eq("user_id", patient.userId).not("training_status", "is", null);
      const { data: periods } = await admin.from("prescription_pause_periods").select("paused_by, resumed_by, resumed_at").eq("patient_prescription_id", (await admin.from("patient_prescriptions").select("id").eq("patient_id", patient.userId).single()).data.id);
      check("31. resume does not start a session; pause history kept", count2.length === 1 && periods.length === 1 && periods[0].resumed_by === clin1.userId);

      const dash2 = await pageText(ctxP, "/patient/dashboard");
      const types2 = await dash2.page.locator('[data-testid="program-notice"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-type")));
      check("33. patient sees the resumed notice", types2.includes("prescription_resumed") && dash2.body.includes("Your clinician has resumed your program"), types2.join(","));
      const pausedNotice = dash2.page.locator('[data-testid="program-notice"][data-type="prescription_paused"]');
      await pausedNotice.getByTestId("dismiss-notice").click();
      // M3.3 S2 — wait for the outcome itself, not "networkidle": API
      // responses are now no-store, and the dashboard's fire-and-forget
      // timezone POST never reads its body, which Chromium then reports as
      // still in flight forever (no connection is held; the user-visible
      // update lands in ~1.3s). A timeout falls through to the assertion.
      await pausedNotice.waitFor({ state: "detached", timeout: 20000 }).catch(() => {});
      const { data: n } = await admin.from("notifications").select("type, read_at").eq("patient_id", patient.userId);
      const pausedRow = n.find((x) => x.type === "prescription_paused");
      check("35. dismissing sets read_at (authoritative) and the notice disappears; others stay unread",
        pausedRow?.read_at != null && n.filter((x) => x.type !== "prescription_paused").every((x) => x.read_at == null)
          && (await dash2.page.locator('[data-testid="program-notice"][data-type="prescription_paused"]').count()) === 0, JSON.stringify(n));
      await dash2.page.close();
      const forged = await admin.from("notifications").select("id").eq("patient_id", patient.userId).eq("type", "prescription_resumed").single();
      const ctxE = await login(browser, existing.email);
      const fp = await ctxE.newPage();
      await fp.goto(`${ON}/patient/dashboard`);
      // Submitting another patient's notice id through the dismiss action is scoped to the session patient.
      await fp.evaluate(async ({ id }) => {
        const f = document.querySelector('form:has([name="noticeId"])');
        if (!f) return;
        f.querySelector('[name="noticeId"]').value = id;
        f.requestSubmit();
      }, { id: forged.data.id });
      await fp.waitForTimeout(1500);
      const { data: still } = await admin.from("notifications").select("read_at").eq("id", forged.data.id).single();
      check("35. a patient cannot mark another patient's notice read", still.read_at == null);
      await fp.close();
      await ctxE.close();
    }

    // ------------------------------------------------------------ admin + release
    section("6/7/21/41. Admin adds a second clinician; record preserved");
    const ctxAdmin = await login(browser, orgAdmin.email);
    {
      const page = await ctxAdmin.newPage();
      await page.goto(`${ON}/clinician/dashboard`);
      await page.getByTestId("nav-assignments").click();
      await page.waitForURL(/\/admin\/assignments/);
      await page.getByTestId("patient-search").fill(newEmail);
      await page.getByTestId("patient-search").press("Enter");
      await page.waitForURL(/q=/);
      await page.locator(`[data-testid="patient-option"][data-email="${newEmail}"]`).click();
      await page.waitForURL(/patient=/);
      await page.getByTestId("add-clinician-select").selectOption(clin2.userId);
      await page.getByTestId("add-clinician").click();
      await page.waitForURL(/done=added/);
      const active = await page.locator('[data-testid="active-assignment"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-clinician")));
      check("6/7. admin UI adds clinician 2; clinician 1 remains active", active.includes(clin1.userId) && active.includes(clin2.userId) && active.length === 2, active.join(","));
      await page.close();
      const ctx2 = await login(browser, clin2.email);
      const { status, body } = await pageText(ctx2, `/clinician/patients/${patient.userId}/prescription`);
      check("21/41. clinician 2 sees the existing program (same version, unchanged)", status === 200 && body.includes("Version 1"), `status ${status}`);
      const { data: versions } = await admin.from("prescription_versions").select("id").eq("user_id", patient.userId);
      check("21. adding a clinician created no new prescription", versions.length === 1 && versions[0].id === versionId);
      await ctx2.close();
      const roster1 = await pageText(ctx1, "/clinician/dashboard");
      check("41. clinician 1's roster still lists the patient", roster1.body.includes("Pat Newcomer"));
      await roster1.page.close();
    }

    section("26/29. Professional-review release with FastAPI unreachable (by the added clinician)");
    {
      const sid = randomUUID();
      // Yesterday (patient-local calendar date), 2 h before now's local clock.
      const started = sqlLocalInstant(TZ, -1, { minutesBefore: 120 });
      const due = sqlLocalInstant(TZ, 0, { minutesBefore: 120 });
      sqlExec(`
INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
  prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id)
VALUES ('${sid}', '${patient.userId}', 'c5:${sid}', ${sqlLocalDate(TZ, -1)}, NULL, 'started', ${started},
  c5_build_session_snapshot('${versionId}', '${workout.id}'), '${versionId}', '${workout.id}', '${TZ}', gen_random_uuid());
INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at)
VALUES ('${sid}', '${workout.exerciseId}', 0, 0, 'completed', 8, ${started} + interval '5 minutes');
UPDATE rehab_sessions SET training_status = 'finished', training_closed_at = ${started} + interval '30 minutes' WHERE id = '${sid}';
INSERT INTO session_immediate_responses (rehab_session_id, user_id, peak_session_pain, overall_session_rpe, sudden_or_sharp_pain, pop_felt_or_heard, new_functional_difficulty, resolved_at, created_at)
VALUES ('${sid}', '${patient.userId}', 6, 7, false, true, false, ${started} + interval '40 minutes', ${started} + interval '30 minutes');
INSERT INTO morning_responses (rehab_session_id, user_id, scheduled_eligible_at, reference_local_date, resolution, submitted_at)
VALUES ('${sid}', '${patient.userId}', ${due}, ${sqlLocalDate(TZ, 0)}, 'unable_to_recall', ${due} + interval '1 hour');
INSERT INTO escalation_evaluations (rehab_session_id, escalation_level, escalation_reason, rule_version, inputs_snapshot, evaluated_at)
VALUES ('${sid}', 5, 'pop_felt_or_heard', 'v1', '{"source":"c5_immediate_response"}'::jsonb, now() - interval '20 hours');`);
      const { error: recErr } = await admin.rpc("reconcile_missing_acute_episodes", { p_user_id: patient.userId });
      if (recErr) throw recErr;
      const { data: eps } = await admin.from("acute_safety_episodes").select("id").eq("user_id", patient.userId);
      check("fixture: a Level 5 professional-review hold exists", eps.length === 1);
      const ep = eps[0].id;
      const patientTry = await api(ctxP, "POST", `/api/clinician/patients/${patient.userId}/acute-safety/${ep}/release`, { note: "self" });
      check("29. patient cannot invoke the clinician release (403, nothing written)", patientTry.status === 403, JSON.stringify(patientTry));
      const ctxO = await login(browser, clinOther.email);
      const otherTry = await api(ctxO, "POST", `/api/clinician/patients/${patient.userId}/acute-safety/${ep}/release`, { note: "not mine" });
      check("26. unrelated clinician (legacy-only) release refused", otherTry.status === 404 || otherTry.status === 403, JSON.stringify(otherTry));
      await ctxO.close();
      const ctx2 = await login(browser, clin2.email);
      const { status: ss, body: sb } = await pageText(ctx2, `/clinician/patients/${patient.userId}/safety`);
      check("21. the added clinician sees the existing safety hold", ss === 200 && sb.includes("Clinician release required"), `status ${ss}`);
      const rel = await api(ctx2, "POST", `/api/clinician/patients/${patient.userId}/acute-safety/${ep}/release`, { note: "Reviewed in clinic; cleared to resume." });
      const { data: rels } = await admin.from("acute_safety_releases").select("released_by_clinician_id").eq("acute_safety_episode_id", ep);
      check("26. professional-review release succeeds with FastAPI unreachable (by clinician 2, provenance recorded)",
        rel.status === 200 && rels.length === 1 && rels[0].released_by_clinician_id === clin2.userId, JSON.stringify({ rel, rels }));
      await ctx2.close();
    }

    section("20/40. Admin ends an assignment; access lost immediately; history preserved");
    {
      const page = await ctxAdmin.newPage();
      await page.goto(`${ON}/admin/assignments?org=${REAL_ORG_ID}&patient=${patient.userId}`);
      const card = page.locator(`[data-testid="active-assignment"][data-clinician="${clin1.userId}"]`);
      await card.getByTestId("end-reason").fill("Care moved to Sam Second");
      await card.getByTestId("end-assignment").click();
      await page.waitForURL(/done=ended/);
      const active = await page.locator('[data-testid="active-assignment"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-clinician")));
      const hist = await page.getByTestId("assignment-history").innerText();
      check("20. ended in the admin UI; clinician 2 untouched; history row shows reason", active.length === 1 && active[0] === clin2.userId && hist.includes("Care moved to Sam Second") && hist.includes("Ari Admin"), `${active} | ${hist}`);
      const { status } = await pageText(ctx1, `/clinician/patients/${patient.userId}`);
      const r = await api(ctx1, "POST", `/api/clinician/patients/${patient.userId}/prescription/pause`, {});
      check("20. ended clinician immediately loses access (page 404, pause 403)", status === 404 && r.status === 403, `page ${status} pause ${r.status}`);
      const { data: versions } = await admin.from("prescription_versions").select("id").eq("user_id", patient.userId);
      const { data: pp } = await admin.from("patient_prescriptions").select("operational_status, current_prescription_version_id").eq("patient_id", patient.userId).single();
      check("D3. ending an assignment leaves the program, history and state untouched", versions.length === 1 && pp.current_prescription_version_id === versionId && pp.operational_status === "active");

      await page.getByTestId("add-clinician-select").selectOption(clin1.userId);
      await page.getByTestId("add-clinician").click();
      await page.waitForURL(/done=added/);
      const { data: rows } = await admin.from("supervisor_patients").select("status, dismissed_reason, created_by").eq("patient_id", patient.userId).eq("supervisor_id", clin1.userId).order("assigned_at");
      check("40. re-adding creates a NEW period row; the ended row is preserved",
        rows.length === 2 && rows[0].status === "dismissed" && rows[0].dismissed_reason === "Care moved to Sam Second" && rows[1].status === "active" && rows[1].created_by === orgAdmin.userId, JSON.stringify(rows));
      const { status: s2 } = await pageText(ctx1, `/clinician/patients/${patient.userId}`);
      check("40. re-added clinician regains access", s2 === 200);
      const ctxC = await login(browser, clin2.email);
      const den = await pageText(ctxC, "/admin/assignments");
      check("D4. a regular clinician cannot use assignment management", den.body.includes("Access denied"));
      await den.page.close();
      await ctxC.close();
      await page.close();
    }

    section("8/42. Different organization: no automatic transfer; isolation");
    {
      const ctxB = await login(browser, clinB.email);
      const iB = await inviteViaUi(ctxB, newEmail);
      check("8. another organization's clinician can issue an invitation (no information leak)", iB.result === "created", JSON.stringify(iB));
      const page = await ctxP.newPage();
      await page.goto(onUrl(iB.link));
      await page.getByTestId("accept-invitation").click();
      await page.waitForURL(/error=other_organization/, { timeout: 20000 });
      check("8. accepting refuses with neutral copy; no transfer", (await page.getByTestId("invite-error").innerText()).includes("already linked to a different clinic"));
      await page.close();
      const sp = await activeAssignments(patient.userId);
      const { data: mem } = await admin.from("organization_members").select("organization_id").eq("user_id", patient.userId);
      check("8/42. no cross-organization membership or assignment; existing clinicians intact",
        mem.length === 1 && mem[0].organization_id === REAL_ORG_ID && sp.every((x) => x.organization_id === REAL_ORG_ID) && sp.length === 2, JSON.stringify({ sp, mem }));
      const { status } = await pageText(ctxB, `/clinician/patients/${patient.userId}`);
      check("42. the other organization's clinician has no access (404)", status === 404);
      const adminB = await pageText(ctxB, "/admin/assignments");
      check("42. and no assignment management", adminB.body.includes("Access denied"));
      await adminB.page.close();
      await ctxB.close();
    }

    section("39. Legacy sync writer cannot overwrite native assignment truth");
    {
      const before = await activeAssignments(patient.userId);
      const res = await fetch(`${ON}/api/internal/supervisor-patients-sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.BRIDGE_SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({ supervisor: { email: clin2.email }, patient: { email: patient.email }, status: "dismissed", dismissedReason: "legacy" }),
      });
      const after = await activeAssignments(patient.userId);
      check("39. sync route is retired (410) and writes nothing", res.status === 410 && after.length === before.length && after.some((x) => x.supervisor_id === clin2.userId), `status ${res.status}`);
    }

    section("36/37. Redirect safety and /register");
    {
      const bad = ["//evil.example", "/\\evil.example", "https://evil.example/x", "/%2F%2Fevil.example", "/%5Cevil.example", "javascript:alert(1)", "/\t/evil.example", " //evil.example"];
      for (const next of bad) {
        const c2 = await newCtx(browser);
        const pg = await c2.newPage();
        await pg.goto(`${ON}/login?next=${encodeURIComponent(next)}`);
        await pg.fill("#email", existing.email);
        await pg.fill("#password", PASSWORD);
        await pg.click('button[type="submit"]');
        await pg.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }).catch(() => {});
        const u = new URL(pg.url());
        check(`36. login next=${JSON.stringify(next)} stays on our origin`, u.origin === new URL(ON).origin && !u.pathname.startsWith("/login"), pg.url());
        await c2.close();
      }
      const cb = await fetch(`${ON}/auth/callback?next=${encodeURIComponent("//evil.example")}&error=x`, { redirect: "manual" });
      check("36. auth callback never redirects off-origin", new URL(cb.headers.get("location") ?? "/", ON).origin === new URL(ON).origin, cb.headers.get("location"));
      const reg = await fetch(`${ON}/register`, { redirect: "manual" });
      const loc = reg.headers.get("location") ?? "";
      check("37. /register is not an onboarding route (redirects to login)", [302, 303, 307, 308].includes(reg.status) && loc.includes("/login") && loc.includes("invitation_required"), `${reg.status} ${loc}`);
      const ctx = await newCtx(browser);
      const pg = await ctx.newPage();
      await pg.goto(`${ON}/register`);
      const body = await pg.locator("body").innerText();
      check("37. neutral invitation-required copy; no sign-up form or link", body.includes("requires an invitation") && (await pg.locator('a[href="/register"]').count()) === 0 && (await pg.locator("#name").count()) === 0);
      await ctx.close();
    }

    await ctxAdmin.close();
    await ctxP.close();
    await ctx1.close();
  } finally {
    await browser.close();
  }
}

// `--cleanup`: remove fixtures left by an interrupted earlier run (users
// m2-*@example.invalid, orgs m2-other-*, legacy rows m2-legacy-*).
async function discoverLeftovers() {
  for (let page = 1; page <= 20; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    for (const u of data?.users ?? []) if (/^m2-.*@example\.invalid$/.test(u.email ?? "")) createdUsers.push(u.id);
    if (!data?.users?.length || data.users.length < 1000) break;
  }
  const { data: orgs } = await admin.from("organizations").select("id").like("slug", "m2-other-%");
  for (const o of orgs ?? []) createdOrgs.push(o.id);
  legacy((db) => {
    for (const r of db.prepare("SELECT id FROM users WHERE name LIKE 'm2-legacy-%'").all()) {
      legacyUserIds.push(r.id);
      for (const l of db.prepare("SELECT id FROM supervisor_patients WHERE supervisor_id = ? OR patient_id = ?").all(r.id, r.id)) legacyLinkIds.push(l.id);
    }
  });
  await admin.from("invitations").delete().like("email", "m2-%@example.invalid");
  const { data: ex } = await admin.from("canonical_exercises").select("id").like("name", "M2 Heel raise %");
  for (const e of ex ?? []) exerciseIds.push(e.id);
}

if (process.argv.includes("--cleanup")) {
  await discoverLeftovers();
  console.log(`cleanup: ${createdUsers.length} users, ${createdOrgs.length} orgs, ${legacyUserIds.length} legacy users`);
  await teardown();
  process.exit(0);
}

try {
  await main();
} catch (err) {
  fail++;
  console.error("ERROR", err);
} finally {
  try {
    await teardown();
  } catch (e) {
    fail++;
    console.log(`FAIL  teardown: ${e.message}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
