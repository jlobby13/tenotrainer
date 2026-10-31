// M3.3 S2 — patient-local calendar dates for test fixtures.
//
// A fixture that means "N days ago in the patient's time zone" must do
// calendar arithmetic on the patient-local date, never subtract elapsed
// time from now. `now() - interval '1 day' - interval '2 hours'` is two
// local dates ago between 00:00 and 02:00, and a 24 h step lands on the
// wrong date across a daylight-saving change; the C5 runtime (correctly)
// reads patient-local dates, so such a fixture silently describes a
// different history. Everything here is calendar arithmetic only.

// ---------------------------------------------------------------- JS side

// Patient-local date (YYYY-MM-DD) at `at`.
export function localToday(tz, at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);
}

// Calendar arithmetic on a YYYY-MM-DD date (no time zone involved).
export function addLocalDays(isoDate, days) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// The patient-local date `offsetDays` calendar days from today.
export function localDateOffset(tz, offsetDays = 0, at = new Date()) {
  return addLocalDays(localToday(tz, at), offsetDays);
}

// Day of week (0 = Sunday) of the patient-local date `offsetDays` from today.
export function localDowOffset(tz, offsetDays = 0, at = new Date()) {
  const [y, m, d] = localDateOffset(tz, offsetDays, at).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// --------------------------------------------------------------- SQL side

const zone = (tz) => {
  if (!/^[A-Za-z0-9_+\-/]+$/.test(tz)) throw new Error(`unexpected time zone name: ${tz}`);
  return `'${tz}'`;
};
const minutes = (n) => {
  if (!Number.isInteger(n) || n < 0) throw new Error(`minutesBefore must be a non-negative integer: ${n}`);
  return n;
};

// The patient-local date `offsetDays` calendar days from the DB clock's
// local today. `nowSql` exists for the synthetic-clock proof only.
export function sqlLocalDate(tz, offsetDays = 0, { nowSql = "now()" } = {}) {
  if (!Number.isInteger(offsetDays)) throw new Error(`offsetDays must be an integer: ${offsetDays}`);
  return `((((${nowSql}) AT TIME ZONE ${zone(tz)})::date + (${offsetDays}))::date)`;
}

// The patient-local clock time used for a fixture instant: the current
// local time `minutesBefore` minutes earlier, but never wrapping to the
// previous evening — before that many minutes past midnight it is half the
// time elapsed since midnight. So on the intended date, and for
// offsetDays = 0 (or a +1 day follow-up of yesterday) never after now.
export function sqlLocalClock(tz, { minutesBefore = 0, nowSql = "now()" } = {}) {
  const t = `((${nowSql}) AT TIME ZONE ${zone(tz)})::time`;
  const b = `interval '${minutes(minutesBefore)} minutes'`;
  return `(CASE WHEN ${t} >= time '00:00' + ${b} THEN ${t} - ${b} ELSE time '00:00' + (${t} - time '00:00') / 2 END)`;
}

// An instant whose patient-local date is exactly `offsetDays` calendar days
// from local today, at sqlLocalClock's time of day (DST-safe: the local
// date + time is converted by the zone's rules for that date).
export function sqlLocalInstant(tz, offsetDays = 0, { minutesBefore = 0, nowSql = "now()" } = {}) {
  return `((${sqlLocalDate(tz, offsetDays, { nowSql })} + ${sqlLocalClock(tz, { minutesBefore, nowSql })}) AT TIME ZONE ${zone(tz)})`;
}
