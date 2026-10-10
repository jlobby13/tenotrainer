// C5.4 Closeout — focused verification for the two technical fixes made at
// C5.4 closeout:
//   1. the builder's server/client markup matches (no hydration mismatch
//      from the dnd-kit drag handles), and
//   2. keyboard reordering works whether the dragged row's dosage editor is
//      collapsed or expanded (tall), without saving or discarding unsaved
//      dosage working state — alongside pointer and touch reordering.
// Throwaway fixture users; real canonical exercises (read-only).
//
// Requires: `next dev` (or `next start`) on BASE_URL (default
// localhost:3000), web/.env.local populated, Playwright Chromium installed.
//
// Run from the web/ directory:
//   node scripts/verifyC5Stage4Closeout.mjs [baseUrl]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";

const BASE_URL = process.argv[2] ?? "http://localhost:3000";
const LEGACY_DB_PATH = "../app/tenotrainer.db";
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
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
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

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
async function makeUser(label) {
  const email = `c5closev-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  await admin.from("profiles").upsert({ id: data.user.id, name: label });
  return { userId: data.user.id, email };
}
async function waitForCondition(fn, timeoutMs = 8000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

const rows = (page) => page.locator('[data-testid="draft-exercise-row"]');
const draftRow = (page, name) => rows(page).filter({ has: page.locator('[data-testid="draft-exercise-name"]', { hasText: name }) });
const setsField = (page, name) => draftRow(page, name).locator('[data-testid="dosage-field-sets"]');
async function uiOrder(page) {
  return (await page.locator('[data-testid="draft-exercise-row"] [data-testid="draft-exercise-name"]').allInnerTexts()).map((t) => t.trim());
}
async function dbOrder(workoutId, nameById) {
  const { data } = await admin.from("prescription_exercises").select("canonical_exercise_id, order_index").eq("prescription_workout_id", workoutId).order("order_index");
  return (data ?? []).map((r) => nameById.get(r.canonical_exercise_id));
}
async function dbSets(workoutId, canonicalId) {
  const { data } = await admin
    .from("prescription_exercises")
    .select("prescription_exercise_dosage(sets)")
    .eq("prescription_workout_id", workoutId)
    .eq("canonical_exercise_id", canonicalId)
    .single();
  const d = Array.isArray(data.prescription_exercise_dosage) ? data.prescription_exercise_dosage[0] : data.prescription_exercise_dosage;
  return d?.sets ?? null;
}
// A reorder persists through withBusy + a draft refresh, during which the
// handles are not rendered. Settled = every row has its handle back and the
// network is quiet.
async function waitForSettled(page) {
  await waitForCondition(async () => (await page.locator('[data-testid="drag-handle"]').count()) === (await rows(page).count()), 15000);
  await page.waitForLoadState("networkidle");
}
async function keyboardMove(page, name, key, times = 1, drop = "Space") {
  const handle = draftRow(page, name).locator('[data-testid="drag-handle"]');
  await handle.focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(80);
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(120);
  }
  await page.keyboard.press(drop);
  await page.waitForTimeout(150);
  await waitForSettled(page);
}
function moved(order, name, steps) {
  const next = order.slice();
  const from = next.indexOf(name);
  next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, from + steps)), 0, name);
  return next;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isHydrationMessage = (text) => /hydrat|did not match|server rendered|didn't match|text content does not match/i.test(text);

async function main() {
  const { data: exercises } = await admin.from("canonical_exercises").select("id, legacy_ex_id, name").eq("visibility", "global").order("legacy_ex_id");
  const byLegacy = new Map(exercises.map((e) => [e.legacy_ex_id, e]));
  const SEED = ["ex_001", "ex_005", "ex_008", "ex_002"].map((l) => byLegacy.get(l));
  const nameById = new Map(SEED.map((e) => [e.id, e.name]));
  const [E1, E2, E3, E4] = SEED.map((e) => e.name);

  const owner = await makeUser("owner");
  const other = await makeUser("other");
  const patient = await makeUser("patient");
  let legacy = {};
  let patientPrescriptionId;
  const legacyDb = new DatabaseSync(LEGACY_DB_PATH);
  try {
    const ins = legacyDb.prepare("INSERT INTO users (name, email, role, supabase_id) VALUES (?, ?, ?, ?)");
    legacy.owner = ins.run("c5closev-owner", owner.email, "supervisor", owner.userId).lastInsertRowid;
    legacy.other = ins.run("c5closev-other", other.email, "supervisor", other.userId).lastInsertRowid;
    legacy.patient = ins.run("c5closev-patient", patient.email, "patient", patient.userId).lastInsertRowid;
    const sp = legacyDb.prepare("INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (?, ?, 'active')");
    sp.run(legacy.owner, legacy.patient);
    sp.run(legacy.other, legacy.patient);
  } finally {
    legacyDb.close();
  }

  try {
    for (const [u, role] of [[owner, "clinician"], [other, "clinician"], [patient, "member"]]) {
      await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: u.userId, role });
    }
    for (const u of [owner, other]) await admin.from("supervisor_patients").insert({ supervisor_id: u.userId, patient_id: patient.userId, status: "active" });
    const { data: pp } = await admin.from("patient_prescriptions").insert({ patient_id: patient.userId }).select("id").single();
    patientPrescriptionId = pp.id;
    const { data: draft } = await admin
      .from("prescription_drafts")
      .insert({ patient_prescription_id: pp.id, status: "editing", source: "empty", created_by: owner.userId, editing_clinician_id: owner.userId, updated_by: owner.userId })
      .select("id")
      .single();
    const { data: wA } = await admin.from("prescription_workouts").insert({ prescription_draft_id: draft.id, label: "Workout A", order_index: 0 }).select("id").single();
    for (const [i, ex] of SEED.entries()) {
      const { data: pe } = await admin.from("prescription_exercises").insert({ prescription_workout_id: wA.id, canonical_exercise_id: ex.id, order_index: i }).select("id").single();
      await admin.from("prescription_exercise_dosage").insert({ prescription_exercise_id: pe.id, dosage_type: "repetition", sets: 3, reps_mode: "exact", reps_exact: 10 });
    }
    const builderUrl = `${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`;

    const browser = await chromium.launch();
    try {
      const login = async (u, opts) => {
        const ctx = await browser.newContext(opts);
        const p = await ctx.newPage();
        await p.goto(`${BASE_URL}/login`);
        await p.fill("#email", u.email);
        await p.fill("#password", PASSWORD);
        await p.click('button[type="submit"]');
        await p.waitForLoadState("networkidle");
        await p.close();
        return ctx;
      };
      // Console/page errors are collected only on the BUILDER page (login and
      // dashboard setup run on a separate page and are out of scope).
      const watch = (page) => {
        const log = { hydration: [], errors: [] };
        page.on("console", (m) => {
          if (m.type() !== "error" && m.type() !== "warning") return;
          const text = m.text();
          if (isHydrationMessage(text)) log.hydration.push(text.slice(0, 400));
          if (m.type() === "error") log.errors.push(text.slice(0, 400));
        });
        page.on("pageerror", (e) => log.errors.push(`pageerror: ${e.message.slice(0, 400)}`));
        return log;
      };
      const openBuilder = async (page) => {
        await page.goto(builderUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
        await page.waitForSelector('[data-testid="draft-exercise-row"]', { state: "attached", timeout: 120000 });
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(300);
        // Mobile shows Library first; the draft lives behind its own tab.
        const draftTab = page.getByRole("button", { name: /^Draft \(/ });
        if (await draftTab.isVisible()) await draftTab.click();
      };

      // ===================== HYDRATION =====================
      const ctx = await login(owner, { viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      const log = watch(page);
      await openBuilder(page);
      check("desktop builder load: no hydration mismatch reported", log.hydration.length === 0, log.hydration.join("\n      "));
      check("desktop builder load: no console/page errors", log.errors.length === 0, log.errors.join("\n      "));
      // dnd-kit's accessibility wiring must line up after hydration: each
      // handle's aria-describedby must name the live instructions node.
      const describedBy = await page.locator('[data-testid="drag-handle"]').first().getAttribute("aria-describedby");
      const describedText = describedBy ? await page.evaluate((id) => document.getElementById(id)?.textContent ?? null, describedBy) : null;
      check("drag handle's aria-describedby resolves to the keyboard instructions", !!describedText && /space|enter/i.test(describedText), `describedby=${describedBy} text=${describedText}`);
      check("drag handle exposes a sortable role description and a label", (await page.locator('[data-testid="drag-handle"]').first().getAttribute("aria-roledescription")) === "sortable" && (await page.locator('[data-testid="drag-handle"]').first().getAttribute("aria-label")) === "Drag to reorder exercise");
      const handleIdsUnique = await page.evaluate(() => {
        const ids = [...document.querySelectorAll('[data-testid="drag-handle"]')].map((b) => b.getAttribute("aria-describedby"));
        return ids.length > 0 && ids.every((id) => id && document.getElementById(id));
      });
      check("every drag handle's describedby target exists in the DOM", handleIdsUnique);

      let order = await uiOrder(page);
      check("fixture order is the seeded order", eq(order, [E1, E2, E3, E4]), order.join(" | "));

      // ===================== KEYBOARD — collapsed row =====================
      await keyboardMove(page, E1, "ArrowDown");
      let expected = moved([E1, E2, E3, E4], E1, 1);
      order = await uiOrder(page);
      check("keyboard: collapsed row moves down one position", eq(order, expected), order.join(" | "));
      check("keyboard: collapsed reorder persisted", eq(await dbOrder(wA.id, nameById), expected));

      // ===================== KEYBOARD — expanded CLEAN editor =====================
      await draftRow(page, E3).locator('[data-testid="edit-dosage"]').click();
      await draftRow(page, E3).locator('[data-testid="dosage-editor"]').waitFor();
      const tallH = (await draftRow(page, E3).boundingBox()).height;
      const shortH = (await draftRow(page, E2).boundingBox()).height;
      check(`expanded editor row is much taller than a collapsed row (${Math.round(tallH)}px vs ${Math.round(shortH)}px)`, tallH > shortH * 2);
      await keyboardMove(page, E3, "ArrowUp");
      expected = moved(expected, E3, -1);
      order = await uiOrder(page);
      check("keyboard: expanded CLEAN editor row moves up one position", eq(order, expected), order.join(" | "));
      check("keyboard: expanded clean reorder persisted", eq(await dbOrder(wA.id, nameById), expected));
      check("expanded editor stays open after keyboard reorder", await draftRow(page, E3).locator('[data-testid="dosage-editor"]').isVisible());
      await keyboardMove(page, E3, "ArrowDown", 2);
      expected = moved(expected, E3, 2);
      order = await uiOrder(page);
      check("keyboard: expanded row moves down two positions in one pickup", eq(order, expected), order.join(" | "));
      check("keyboard: two-step reorder persisted", eq(await dbOrder(wA.id, nameById), expected));

      // ===================== KEYBOARD — expanded DIRTY editor =====================
      await setsField(page, E3).fill("7");
      check("dirty editor shows the unsaved marker", (await draftRow(page, E3).locator('[data-testid="unsaved-indicator"]').count()) === 1);
      await keyboardMove(page, E3, "ArrowUp", 3);
      expected = moved(expected, E3, -3);
      order = await uiOrder(page);
      check("keyboard: expanded DIRTY editor row moves up to the top", eq(order, expected), order.join(" | "));
      check("keyboard: dirty reorder persisted", eq(await dbOrder(wA.id, nameById), expected));
      check("dirty value survives the reorder (sets still 7 in the editor)", (await setsField(page, E3).inputValue()) === "7");
      check("dirty marker survives the reorder", (await draftRow(page, E3).locator('[data-testid="unsaved-indicator"]').count()) === 1);
      check("reorder did not force-save the dirty dosage (DB still 3)", (await dbSets(wA.id, SEED[2].id)) === 3);

      // Escape cancels a keyboard drag without changing anything.
      const beforeEscape = await uiOrder(page);
      await keyboardMove(page, E3, "ArrowDown", 1, "Escape");
      check("keyboard: Escape cancels the pickup with no reorder", eq(await uiOrder(page), beforeEscape));
      check("keyboard: Escape left the persisted order untouched", eq(await dbOrder(wA.id, nameById), beforeEscape));

      // ===================== MULTIPLE expanded editors =====================
      await draftRow(page, E1).locator('[data-testid="edit-dosage"]').click();
      await draftRow(page, E1).locator('[data-testid="dosage-editor"]').waitFor();
      await setsField(page, E1).fill("5");
      const e1Index = (await uiOrder(page)).indexOf(E1);
      await keyboardMove(page, E1, "ArrowUp", e1Index);
      expected = moved(beforeEscape, E1, -e1Index);
      order = await uiOrder(page);
      check("keyboard: with two expanded dirty editors, the second moves to the top", eq(order, expected), `before=${beforeEscape.join(" | ")} steps=${e1Index}\n      got=${order.join(" | ")}`);
      check("keyboard: multi-editor reorder persisted", eq(await dbOrder(wA.id, nameById), expected));
      check("both editors remain expanded", (await page.locator('[data-testid="dosage-editor"]').count()) === 2);
      check("the moved row keeps its unsaved value (5)", (await setsField(page, E1).inputValue()) === "5");
      check("the OTHER exercise keeps its unsaved value (7)", (await setsField(page, E3).inputValue()) === "7");

      // ===================== reorder → Save Dosage / Cancel =====================
      await draftRow(page, E3).locator('[data-testid="save-dosage"]').click();
      await waitForCondition(async () => (await draftRow(page, E3).locator('[data-testid="dosage-editor"]').count()) === 0, 10000);
      check("Save Dosage after reorder persists the edited value (7)", (await dbSets(wA.id, SEED[2].id)) === 7);
      check("Save Dosage after reorder keeps the reordered position", eq(await dbOrder(wA.id, nameById), expected));
      check("saving one exercise leaves the other's unsaved value (5)", (await setsField(page, E1).inputValue()) === "5");
      await draftRow(page, E1).locator('[data-testid="cancel-dosage"]').click();
      await waitForCondition(async () => (await draftRow(page, E1).locator('[data-testid="dosage-editor"]').count()) === 0, 5000);
      check("Cancel after reorder discards only that exercise's unsaved edit (DB still 3)", (await dbSets(wA.id, SEED[0].id)) === 3);
      await draftRow(page, E1).locator('[data-testid="edit-dosage"]').click();
      check("re-opening after Cancel shows the saved value (3)", (await setsField(page, E1).inputValue()) === "3");
      await draftRow(page, E1).locator('[data-testid="cancel-dosage"]').click();

      // ===================== POINTER — expanded dirty editor =====================
      await draftRow(page, E2).locator('[data-testid="edit-dosage"]').click();
      await draftRow(page, E2).locator('[data-testid="dosage-editor"]').waitFor();
      await setsField(page, E2).fill("9");
      const beforePointer = await uiOrder(page);
      const lastName = beforePointer[beforePointer.length - 1];
      const from = await draftRow(page, E2).locator('[data-testid="drag-handle"]').boundingBox();
      const to = await draftRow(page, lastName).boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + 20);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2, from.y + 40, { steps: 5 });
      await page.mouse.move(to.x + to.width / 2, to.y + to.height - 5, { steps: 20 });
      await page.waitForTimeout(100);
      await page.mouse.up();
      await page.waitForTimeout(150);
      await waitForSettled(page);
      expected = moved(beforePointer, E2, beforePointer.length - 1 - beforePointer.indexOf(E2));
      order = await uiOrder(page);
      check("pointer: expanded dirty row drags to the end", eq(order, expected), order.join(" | "));
      check("pointer: reorder persisted", eq(await dbOrder(wA.id, nameById), expected));
      check("pointer: unsaved value survives (9)", (await setsField(page, E2).inputValue()) === "9");
      check("pointer: no force-save (DB still 3)", (await dbSets(wA.id, SEED[1].id)) === 3);
      check("no hydration/console errors during all reorders", log.hydration.length === 0 && log.errors.length === 0, [...log.hydration, ...log.errors].join("\n      "));
      await page.close();
      await ctx.close();

      // ===================== MOBILE — hydration + touch =====================
      const mctx = await login(owner, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      const mpage = await mctx.newPage();
      const mlog = watch(mpage);
      await openBuilder(mpage);
      check("mobile builder load: no hydration mismatch reported", mlog.hydration.length === 0, mlog.hydration.join("\n      "));
      check("mobile builder load: no console/page errors", mlog.errors.length === 0, mlog.errors.join("\n      "));
      const beforeTouch = await uiOrder(mpage);
      const top = beforeTouch[0];
      const cdp = await mctx.newCDPSession(mpage);
      await draftRow(mpage, top).locator('[data-testid="drag-handle"]').scrollIntoViewIfNeeded();
      const th = await draftRow(mpage, top).locator('[data-testid="drag-handle"]').boundingBox();
      const topRow = await draftRow(mpage, top).boundingBox();
      const nextRow = await draftRow(mpage, beforeTouch[1]).boundingBox();
      const x = th.x + th.width / 2;
      const startY = th.y + 15;
      const touch = (type, tx, ty) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: tx, y: ty }] });
      await touch("touchStart", x, startY);
      await mpage.waitForTimeout(350); // TouchSensor: hold still past the 200ms delay
      // Move the finger exactly one row-pitch down: the dragged row then sits
      // centered on the next row's slot.
      const endY = startY + (nextRow.y + nextRow.height / 2) - (topRow.y + topRow.height / 2);
      for (let i = 1; i <= 12; i++) {
        await touch("touchMove", x, startY + ((endY - startY) * i) / 12);
        await mpage.waitForTimeout(25);
      }
      await mpage.waitForTimeout(100);
      await touch("touchEnd");
      await mpage.waitForTimeout(150);
      await waitForSettled(mpage);
      expected = moved(beforeTouch, top, 1);
      order = await uiOrder(mpage);
      check("touch: long-press drag on the handle moves the top row down one", eq(order, expected), `before=${beforeTouch.join(" | ")}\n      got=${order.join(" | ")}`);
      check("touch: reorder persisted", eq(await dbOrder(wA.id, nameById), expected));
      // A swipe on the row BODY (not the handle) is a scroll, never a reorder.
      const beforeSwipe = await uiOrder(mpage);
      const nameBox = await draftRow(mpage, beforeSwipe[0]).locator('[data-testid="draft-exercise-name"]').boundingBox();
      await touch("touchStart", nameBox.x + 10, nameBox.y + 5);
      for (let i = 1; i <= 6; i++) await touch("touchMove", nameBox.x + 10, nameBox.y + 5 + i * 30);
      await touch("touchEnd");
      await mpage.waitForTimeout(600);
      check("touch: a swipe on the row body does not reorder", eq(await uiOrder(mpage), beforeSwipe));
      // Mobile keyboard pickup with an expanded editor still works.
      const beforeMobileKb = await uiOrder(mpage);
      const mFirst = beforeMobileKb[0];
      await draftRow(mpage, mFirst).locator('[data-testid="edit-dosage"]').click();
      await draftRow(mpage, mFirst).locator('[data-testid="dosage-editor"]').waitFor();
      await keyboardMove(mpage, mFirst, "ArrowDown");
      order = await uiOrder(mpage);
      check("mobile: keyboard reorder of an expanded editor row works", eq(order, moved(beforeMobileKb, mFirst, 1)), `before=${beforeMobileKb.join(" | ")}\n      got=${order.join(" | ")}`);
      check("mobile: no hydration/console errors during reorders", mlog.hydration.length === 0 && mlog.errors.length === 0, [...mlog.hydration, ...mlog.errors].join("\n      "));
      await mpage.close();
      await mctx.close();

      // ===================== VIEW-ONLY =====================
      const octx = await login(other, { viewport: { width: 1440, height: 900 } });
      const op = await octx.newPage();
      const olog = watch(op);
      await openBuilder(op);
      check("view-only: rows render", (await rows(op).count()) === 4);
      check("view-only: no drag handles at all", (await op.locator('[data-testid="drag-handle"]').count()) === 0);
      check("view-only: no hydration mismatch", olog.hydration.length === 0, olog.hydration.join("\n      "));
      await op.close();
      await octx.close();
    } finally {
      await browser.close();
    }
  } finally {
    if (patientPrescriptionId) await admin.from("patient_prescriptions").delete().eq("id", patientPrescriptionId);
    await admin.from("supervisor_patients").delete().eq("patient_id", patient.userId);
    const ids = [owner.userId, other.userId, patient.userId];
    await admin.from("organization_members").delete().in("user_id", ids);
    await admin.from("profiles").delete().in("id", ids);
    for (const id of ids) await admin.auth.admin.deleteUser(id);
    const d = new DatabaseSync(LEGACY_DB_PATH);
    try {
      d.exec(`DELETE FROM supervisor_patients WHERE supervisor_id IN (${legacy.owner}, ${legacy.other})`);
      d.exec(`DELETE FROM users WHERE id IN (${legacy.owner}, ${legacy.other}, ${legacy.patient})`);
    } finally {
      d.close();
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
