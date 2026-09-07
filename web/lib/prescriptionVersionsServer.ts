import "server-only";

// Milestone 5, Stage 1 — server-only domain access for immutable
// prescription-version identity. Every write here goes through the
// service-role client: prescription_versions has no permissive INSERT
// policy for `authenticated` at all (RLS default-denies it), matching
// escalation_evaluations/tolerance_evaluations exactly — see
// supabase/migrations/20260909000001_m5_stage1_prescription_versions.sql.
//
// LOCKED invariant: nothing in this module ever creates a version
// opportunistically (e.g. because a read found none). Versions are created
// only by an explicit prescription event — see createPrescriptionVersion's
// callers (the onboarding-sync route and the legacy-bootstrap script/route).
// Session creation's own "no version found" case is handled entirely inside
// the create_rehab_session_if_allowed() RPC (PRESCRIPTION_VERSION_REQUIRED),
// which this module does not call or duplicate.

import { createServiceRoleClient } from "./supabase/server";
import {
  mapPrescriptionVersionRow,
  type Irritability,
  type PrescriptionVersionRecord,
  type PrescriptionVersionSource,
} from "./prescriptionVersionTypes";

export type CreatePrescriptionVersionParams = {
  userId: string;
  stage: number;
  irritability: Irritability;
  isInsertional: boolean;
  source: PrescriptionVersionSource;
  legacyPlanId: string | null;
};

// Append-only insert. Idempotency for source='legacy_bootstrap' is the
// CALLER's responsibility (checking getLatestPrescriptionVersion first) plus
// the DB-level partial unique index as a backstop against a same-user race —
// this function itself always inserts a new row when called; it never
// deduplicates. onboarding/clinician_change/system_progression each
// represent a genuinely new plan-state event, so a new row is always
// correct for them.
export async function createPrescriptionVersion(
  params: CreatePrescriptionVersionParams
): Promise<PrescriptionVersionRecord> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("prescription_versions")
    .insert({
      user_id: params.userId,
      stage: params.stage,
      irritability: params.irritability,
      is_insertional: params.isInsertional,
      source: params.source,
      legacy_plan_id: params.legacyPlanId,
    })
    .select()
    .maybeSingle();
  if (error || !data) {
    throw new Error(`createPrescriptionVersion failed: ${error?.message ?? "no row returned"}`);
  }
  return mapPrescriptionVersionRow(data);
}

// "Current" version = latest row by created_at. No is_current flag exists —
// this IS the derivation, not a cache of one.
export async function getLatestPrescriptionVersion(userId: string): Promise<PrescriptionVersionRecord | null> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("prescription_versions")
    .select()
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getLatestPrescriptionVersion failed: ${error.message}`);
  return data ? mapPrescriptionVersionRow(data) : null;
}

// Resolves a legacy FastAPI patient's email to their Supabase auth user id.
// Only used by the bridge-protected internal sync route, and only as a
// FALLBACK when the caller doesn't already know the Supabase id directly
// (FastAPI's users.supabase_id, cached from a prior SSO-bridge login, is
// preferred when present — see app/main.py's onboarding sync call).
//
// supabase-js's admin API has no "get user by email" lookup, only paginated
// listUsers — the same limitation the existing super/dashboard clinician
// list already lives with (web/app/super/dashboard/page.tsx). Unlike that
// call site, this one paginates rather than assuming the first page is
// enough, since a missed match here would silently fail an onboarding sync
// for a real patient. Capped at 50 pages (10,000 users) as a sane bound for
// what is fundamentally an admin/bootstrap operation, not a hot path.
const LIST_USERS_PAGE_SIZE = 200;
const LIST_USERS_MAX_PAGES = 50;

export async function resolveSupabaseUserIdByEmail(email: string): Promise<string | null> {
  const supabase = createServiceRoleClient();
  const normalized = email.trim().toLowerCase();
  for (let page = 1; page <= LIST_USERS_MAX_PAGES; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: LIST_USERS_PAGE_SIZE });
    if (error) throw new Error(`resolveSupabaseUserIdByEmail failed: ${error.message}`);
    const users = data?.users ?? [];
    const match = users.find((u) => (u.email ?? "").toLowerCase() === normalized);
    if (match) return match.id;
    if (users.length < LIST_USERS_PAGE_SIZE) break; // last page
  }
  return null;
}

// Whether this patient has ANY prescription_versions row at all, regardless
// of source. Used by the legacy-bootstrap path to skip patients who already
// have one (from onboarding-sync or a prior bootstrap run) — bootstrap must
// never add a redundant row for a patient whose identity is already known.
export async function hasAnyPrescriptionVersion(userId: string): Promise<boolean> {
  const supabase = createServiceRoleClient();
  const { count, error } = await supabase
    .from("prescription_versions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (error) throw new Error(`hasAnyPrescriptionVersion failed: ${error.message}`);
  return (count ?? 0) > 0;
}
