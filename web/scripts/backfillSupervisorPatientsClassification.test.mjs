// C1A.1 — pure classification tests for backfillSupervisorPatients.mjs.
// No database, no Supabase, no filesystem — every case here is a plain
// function of explicit inputs. Plain, dependency-free script (see
// lib/__tests__/capacityConstruct.test.ts's identical convention).
// Run with `node scripts/backfillSupervisorPatientsClassification.test.mjs`.
import {
  classifyIdentity,
  classifyRelationship,
  detectUuidPairCollisions,
  classifyPostgresState,
  isWellFormedUuid,
  normalizeEmail,
  resolveDismissedByUuid,
  toUtcIso,
  isEligibleForWrite,
  buildUpsertPayload,
} from "./backfillSupervisorPatients.mjs";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEqual(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";

// --- normalizeEmail / isWellFormedUuid ---

test("normalizeEmail trims and lowercases", () => {
  assertEqual(normalizeEmail("  Foo@Example.COM  "), "foo@example.com", "should trim+lowercase");
});
test("normalizeEmail(null/empty) is null", () => {
  assertEqual(normalizeEmail(null), null, "null email");
  assertEqual(normalizeEmail(""), null, "empty email");
});
test("isWellFormedUuid accepts a real UUID and rejects garbage", () => {
  assert(isWellFormedUuid(UUID_A), "should accept a well-formed UUID");
  assert(!isWellFormedUuid("not-a-uuid"), "should reject garbage");
  assert(!isWellFormedUuid(null), "should reject null");
});

// --- classifyIdentity ---

test("normal resolved relationship: no cache, fresh resolves -> CACHE_MISSING_BUT_RESOLVED", () => {
  const r = classifyIdentity({ email: "a@example.com", cachedUuid: null, freshUuid: UUID_A });
  assertEqual(r, { kind: "CACHE_MISSING_BUT_RESOLVED", resolvedUuid: UUID_A }, "missing cache but resolved");
});

test("matching cached UUID -> RESOLVED", () => {
  const r = classifyIdentity({ email: "a@example.com", cachedUuid: UUID_A, freshUuid: UUID_A });
  assertEqual(r, { kind: "RESOLVED", resolvedUuid: UUID_A }, "cache agrees with fresh resolution");
});

test("cache mismatch -> CACHE_MISMATCH, never auto-resolved", () => {
  const r = classifyIdentity({ email: "a@example.com", cachedUuid: UUID_A, freshUuid: UUID_B });
  assertEqual(r, { kind: "CACHE_MISMATCH", resolvedUuid: null }, "disagreement must not resolve");
});

test("no Supabase user found by email -> NO_SUPABASE_USER", () => {
  const r = classifyIdentity({ email: "nobody@example.com", cachedUuid: null, freshUuid: null });
  assertEqual(r, { kind: "NO_SUPABASE_USER", resolvedUuid: null }, "no match at all");
});

test("no Supabase user takes priority even when a cached UUID exists", () => {
  const r = classifyIdentity({ email: "gone@example.com", cachedUuid: UUID_A, freshUuid: null });
  assertEqual(r.kind, "NO_SUPABASE_USER", "email no longer resolves to anyone, regardless of stale cache");
});

test("missing email -> MISSING_EMAIL", () => {
  const r = classifyIdentity({ email: null, cachedUuid: null, freshUuid: null });
  assertEqual(r, { kind: "MISSING_EMAIL", resolvedUuid: null }, "no email at all");
});

test("malformed cached UUID -> INVALID_CACHED_UUID, never trusted", () => {
  const r = classifyIdentity({ email: "a@example.com", cachedUuid: "not-a-real-uuid", freshUuid: UUID_A });
  assertEqual(r, { kind: "INVALID_CACHED_UUID", resolvedUuid: null }, "malformed cache value must not resolve");
});

test("empty-string cached UUID is treated as absent, not invalid", () => {
  const r = classifyIdentity({ email: "a@example.com", cachedUuid: "", freshUuid: UUID_A });
  assertEqual(r, { kind: "CACHE_MISSING_BUT_RESOLVED", resolvedUuid: UUID_A }, "empty string cache should behave like null");
});

// --- classifyRelationship ---

function identity(kind, resolvedUuid = null) {
  return { kind, resolvedUuid };
}

test("active relationship, both identities clean -> SAFE_TO_MIGRATE", () => {
  const r = classifyRelationship({
    status: "active",
    orphanedForeignKey: false,
    supervisorIdentity: identity("RESOLVED", UUID_A),
    patientIdentity: identity("CACHE_MISSING_BUT_RESOLVED", UUID_B),
  });
  assertEqual(r, "SAFE_TO_MIGRATE", "clean active relationship");
});

test("dismissed relationship, both identities clean -> SAFE_TO_MIGRATE (dismissed is not an error)", () => {
  const r = classifyRelationship({
    status: "dismissed",
    orphanedForeignKey: false,
    supervisorIdentity: identity("RESOLVED", UUID_A),
    patientIdentity: identity("RESOLVED", UUID_B),
  });
  assertEqual(r, "SAFE_TO_MIGRATE", "dismissed historical relationship is legitimately safe to migrate");
});

test("unexpected status value -> INVALID_SOURCE, never normalized to active", () => {
  const r = classifyRelationship({
    status: "pending_review",
    orphanedForeignKey: false,
    supervisorIdentity: identity("RESOLVED", UUID_A),
    patientIdentity: identity("RESOLVED", UUID_B),
  });
  assertEqual(r, "INVALID_SOURCE", "unknown status must be flagged, not guessed");
});

test("orphaned foreign key -> INVALID_SOURCE regardless of identity resolution", () => {
  const r = classifyRelationship({
    status: "active",
    orphanedForeignKey: true,
    supervisorIdentity: identity("RESOLVED", UUID_A),
    patientIdentity: identity("RESOLVED", UUID_B),
  });
  assertEqual(r, "INVALID_SOURCE", "a referenced legacy user row that doesn't exist is invalid source data");
});

test("either side CACHE_MISMATCH -> AMBIGUOUS", () => {
  const r = classifyRelationship({
    status: "active",
    orphanedForeignKey: false,
    supervisorIdentity: identity("CACHE_MISMATCH"),
    patientIdentity: identity("RESOLVED", UUID_B),
  });
  assertEqual(r, "AMBIGUOUS", "a cache disagreement on either side makes the whole relationship ambiguous");
});

test("either side NO_SUPABASE_USER -> UNRESOLVABLE", () => {
  const r = classifyRelationship({
    status: "active",
    orphanedForeignKey: false,
    supervisorIdentity: identity("RESOLVED", UUID_A),
    patientIdentity: identity("NO_SUPABASE_USER"),
  });
  assertEqual(r, "UNRESOLVABLE", "a side with no current Supabase account is unresolvable");
});

test("AMBIGUOUS takes priority over UNRESOLVABLE when both are present", () => {
  const r = classifyRelationship({
    status: "active",
    orphanedForeignKey: false,
    supervisorIdentity: identity("CACHE_MISMATCH"),
    patientIdentity: identity("NO_SUPABASE_USER"),
  });
  assertEqual(r, "AMBIGUOUS", "priority order: INVALID_SOURCE > AMBIGUOUS > UNRESOLVABLE > SAFE_TO_MIGRATE");
});

// --- detectUuidPairCollisions ---

test("no collision when every resolved pair is distinct", () => {
  const c = detectUuidPairCollisions([
    { legacyRelationshipId: 1, supervisorUuid: UUID_A, patientUuid: UUID_B },
    { legacyRelationshipId: 2, supervisorUuid: UUID_B, patientUuid: UUID_A },
  ]);
  assertEqual(c.size, 0, "distinct pairs are not collisions");
});

test("two different legacy relationships resolving to the same pair -> collision, neither auto-chosen", () => {
  const c = detectUuidPairCollisions([
    { legacyRelationshipId: 1, supervisorUuid: UUID_A, patientUuid: UUID_B },
    { legacyRelationshipId: 2, supervisorUuid: UUID_A, patientUuid: UUID_B },
  ]);
  assertEqual(c.size, 1, "exactly one colliding pair");
  const ids = [...c.values()][0];
  assertEqual(ids.sort(), [1, 2], "both legacy relationship ids must be reported, not just one");
});

// --- classifyPostgresState ---

test("no existing Postgres row -> NOT_PRESENT", () => {
  assertEqual(classifyPostgresState({ existingRow: null, legacyStatus: "active", legacyDismissedReason: null }), "NOT_PRESENT", "nothing there yet");
});

test("existing Postgres row with matching status/reason -> PRESENT_MATCHING", () => {
  const r = classifyPostgresState({ existingRow: { status: "dismissed", dismissed_reason: "goals_achieved" }, legacyStatus: "dismissed", legacyDismissedReason: "goals_achieved" });
  assertEqual(r, "PRESENT_MATCHING", "identical state");
});

test("existing Postgres row with a different status -> PRESENT_DIFFERENT, never silently accepted", () => {
  const r = classifyPostgresState({ existingRow: { status: "active", dismissed_reason: null }, legacyStatus: "dismissed", legacyDismissedReason: "user_discontinued" });
  assertEqual(r, "PRESENT_DIFFERENT", "a real disagreement must be surfaced as founder-review material");
});

// --- resolveDismissedByUuid (C1A write mode) ---

test("dismissed_by not set (NULL) -> resolvedUuid null, reason NOT_SET", () => {
  const r = resolveDismissedByUuid({ dismissedByLegacyId: null, email: null, cachedUuid: null, freshUuid: null });
  assertEqual(r, { resolvedUuid: null, reason: "NOT_SET" }, "no dismissed_by at all");
});

test("dismissed_by cleanly resolves via email -> real UUID, never guessed", () => {
  const r = resolveDismissedByUuid({ dismissedByLegacyId: 125, email: "sup@example.com", cachedUuid: null, freshUuid: UUID_A });
  assertEqual(r, { resolvedUuid: UUID_A, reason: "CACHE_MISSING_BUT_RESOLVED" }, "should resolve via fresh email lookup");
});

test("dismissed_by that cannot resolve -> NULL, never a fabricated legacy-integer-as-UUID value", () => {
  const r = resolveDismissedByUuid({ dismissedByLegacyId: 999, email: "gone@example.com", cachedUuid: null, freshUuid: null });
  assertEqual(r, { resolvedUuid: null, reason: "NO_SUPABASE_USER" }, "unresolvable dismissed_by must be NULL, not invented");
});

test("dismissed_by with a cache/fresh mismatch -> NULL, never auto-trusted", () => {
  const r = resolveDismissedByUuid({ dismissedByLegacyId: 125, email: "sup@example.com", cachedUuid: UUID_A, freshUuid: UUID_B });
  assertEqual(r, { resolvedUuid: null, reason: "CACHE_MISMATCH" }, "a disagreement must not resolve even for auxiliary metadata");
});

// --- toUtcIso ---

test("toUtcIso appends Z to a naive Python isoformat timestamp", () => {
  assertEqual(toUtcIso("2026-01-01T12:00:00.000000"), "2026-01-01T12:00:00.000000Z", "naive timestamp must become explicit UTC");
});
test("toUtcIso leaves an already-zoned timestamp untouched", () => {
  assertEqual(toUtcIso("2026-01-01T12:00:00+00:00"), "2026-01-01T12:00:00+00:00", "already explicit — must not be double-suffixed");
  assertEqual(toUtcIso("2026-01-01T12:00:00Z"), "2026-01-01T12:00:00Z", "already Z-suffixed — must not be double-suffixed");
});
test("toUtcIso(null) is null, never invented", () => {
  assertEqual(toUtcIso(null), null, "no dismissed_at at all");
});

// --- isEligibleForWrite / buildUpsertPayload ---

test("SAFE_TO_MIGRATE + NOT_PRESENT is eligible for write", () => {
  assert(isEligibleForWrite({ relationshipClass: "SAFE_TO_MIGRATE", postgresState: "NOT_PRESENT" }), "should be eligible");
});
test("SAFE_TO_MIGRATE + PRESENT_MATCHING is eligible (idempotent no-op)", () => {
  assert(isEligibleForWrite({ relationshipClass: "SAFE_TO_MIGRATE", postgresState: "PRESENT_MATCHING" }), "should be eligible");
});
test("SAFE_TO_MIGRATE + PRESENT_DIFFERENT is NOT eligible — never auto-overwritten", () => {
  assert(!isEligibleForWrite({ relationshipClass: "SAFE_TO_MIGRATE", postgresState: "PRESENT_DIFFERENT" }), "must not silently overwrite a real conflict");
});
test("AMBIGUOUS/UNRESOLVABLE/INVALID_SOURCE are never eligible regardless of postgresState", () => {
  for (const relationshipClass of ["AMBIGUOUS", "UNRESOLVABLE", "INVALID_SOURCE"]) {
    assert(!isEligibleForWrite({ relationshipClass, postgresState: "NOT_PRESENT" }), `${relationshipClass} must never be written`);
  }
});

test("buildUpsertPayload carries status/dismissal metadata and preserves a valid legacy assigned_at", () => {
  const payload = buildUpsertPayload({
    supervisorIdentity: { resolvedUuid: UUID_A },
    patientIdentity: { resolvedUuid: UUID_B },
    status: "dismissed",
    dismissed_at: "2026-01-01T00:00:00.000000",
    dismissed_reason: "goals_achieved",
    dismissedBy: { resolvedUuid: UUID_A },
    assigned_at: "2020-01-01T00:00:00.000000",
  });
  assertEqual(
    payload,
    {
      supervisor_id: UUID_A,
      patient_id: UUID_B,
      status: "dismissed",
      assigned_at: "2020-01-01T00:00:00.000000Z",
      dismissed_at: "2026-01-01T00:00:00.000000Z",
      dismissed_reason: "goals_achieved",
      dismissed_by: UUID_A,
    },
    "payload should preserve status/assigned_at/dismissed_at/dismissed_reason/dismissed_by exactly as legacy recorded them"
  );
});

test("buildUpsertPayload omits assigned_at entirely when legacy has none — never invents a value", () => {
  const payload = buildUpsertPayload({
    supervisorIdentity: { resolvedUuid: UUID_A },
    patientIdentity: { resolvedUuid: UUID_B },
    status: "active",
    dismissed_at: null,
    dismissed_reason: null,
    dismissedBy: { resolvedUuid: null },
    assigned_at: null,
  });
  assert(!("assigned_at" in payload), "assigned_at must be omitted, letting Postgres's own DEFAULT NOW() apply, rather than asserting a historical value that was never recorded");
});

test("buildUpsertPayload writes NULL dismissed_by when it could not be resolved", () => {
  const payload = buildUpsertPayload({
    supervisorIdentity: { resolvedUuid: UUID_A },
    patientIdentity: { resolvedUuid: UUID_B },
    status: "active",
    dismissed_at: null,
    dismissed_reason: null,
    dismissedBy: { resolvedUuid: null },
  });
  assertEqual(payload.dismissed_by, null, "unresolved dismissed_by must be NULL, never guessed");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
