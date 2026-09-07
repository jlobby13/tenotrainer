// Milestone 5, Stage 1 — legacy prescription-version bootstrap.
//
// One-time, idempotent, operator-run script. For every patient who exists
// in BOTH systems (a Supabase auth account AND a legacy FastAPI rehab_plans
// row) and does not already have ANY prescription_versions row, creates
// exactly one row with source='legacy_bootstrap' capturing their CURRENTLY
// known plan state (stage/irritability/is_insertional).
//
// What this deliberately does NOT do (see the M5 Stage 1 architecture
// report):
//   - does not reconstruct historical prescription versions — rehab_plans
//     has no reliable change-history to reconstruct from;
//   - does not infer when a past change happened;
//   - does not attach any existing rehab_sessions row to the bootstrap
//     version. Historical sessions keep prescription_version_id = NULL
//     ("legacy/unresolved") — this script never touches rehab_sessions.
//
// Idempotency: re-running this script is always safe. A patient who already
// has a version (from a prior bootstrap run, or because their onboarding
// sync already succeeded) is skipped — enforced both here (a check before
// each write) and at the DB level (a partial UNIQUE index on
// prescription_versions(user_id) WHERE source='legacy_bootstrap' — see
// supabase/migrations/20260909000001_m5_stage1_prescription_versions.sql).
//
// Run from the web/ directory:
//   node_modules/.bin/jiti scripts/bootstrapPrescriptionVersions.ts
//
// Requires (from web/.env.local or the environment):
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   FASTAPI_URL, NEXTJS_URL, BRIDGE_SECRET
//
// Deliberately does NOT import anything under web/lib/supabase/server.ts —
// this script runs standalone (via jiti/node), outside the Next.js request
// lifecycle, so it constructs its own Supabase client directly instead of
// going through the `server-only`-guarded wrapper.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal(): void {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  const contents = readFileSync(path, "utf8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvLocal();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FASTAPI_URL = process.env.FASTAPI_URL ?? "http://localhost:8000";
const NEXTJS_URL = process.env.NEXTJS_URL ?? "http://localhost:3000";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;

const LIST_USERS_PAGE_SIZE = 200;
const LIST_USERS_MAX_PAGES = 50; // sane bound for an admin/bootstrap operation, not a hot path

type PrescriptionState = {
  has_plan: boolean;
  supabase_id?: string | null;
  plan_id?: number;
  plan_created_at?: string;
  stage?: number;
  irritability?: string;
  is_insertional?: boolean;
};

async function fetchPrescriptionState(email: string): Promise<PrescriptionState> {
  const res = await fetch(`${FASTAPI_URL}/api/internal/prescription-state?email=${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${BRIDGE_SECRET}` },
  });
  if (res.status === 404) return { has_plan: false };
  if (!res.ok) {
    throw new Error(`FastAPI prescription-state ${email} -> ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return res.json();
}

async function createBootstrapVersion(params: {
  supabaseId: string;
  stage: number;
  irritability: string;
  isInsertional: boolean;
  legacyPlanId: number;
}): Promise<{ created: boolean; skipped: boolean }> {
  const res = await fetch(`${NEXTJS_URL}/api/internal/prescription-versions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${BRIDGE_SECRET}` },
    body: JSON.stringify({
      supabaseId: params.supabaseId,
      stage: params.stage,
      irritability: params.irritability,
      isInsertional: params.isInsertional,
      legacyPlanId: params.legacyPlanId,
      source: "legacy_bootstrap",
    }),
  });
  if (!res.ok) {
    throw new Error(`Next.js prescription-versions ${params.supabaseId} -> ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = await res.json();
  return { created: !body.skipped, skipped: Boolean(body.skipped) };
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  if (!BRIDGE_SECRET) {
    console.error("Missing BRIDGE_SECRET.");
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  let created = 0;
  let skippedAlreadyHasVersion = 0;
  let skippedNoPlan = 0;
  let skippedNoEmail = 0;
  let errors = 0;

  for (let page = 1; page <= LIST_USERS_MAX_PAGES; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: LIST_USERS_PAGE_SIZE });
    if (error) {
      console.error(`listUsers page ${page} failed: ${error.message}`);
      errors++;
      break;
    }
    const users = data?.users ?? [];
    if (users.length === 0) break;

    for (const authUser of users) {
      if (!authUser.email) {
        skippedNoEmail++;
        continue;
      }
      try {
        const state = await fetchPrescriptionState(authUser.email);
        if (!state.has_plan || state.stage == null || !state.irritability || state.plan_id == null) {
          skippedNoPlan++;
          continue;
        }
        const result = await createBootstrapVersion({
          supabaseId: authUser.id,
          stage: state.stage,
          irritability: state.irritability,
          isInsertional: Boolean(state.is_insertional),
          legacyPlanId: state.plan_id,
        });
        if (result.created) {
          created++;
          console.log(`created: ${authUser.email}`);
        } else {
          skippedAlreadyHasVersion++;
        }
      } catch (e) {
        errors++;
        console.error(`error: ${authUser.email}: ${e instanceof Error ? e.message : e}`);
      }
    }

    if (users.length < LIST_USERS_PAGE_SIZE) break; // last page
  }

  console.log(
    `\nDone. created=${created} skipped_already_has_version=${skippedAlreadyHasVersion} skipped_no_plan=${skippedNoPlan} skipped_no_email=${skippedNoEmail} errors=${errors}`
  );
  process.exit(errors > 0 ? 1 : 0);
}

main();
