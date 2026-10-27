// M3.1 — test-harness production guard. Every write-capable verification,
// fixture or cleanup harness calls assertDevTestTarget() before touching
// any database. It FAILS CLOSED unless BOTH:
//
//   1. TENOTRAINER_MODE === "development" in the harness process environment
//      (missing, production or maintenance -> refuse), AND
//   2. the target Supabase project ref is explicitly listed in
//      scripts/lib/allowedTestProjects.json (missing file, empty list or an
//      unknown project -> refuse).
//
// A production Supabase URL accidentally placed into a developer
// environment is therefore never enough to permit test writes. The
// `supabase db query --linked` target (supabase/.temp/project-ref) is
// checked too, so SQL issued by a harness cannot hit another project.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ALLOW_LIST = join(HERE, "allowedTestProjects.json");
const LINKED_REF = join(HERE, "..", "..", "..", "supabase", ".temp", "project-ref");

export class TestTargetRefused extends Error {}

function refuse(reason) {
  throw new TestTargetRefused(`Refusing to run a write-capable test harness: ${reason}`);
}

export function projectRefFromUrl(url) {
  try {
    const host = new URL(url).hostname;
    const m = /^([a-z0-9]{20})\.supabase\.(co|in|net)$/.exec(host);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function loadAllowedProjects(path = ALLOW_LIST) {
  if (!existsSync(path)) refuse("the approved test-project allow-list is missing");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    refuse("the approved test-project allow-list is unreadable");
  }
  const list = Array.isArray(parsed?.projects) ? parsed.projects.filter((p) => typeof p === "string" && p.length > 0) : [];
  if (list.length === 0) refuse("the approved test-project allow-list is empty");
  return list;
}

// env: the harness's loaded .env.local values (must include NEXT_PUBLIC_SUPABASE_URL).
export function assertDevTestTarget(env, { mode = process.env.TENOTRAINER_MODE, allowListPath = ALLOW_LIST, linkedRefPath = LINKED_REF } = {}) {
  if (mode === undefined || mode === "") refuse("TENOTRAINER_MODE is not set (it must be explicitly 'development')");
  if (mode !== "development") refuse(`TENOTRAINER_MODE is '${mode}' (test writes are only allowed in development)`);
  const allowed = loadAllowedProjects(allowListPath);
  const ref = projectRefFromUrl(env?.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (!ref) refuse("the target Supabase project ref could not be determined");
  if (!allowed.includes(ref)) refuse("the target Supabase project is not on the approved test-project allow-list");
  if (existsSync(linkedRefPath)) {
    const linked = readFileSync(linkedRefPath, "utf8").trim();
    if (linked && !allowed.includes(linked)) refuse("the linked Supabase CLI project is not on the approved test-project allow-list");
  }
  return ref;
}

// For SQL suites run through the Supabase CLI: only the linked project matters.
export function assertDevSqlTarget({ mode = process.env.TENOTRAINER_MODE, allowListPath = ALLOW_LIST, linkedRefPath = LINKED_REF } = {}) {
  if (mode === undefined || mode === "") refuse("TENOTRAINER_MODE is not set (it must be explicitly 'development')");
  if (mode !== "development") refuse(`TENOTRAINER_MODE is '${mode}' (test writes are only allowed in development)`);
  const allowed = loadAllowedProjects(allowListPath);
  if (!existsSync(linkedRefPath)) refuse("no linked Supabase CLI project");
  const linked = readFileSync(linkedRefPath, "utf8").trim();
  if (!allowed.includes(linked)) refuse("the linked Supabase CLI project is not on the approved test-project allow-list");
  return linked;
}
