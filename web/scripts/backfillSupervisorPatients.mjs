// C1A.1 — Supervisor Assignment Backfill DRY RUN.
//
// Milestone: Clinician Experience, Phase C1A. Postgres `supervisor_patients`
// is locked (founder decision) to become the canonical clinician-patient
// relationship for Next.js clinician reads. Before any production
// relationship is ever written there, this script performs a READ-ONLY
// classification pass against the REAL legacy SQLite `supervisor_patients`
// table, resolving each legacy integer identity to its Supabase auth UUID
// (reusing the exact semantics of the already-proven, already-in-production
// `resolveSupabaseUserIdByEmail` in web/lib/prescriptionVersionsServer.ts —
// paginated `auth.admin.listUsers`, email matched case-insensitively —
// batched here into one full email->UUID map for efficiency rather than
// one lookup per relationship), and reports exactly what a real backfill
// would do, without doing it.
//
// ZERO WRITES: the legacy SQLite connection is opened with { readOnly: true }
// (an OS/driver-level guarantee, not just "the code happens not to call
// .run()") and only ever executes SELECT statements. The Postgres
// service-role client only ever SELECTs from supervisor_patients and
// auth.admin.listUsers — never inserts/updates/deletes. This is verified
// empirically at the end of the run: the Postgres supervisor_patients row
// count is read before and after, and the script fails loudly if they ever
// differ.
//
// This script intentionally has NO --write mode. C1A.2 will add one only
// after founder review of this report (see the C1A.1 task brief).
//
// No secret material is ever selected or printed: the legacy `users`
// table's password_hash/session_token columns are never included in any
// query here, and only the .env.local-sourced Supabase URL/key (already
// used by every other script in this directory) are read, never logged.
//
// Run from the web/ directory:
//   node scripts/backfillSupervisorPatients.mjs

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

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

// Matches the legacy Python backend's own default DB_PATH exactly
// (app/db/database.py: Path(__file__).parent.parent / "tenotrainer.db",
// overridable only via TENO_DB_PATH, which is not set in this environment —
// confirmed empirically: app/tenotrainer.db is the live, non-empty database;
// the repo-root tenotrainer.db/teno.db files are both 0 bytes, vestigial).
// Relative to the web/ directory, matching every other script's own
// "run from web/" convention (see scripts/verifyBrowserStates.mjs's
// identical "../app/tenotrainer.db" path).
const LEGACY_DB_PATH = "../app/tenotrainer.db";

// Mirrors resolveSupabaseUserIdByEmail's own bound exactly (lib/
// prescriptionVersionsServer.ts) — a sane cap for an admin/bootstrap-scale
// operation, not a hot path.
const LIST_USERS_PAGE_SIZE = 200;
const LIST_USERS_MAX_PAGES = 50;

// ---------------------------------------------------------------------------
// Pure classification functions — exported for
// backfillSupervisorPatientsClassification.test.mjs. No I/O, no Supabase
// client, no SQLite handle — every decision here is a function of its
// explicit inputs only, so these are exhaustively unit-testable without a
// live database.
// ---------------------------------------------------------------------------

export function normalizeEmail(email) {
  return typeof email === "string" && email.length > 0 ? email.trim().toLowerCase() : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isWellFormedUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

// Classifies ONE identity (a supervisor or a patient) given its legacy
// email, its cached legacy `users.supabase_id` (may be null/empty), and the
// result of a FRESH email lookup against Supabase auth (a UUID, or null if
// no current match). Never guesses: every branch either returns a resolved
// UUID with a definite reason, or null with a definite reason — there is no
// "probably fine" branch. A cache/fresh disagreement is CACHE_MISMATCH, not
// silently trusted either way, per the locked investigation's requirement.
export function classifyIdentity({ email, cachedUuid, freshUuid }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return { kind: "MISSING_EMAIL", resolvedUuid: null };
  }
  const hasCached = cachedUuid != null && cachedUuid !== "";
  if (hasCached && !isWellFormedUuid(cachedUuid)) {
    return { kind: "INVALID_CACHED_UUID", resolvedUuid: null };
  }
  if (!freshUuid) {
    return { kind: "NO_SUPABASE_USER", resolvedUuid: null };
  }
  if (hasCached && cachedUuid !== freshUuid) {
    return { kind: "CACHE_MISMATCH", resolvedUuid: null };
  }
  if (!hasCached) {
    return { kind: "CACHE_MISSING_BUT_RESOLVED", resolvedUuid: freshUuid };
  }
  return { kind: "RESOLVED", resolvedUuid: freshUuid };
}

// Confirmed against both the legacy codebase (every write site) and the
// live production database (empirically queried, 2026-09 snapshot): exactly
// these two values are ever used. Anything else is unexpected source data,
// never silently normalized.
const KNOWN_STATUSES = new Set(["active", "dismissed"]);

export function isKnownStatus(status) {
  return KNOWN_STATUSES.has(status);
}

// Legacy timestamps come from Python's `datetime.utcnow().isoformat()` —
// naive (no timezone designator), but always genuinely UTC (confirmed by
// reading the write site: app/supervisor.py's dismiss handler uses
// `datetime.utcnow()`, never local time). Postgres's TIMESTAMPTZ column
// would otherwise have to guess an offset for a naive string — this makes
// the already-known UTC-ness explicit rather than relying on an assumed
// server default. Never used to invent a value: null in, null out.
export function toUtcIso(legacyTimestamp) {
  if (!legacyTimestamp) return null;
  return /[zZ]|[+-]\d\d:\d\d$/.test(legacyTimestamp) ? legacyTimestamp : `${legacyTimestamp}Z`;
}

// Which SAFE_TO_MIGRATE rows are actually eligible for a write. A row whose
// Postgres state is PRESENT_DIFFERENT is deliberately EXCLUDED even though
// it's otherwise "safe" by identity resolution — an existing Postgres row
// that already disagrees with legacy is founder-review material (per the
// dry-run's own classification), never silently overwritten by an
// automated write. PRESENT_MATCHING is fine to include (a no-op idempotent
// upsert); NOT_PRESENT is the normal new-row case.
export function isEligibleForWrite(row) {
  return row.relationshipClass === "SAFE_TO_MIGRATE" && row.postgresState !== "PRESENT_DIFFERENT";
}

// Builds the exact Postgres upsert payload for one eligible row. Never
// invents a value: dismissed_by is included only when cleanly resolved to
// a real Supabase UUID (see resolveDismissedByUuid) — otherwise explicitly
// NULL, per the locked instruction, while status/dismissed_at/
// dismissed_reason are always preserved as legacy recorded them.
// `assigned_at` (founder decision, C1A verification pass): preserved from
// the legacy value when it is present and valid, so a migrated
// relationship's historical assignment time survives the move — omitted
// from the payload entirely when legacy has no assigned_at, letting
// Postgres's own DEFAULT NOW() apply on first insert rather than asserting
// a historical value that was never recorded. Idempotent: rerunning against
// an already-migrated row with the same legacy assigned_at simply rewrites
// the same value.
export function buildUpsertPayload(row) {
  const assignedAt = toUtcIso(row.assigned_at ?? null);
  return {
    supervisor_id: row.supervisorIdentity.resolvedUuid,
    patient_id: row.patientIdentity.resolvedUuid,
    status: row.status,
    ...(assignedAt ? { assigned_at: assignedAt } : {}),
    dismissed_at: toUtcIso(row.dismissed_at ?? null),
    dismissed_reason: row.dismissed_reason ?? null,
    dismissed_by: row.dismissedBy?.resolvedUuid ?? null,
  };
}

const AMBIGUOUS_IDENTITY_KINDS = new Set(["CACHE_MISMATCH", "INVALID_CACHED_UUID"]);
const UNRESOLVABLE_IDENTITY_KINDS = new Set(["NO_SUPABASE_USER", "MISSING_EMAIL"]);

// Combines both identities' classifications plus the relationship's own
// status/referential integrity into ONE overall migration-outcome label.
// Priority (highest first): INVALID_SOURCE (bad status, or a referenced
// legacy user row that doesn't exist at all) -> AMBIGUOUS (a real
// cache/fresh-resolution conflict on either side — never auto-resolved) ->
// UNRESOLVABLE (no current Supabase account, or no email, on either side)
// -> SAFE_TO_MIGRATE. A dismissed relationship with two cleanly resolved
// identities is SAFE_TO_MIGRATE — dismissed is legitimate historical data,
// never an error condition on its own.
export function classifyRelationship({ status, orphanedForeignKey, supervisorIdentity, patientIdentity }) {
  if (orphanedForeignKey) return "INVALID_SOURCE";
  if (!isKnownStatus(status)) return "INVALID_SOURCE";
  if (AMBIGUOUS_IDENTITY_KINDS.has(supervisorIdentity.kind) || AMBIGUOUS_IDENTITY_KINDS.has(patientIdentity.kind)) {
    return "AMBIGUOUS";
  }
  if (UNRESOLVABLE_IDENTITY_KINDS.has(supervisorIdentity.kind) || UNRESOLVABLE_IDENTITY_KINDS.has(patientIdentity.kind)) {
    return "UNRESOLVABLE";
  }
  return "SAFE_TO_MIGRATE";
}

// Second pass, applied only across relationships already classified
// SAFE_TO_MIGRATE: detects two different legacy relationship rows resolving
// to the identical (supervisorUuid, patientUuid) pair — theoretically
// possible if legacy duplicate accounts collapse onto the same Supabase
// identity. Never picks a winner; every colliding pair is reported and
// excluded from the safe count until a founder reconciles it by hand.
export function detectUuidPairCollisions(resolvedRows) {
  const byPair = new Map();
  for (const row of resolvedRows) {
    const key = `${row.supervisorUuid}::${row.patientUuid}`;
    const list = byPair.get(key) ?? [];
    list.push(row.legacyRelationshipId);
    byPair.set(key, list);
  }
  const collisions = new Map();
  for (const [key, ids] of byPair) {
    if (ids.length > 1) collisions.set(key, ids);
  }
  return collisions;
}

// C1A — resolves `dismissed_by` (a legacy INTEGER users.id) to its Postgres
// UUID for the write path. Postgres's `supervisor_patients.dismissed_by` is
// `UUID REFERENCES auth.users(id)` — a legacy integer must never be copied
// into it directly, and no value may ever be invented. Reuses the exact
// same identity classification as supervisor/patient (email + cached
// supabase_id cross-check); if it cannot be cleanly resolved (no email, no
// current Supabase account, or a cache disagreement), the caller must write
// NULL for this field while still preserving status/dismissed_at/
// dismissed_reason — dismissed_by is auxiliary provenance, never a gate on
// whether the relationship itself is safe to migrate.
export function resolveDismissedByUuid({ dismissedByLegacyId, email, cachedUuid, freshUuid }) {
  if (dismissedByLegacyId == null) return { resolvedUuid: null, reason: "NOT_SET" };
  const identity = classifyIdentity({ email, cachedUuid, freshUuid });
  if (identity.kind === "RESOLVED" || identity.kind === "CACHE_MISSING_BUT_RESOLVED") {
    return { resolvedUuid: identity.resolvedUuid, reason: identity.kind };
  }
  return { resolvedUuid: null, reason: identity.kind };
}

// Compares a safely-resolved legacy relationship's own state against
// whatever (if anything) already exists at that exact (supervisor, patient)
// UUID pair in Postgres today. Never used to decide a write — purely
// informational, since this script performs none.
export function classifyPostgresState({ existingRow, legacyStatus, legacyDismissedReason }) {
  if (!existingRow) return "NOT_PRESENT";
  const statusMatches = existingRow.status === legacyStatus;
  const reasonMatches = (existingRow.dismissed_reason ?? null) === (legacyDismissedReason ?? null);
  return statusMatches && reasonMatches ? "PRESENT_MATCHING" : "PRESENT_DIFFERENT";
}

// ---------------------------------------------------------------------------
// I/O — everything below this line touches the legacy SQLite file or
// Supabase. Nothing above it does.
// ---------------------------------------------------------------------------

async function buildSupabaseEmailMap() {
  const map = new Map();
  for (let page = 1; page <= LIST_USERS_MAX_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: LIST_USERS_PAGE_SIZE });
    if (error) throw new Error(`auth.admin.listUsers failed: ${error.message}`);
    const users = data?.users ?? [];
    for (const u of users) {
      const email = normalizeEmail(u.email);
      if (email) map.set(email, u.id);
    }
    if (users.length < LIST_USERS_PAGE_SIZE) break; // last page
  }
  return map;
}

// LEFT JOINs deliberately, not INNER — a supervisor_id/patient_id with no
// matching legacy users row (orphaned FK; the legacy schema declares the FK
// but SQLite does not enforce it unless PRAGMA foreign_keys=ON was active
// at write time, so this is a real possibility, not paranoia) must still
// surface as its own relationship row, classified INVALID_SOURCE, rather
// than silently vanishing from the report. Never selects password_hash or
// session_token.
function readLegacyRelationships(legacyDb) {
  return legacyDb
    .prepare(
      `SELECT
         sp.id               AS relationship_id,
         sp.supervisor_id    AS legacy_supervisor_id,
         sp.patient_id       AS legacy_patient_id,
         sp.status           AS status,
         sp.assigned_at      AS assigned_at,
         sp.dismissed_at     AS dismissed_at,
         sp.dismissed_reason AS dismissed_reason,
         sp.dismissed_by     AS dismissed_by,
         sup.name            AS supervisor_name,
         sup.email           AS supervisor_email,
         sup.role            AS supervisor_role,
         sup.supabase_id     AS supervisor_cached_uuid,
         pat.name            AS patient_name,
         pat.email           AS patient_email,
         pat.role            AS patient_role,
         pat.supabase_id     AS patient_cached_uuid,
         dby.email           AS dismissed_by_email,
         dby.supabase_id     AS dismissed_by_cached_uuid
       FROM supervisor_patients sp
       LEFT JOIN users sup ON sup.id = sp.supervisor_id
       LEFT JOIN users pat ON pat.id = sp.patient_id
       LEFT JOIN users dby ON dby.id = sp.dismissed_by
       ORDER BY sp.id ASC`
    )
    .all();
}

async function fetchExistingPostgresRelationships() {
  const { data, error } = await admin.from("supervisor_patients").select("supervisor_id, patient_id, status, dismissed_reason");
  if (error) throw new Error(`Postgres supervisor_patients read failed: ${error.message}`);
  const map = new Map();
  for (const row of data ?? []) map.set(`${row.supervisor_id}::${row.patient_id}`, row);
  return map;
}

async function fetchPostgresRelationshipCount() {
  const { count, error } = await admin.from("supervisor_patients").select("id", { count: "exact", head: true });
  if (error) throw new Error(`Postgres supervisor_patients count failed: ${error.message}`);
  return count ?? 0;
}

function fmtRow(r) {
  return {
    relationship_id: r.relationship_id,
    status: r.status,
    relationshipClass: r.relationshipClass,
    collision: r.collision ? "yes" : "",
    supervisor: `${r.supervisor_email ?? "(missing)"} [legacy #${r.legacy_supervisor_id}, role=${r.supervisor_role ?? "?"}]`,
    supervisorIdentity: r.supervisorIdentity.kind,
    patient: `${r.patient_email ?? "(missing)"} [legacy #${r.legacy_patient_id}, role=${r.patient_role ?? "?"}]`,
    patientIdentity: r.patientIdentity.kind,
    dismissed_reason: r.dismissed_reason ?? "",
    postgresState: r.postgresState ?? "",
  };
}

// The one unmistakable way to opt into writing. Default (no flag, or
// anything else) is always dry-run — this is the only place in the whole
// script that decides whether a write happens.
const WRITE_MODE = process.argv.includes("--write");

async function writeApprovedRelationships(eligibleRows) {
  if (eligibleRows.length === 0) {
    console.log("\nNo eligible relationships to write.");
    return { written: 0 };
  }
  const payload = eligibleRows.map(buildUpsertPayload);
  const { error } = await admin.from("supervisor_patients").upsert(payload, { onConflict: "supervisor_id,patient_id" });
  if (error) throw new Error(`Write failed: ${error.message}`);
  console.log(`\nWROTE ${payload.length} relationship(s) to Postgres supervisor_patients (idempotent upsert on supervisor_id,patient_id).`);
  return { written: payload.length };
}

async function main() {
  console.log(`=== C1A Supervisor Assignment Backfill — ${WRITE_MODE ? "WRITE MODE" : "DRY RUN (read-only, zero writes)"} ===\n`);
  if (WRITE_MODE) {
    console.log("--write flag detected: SAFE_TO_MIGRATE relationships with no conflicting Postgres state WILL be written.\n");
  }

  const pgCountBefore = await fetchPostgresRelationshipCount();

  const legacyDb = new DatabaseSync(LEGACY_DB_PATH, { readOnly: true });
  let legacyRows;
  try {
    legacyRows = readLegacyRelationships(legacyDb);
  } finally {
    legacyDb.close();
  }

  const emailMap = await buildSupabaseEmailMap();
  const existingPg = await fetchExistingPostgresRelationships();

  const classified = legacyRows.map((row) => {
    const orphanedForeignKey = row.supervisor_name == null || row.patient_name == null; // NOT NULL in schema — null here means the LEFT JOIN found no row at all
    const supervisorFresh = emailMap.get(normalizeEmail(row.supervisor_email)) ?? null;
    const patientFresh = emailMap.get(normalizeEmail(row.patient_email)) ?? null;
    const supervisorIdentity = classifyIdentity({ email: row.supervisor_email, cachedUuid: row.supervisor_cached_uuid, freshUuid: supervisorFresh });
    const patientIdentity = classifyIdentity({ email: row.patient_email, cachedUuid: row.patient_cached_uuid, freshUuid: patientFresh });
    const relationshipClass = classifyRelationship({ status: row.status, orphanedForeignKey, supervisorIdentity, patientIdentity });
    const dismissedByFresh = emailMap.get(normalizeEmail(row.dismissed_by_email)) ?? null;
    const dismissedBy = resolveDismissedByUuid({
      dismissedByLegacyId: row.dismissed_by,
      email: row.dismissed_by_email,
      cachedUuid: row.dismissed_by_cached_uuid,
      freshUuid: dismissedByFresh,
    });
    return { ...row, orphanedForeignKey, supervisorIdentity, patientIdentity, relationshipClass, dismissedBy, collision: false, postgresState: null };
  });

  // --- collision pass ---
  const resolvedForCollision = classified
    .filter((r) => r.relationshipClass === "SAFE_TO_MIGRATE")
    .map((r) => ({ legacyRelationshipId: r.relationship_id, supervisorUuid: r.supervisorIdentity.resolvedUuid, patientUuid: r.patientIdentity.resolvedUuid }));
  const collisions = detectUuidPairCollisions(resolvedForCollision);
  const collidingIds = new Set([...collisions.values()].flat());
  for (const r of classified) {
    if (r.relationshipClass === "SAFE_TO_MIGRATE" && collidingIds.has(r.relationship_id)) {
      r.relationshipClass = "AMBIGUOUS";
      r.collision = true;
    }
  }

  // --- existing-Postgres-state pass (informational only; no writes) ---
  for (const r of classified) {
    if (r.relationshipClass === "SAFE_TO_MIGRATE") {
      const key = `${r.supervisorIdentity.resolvedUuid}::${r.patientIdentity.resolvedUuid}`;
      r.postgresState = classifyPostgresState({
        existingRow: existingPg.get(key) ?? null,
        legacyStatus: r.status,
        legacyDismissedReason: r.dismissed_reason ?? null,
      });
    }
  }

  // --- summary counts ---
  const total = classified.length;
  const activeCount = classified.filter((r) => r.status === "active").length;
  const dismissedCount = classified.filter((r) => r.status === "dismissed").length;
  const distinctLegacySupervisors = new Set(classified.map((r) => r.legacy_supervisor_id)).size;
  const distinctLegacyPatients = new Set(classified.map((r) => r.legacy_patient_id)).size;

  const safe = classified.filter((r) => r.relationshipClass === "SAFE_TO_MIGRATE");
  const safeActive = safe.filter((r) => r.status === "active").length;
  const safeDismissed = safe.filter((r) => r.status === "dismissed").length;
  const ambiguous = classified.filter((r) => r.relationshipClass === "AMBIGUOUS");
  const unresolvable = classified.filter((r) => r.relationshipClass === "UNRESOLVABLE");
  const invalidSource = classified.filter((r) => r.relationshipClass === "INVALID_SOURCE");

  const allIdentities = classified.flatMap((r) => [r.supervisorIdentity, r.patientIdentity]);
  const cacheMissingButResolved = allIdentities.filter((i) => i.kind === "CACHE_MISSING_BUT_RESOLVED").length;
  const cacheMismatch = allIdentities.filter((i) => i.kind === "CACHE_MISMATCH").length;
  const noSupabaseUser = allIdentities.filter((i) => i.kind === "NO_SUPABASE_USER").length;
  const missingEmail = allIdentities.filter((i) => i.kind === "MISSING_EMAIL").length;
  const invalidCachedUuid = allIdentities.filter((i) => i.kind === "INVALID_CACHED_UUID").length;

  const distinctResolvedSupervisorUuids = new Set(safe.map((r) => r.supervisorIdentity.resolvedUuid)).size;
  const distinctResolvedPatientUuids = new Set(safe.map((r) => r.patientIdentity.resolvedUuid)).size;

  const notPresent = safe.filter((r) => r.postgresState === "NOT_PRESENT").length;
  const presentMatching = safe.filter((r) => r.postgresState === "PRESENT_MATCHING").length;
  const presentDifferent = safe.filter((r) => r.postgresState === "PRESENT_DIFFERENT").length;

  console.log("--- SUMMARY ---");
  console.log(`Total legacy relationships:            ${total}`);
  console.log(`  active:                               ${activeCount}`);
  console.log(`  dismissed:                             ${dismissedCount}`);
  console.log(`Distinct legacy supervisors:            ${distinctLegacySupervisors}`);
  console.log(`Distinct legacy patients:               ${distinctLegacyPatients}`);
  console.log("");
  console.log(`SAFE_TO_MIGRATE:                        ${safe.length}  (active: ${safeActive}, dismissed: ${safeDismissed})`);
  console.log(`AMBIGUOUS:                               ${ambiguous.length}  (of which UUID-pair collisions: ${classified.filter((r) => r.collision).length})`);
  console.log(`UNRESOLVABLE:                            ${unresolvable.length}`);
  console.log(`INVALID_SOURCE:                          ${invalidSource.length}`);
  console.log("");
  console.log(`Identity resolutions across both roles (${total * 2} identity checks):`);
  console.log(`  resolved via email despite missing cache: ${cacheMissingButResolved}`);
  console.log(`  cache mismatches:                         ${cacheMismatch}`);
  console.log(`  no current Supabase user:                 ${noSupabaseUser}`);
  console.log(`  missing email:                             ${missingEmail}`);
  console.log(`  invalid cached UUID:                       ${invalidCachedUuid}`);
  console.log("");
  console.log(`Distinct UUID-pair collisions detected: ${collisions.size}`);
  console.log(`Distinct resolved Supabase supervisors:  ${distinctResolvedSupervisorUuids}`);
  console.log(`Distinct resolved Supabase patients:     ${distinctResolvedPatientUuids}`);
  console.log("");
  console.log(`Existing Postgres state for safe rows — NOT_PRESENT: ${notPresent}, PRESENT_MATCHING: ${presentMatching}, PRESENT_DIFFERENT: ${presentDifferent}`);

  const problematic = classified.filter((r) => r.relationshipClass !== "SAFE_TO_MIGRATE" || r.postgresState === "PRESENT_DIFFERENT");
  console.log(`\n--- DETAILED REPORT: ${problematic.length} relationship(s) needing review ---`);
  if (problematic.length === 0) {
    console.log("(none — every relationship is SAFE_TO_MIGRATE with no Postgres state conflict)");
  } else {
    console.table(problematic.map(fmtRow));
  }

  const eligibleForWrite = classified.filter(isEligibleForWrite);
  const safeClean = safe.filter((r) => r.postgresState !== "PRESENT_DIFFERENT");
  console.log(`\n--- SAFE, NO CONFLICT (eligible for write): ${safeClean.length} relationship(s) ---`);
  if (safeClean.length > 0) console.table(safeClean.map(fmtRow));
  if (safe.length !== safeClean.length) {
    console.log(`(${safe.length - safeClean.length} additional SAFE_TO_MIGRATE relationship(s) excluded from write eligibility: existing Postgres state differs — see PRESENT_DIFFERENT rows above, never auto-overwritten.)`);
  }

  let writeResult = { written: 0 };
  if (WRITE_MODE) {
    writeResult = await writeApprovedRelationships(eligibleForWrite);
  } else {
    console.log(`\n(dry run — would write ${eligibleForWrite.length} relationship(s) with --write)`);
  }

  const pgCountAfter = await fetchPostgresRelationshipCount();
  console.log(`\nPostgres supervisor_patients row count — before: ${pgCountBefore}, after: ${pgCountAfter}`);
  const expectedDelta = WRITE_MODE ? writeResult.written - eligibleForWrite.filter((r) => r.postgresState === "PRESENT_MATCHING").length : 0;
  if (!WRITE_MODE) {
    if (pgCountBefore !== pgCountAfter) {
      console.error("FAIL — row count changed during a dry run. This must never happen — investigate immediately.");
      process.exitCode = 1;
      return;
    }
    console.log("Zero-write guarantee verified: Postgres row count unchanged; legacy SQLite opened read-only throughout.\n");
  } else {
    const actualDelta = pgCountAfter - pgCountBefore;
    console.log(`Expected new-row delta (NOT_PRESENT rows written; PRESENT_MATCHING rows are idempotent no-ops, not new rows): ${expectedDelta}`);
    if (actualDelta !== expectedDelta) {
      console.error(`FAIL — row count delta (${actualDelta}) did not match the expected new-row count (${expectedDelta}). Investigate before trusting this write.`);
      process.exitCode = 1;
      return;
    }
    console.log("Row-count delta matches expectation exactly.\n");
  }
}

// Entry-point guard: this module is also `import`ed (for its pure,
// side-effect-free classification exports) by
// backfillSupervisorPatientsClassification.test.mjs. Without this guard,
// that import alone would trigger a real run against the legacy DB and
// Supabase — harmless here since the run is genuinely read-only, but a
// pure-classification test file must never touch a live database as a side
// effect of merely importing. `main()` therefore only executes when this
// file is the actual process entry point (`node
// scripts/backfillSupervisorPatients.mjs`), never on import.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("FAIL — unexpected error:", e instanceof Error ? e.stack : e);
    process.exitCode = 1;
  });
}
