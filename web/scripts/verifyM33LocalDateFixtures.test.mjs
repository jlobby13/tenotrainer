// M3.3 S2 — proof for the patient-local fixture date helpers
// (scripts/lib/patientLocalDate.mjs) at synthetic clock positions.
//
// The JS helpers are checked directly. The SQL helpers are the exact
// expressions the fixtures send, evaluated by Postgres with a synthetic
// "now" (read-only SELECT; nothing is written). Each case asserts that the
// intended session lands on exactly the previous patient-local calendar
// date, and that follow-up instants stay on their date and never after now.
// It also shows the replaced elapsed-time pattern failing at the same clocks.
//
// Run from web/:  TENOTRAINER_MODE=development node scripts/verifyM33LocalDateFixtures.test.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { addLocalDays, localDateOffset, localDowOffset, localToday, sqlLocalDate, sqlLocalInstant } from "./lib/patientLocalDate.mjs";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

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

// The fixtures' zone, the two extreme fixed offsets C5.6F may pick, and a
// southern-hemisphere DST zone.
const ZONES = ["America/New_York", "Etc/GMT+12", "Etc/GMT-14", "Australia/Sydney"];
// An ordinary week, both 2026 US transitions (and the day after each), and
// both 2026 Sydney transitions (and the day after each).
const DATES = ["2026-10-28", "2026-11-01", "2026-11-02", "2026-03-08", "2026-03-09", "2026-04-05", "2026-04-06", "2026-10-04", "2026-10-05"];
// Required positions plus the first minutes after midnight.
const TIMES = ["00:00:30", "00:05", "00:30", "01:30", "02:30", "12:00", "23:30"];

// ------------------------------------------------------------------ JS-only
check("addLocalDays: calendar arithmetic across month / year / leap day",
  addLocalDays("2026-03-01", -1) === "2026-02-28" && addLocalDays("2028-03-01", -1) === "2028-02-29" && addLocalDays("2027-01-01", -1) === "2026-12-31" && addLocalDays("2026-10-31", 2) === "2026-11-02");
{
  // The observed failure: 00:20 EDT on 2026-10-31 (the night before the
  // fall-back). Elapsed +48 h is 23:20 EST on 11-01; two calendar days is 11-02.
  const at = new Date("2026-10-31T04:20:00Z");
  const old = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(at.getTime() + 2 * 86400000));
  check("replaced JS helper reproduces the observed C5.6F failure (+48 h lands on 11-01)", old === "2026-11-01", old);
  check("localDateOffset: +2 calendar days is 11-02 at the same instant", localDateOffset("America/New_York", 2, at) === "2026-11-02");
  check("localDateOffset: -1 is 10-30, weekday Friday", localDateOffset("America/New_York", -1, at) === "2026-10-30" && localDowOffset("America/New_York", -1, at) === 5);
}

// ------------------------------------------------------------------ SQL
const cases = [];
for (const tz of ZONES) for (const date of DATES) for (const time of TIMES) cases.push({ tz, date, time });
const select = cases.map(({ tz, date, time }, i) => {
  const N = `(timestamp '${date} ${time}' AT TIME ZONE '${tz}')`;
  const o = { nowSql: N };
  const localOf = (x) => `((${x}) AT TIME ZONE '${tz}')::date::text`;
  return `SELECT ${i} AS i,
  (extract(epoch FROM ${N}) * 1000)::bigint::text AS epoch_ms,
  (${N} AT TIME ZONE '${tz}')::text AS local_now,
  ((${N} AT TIME ZONE '${tz}')::date - 1)::text AS expect_yesterday,
  ((${N} AT TIME ZONE '${tz}')::date)::text AS expect_today,
  ((${N} AT TIME ZONE '${tz}')::date - 6)::text AS expect_6_ago,
  (${sqlLocalDate(tz, -1, o)})::text AS d_yesterday,
  ${localOf(sqlLocalInstant(tz, -1, o))} AS i_yesterday,
  ${localOf(sqlLocalInstant(tz, -1, { ...o, minutesBefore: 120 }))} AS i_yesterday_2h,
  ${localOf(sqlLocalInstant(tz, -6, { ...o, minutesBefore: 120 }))} AS i_6_ago_2h,
  ${localOf(sqlLocalInstant(tz, 0, { ...o, minutesBefore: 120 }))} AS due_today_2h,
  (${sqlLocalInstant(tz, 0, { ...o, minutesBefore: 120 })} <= ${N}) AS due_today_2h_past,
  ${localOf(sqlLocalInstant(tz, 0, { ...o, minutesBefore: 60 }))} AS today_1h,
  (${sqlLocalInstant(tz, 0, { ...o, minutesBefore: 60 })} <= ${N}) AS today_1h_past,
  ${localOf(sqlLocalInstant(tz, 0, { ...o, minutesBefore: 10 }))} AS today_10m,
  (${sqlLocalInstant(tz, 0, { ...o, minutesBefore: 10 })} <= ${N}) AS today_10m_past,
  ${localOf(sqlLocalInstant(tz, -1, { ...o, minutesBefore: 120 }) + " + interval '30 minutes'")} AS closed_yesterday_2h,
  ${localOf(`${N} - interval '1 day' - interval '2 hours'`)} AS old_minus_26h,
  ${localOf(`${N} - interval '1 day'`)} AS old_minus_24h`;
}).join("\nUNION ALL\n");

const work = mkdtempSync(join(tmpdir(), "m33-localdate-"));
let rows = [];
try {
  const path = join(work, "q.sql");
  writeFileSync(path, `${select}\nORDER BY i;`);
  const out = execFileSync("supabase", ["db", "query", "--linked", "--file", path], { cwd: "..", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  rows = JSON.parse(out.slice(out.indexOf("{"))).rows;
} finally {
  rmSync(work, { recursive: true, force: true });
}
check(`Postgres evaluated every synthetic clock case (${cases.length})`, rows.length === cases.length, `${rows.length}`);

const bad = (pred) => rows.filter((r) => !pred(r)).map((r) => `${cases[r.i].tz} ${r.local_now}`);
const label = "every zone × ordinary / DST dates × 00:00:30, 00:05, 00:30, 01:30, 02:30, 12:00, 23:30";
let b;
b = bad((r) => r.d_yesterday === r.expect_yesterday);
check(`SQL session date is exactly the previous patient-local date (${label})`, b.length === 0, b.slice(0, 5).join(", "));
b = bad((r) => r.i_yesterday === r.expect_yesterday && r.i_yesterday_2h === r.expect_yesterday);
check("SQL session instant (now's clock, and 2 h before it) lies on the previous patient-local date", b.length === 0, b.slice(0, 5).join(", "));
b = bad((r) => r.i_6_ago_2h === r.expect_6_ago);
check("SQL instant 6 days ago lies on exactly the 6th previous patient-local date", b.length === 0, b.slice(0, 5).join(", "));
b = bad((r) => r.due_today_2h === r.expect_today && r.due_today_2h_past && r.today_1h === r.expect_today && r.today_1h_past && r.today_10m === r.expect_today && r.today_10m_past);
check("SQL follow-up instants for today (2 h / 1 h / 10 min before now) stay on today and never after now", b.length === 0, b.slice(0, 5).join(", "));
const ny = (time) => rows.filter((r) => cases[r.i].tz === "America/New_York" && cases[r.i].time === time && cases[r.i].date === "2026-10-28");
check("replaced 'now - 1 day - 2 hours' lands TWO local dates back at 00:30 and 01:30 (the observed defect)",
  ["00:30", "01:30"].every((t) => ny(t)[0]?.old_minus_26h === "2026-10-26") && ny("02:30")[0]?.old_minus_26h === "2026-10-27");
const dst = rows.find((r) => cases[r.i].tz === "America/New_York" && cases[r.i].date === "2026-03-09" && cases[r.i].time === "00:30");
check("replaced 'now - 1 day' lands two local dates back at 00:30 after the spring-forward; the helper does not",
  dst?.old_minus_24h === "2026-03-07" && dst?.i_yesterday === "2026-03-08", JSON.stringify(dst && { old: dst.old_minus_24h, now: dst.i_yesterday }));

// JS helpers at the same instants agree with Postgres's patient-local dates.
b = rows.filter((r) => {
  const at = new Date(Number(r.epoch_ms));
  const { tz } = cases[r.i];
  return !(localToday(tz, at) === r.expect_today && localDateOffset(tz, -1, at) === r.expect_yesterday && localDateOffset(tz, -6, at) === r.expect_6_ago);
}).map((r) => `${cases[r.i].tz} ${r.local_now}`);
check("JS localDateOffset agrees with Postgres at every synthetic instant (today, -1, -6)", b.length === 0, b.slice(0, 5).join(", "));

const pos = ["00:30", "01:30", "02:30", "12:00", "23:30"].map((t) => {
  const r = rows.find((x) => cases[x.i].tz === "America/New_York" && cases[x.i].date === "2026-11-02" && cases[x.i].time === t);
  return `${t}->${r?.i_yesterday_2h}`;
});
console.log(`      America/New_York on 2026-11-02 (day after fall-back), intended yesterday 2026-11-01: ${pos.join(" ")}`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
