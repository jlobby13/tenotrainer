// M3.3 S3 — static enforcement of the configuration boundary (part of the
// architecture, not optional cleanup). Fails if a change re-introduces an
// uncontrolled environment read, NEXT_PUBLIC_* authority, a new importer of
// the secret boundary, a raw secret reveal, or a leak into build output.
//
//   static:  node scripts/verifyM33ConfigBoundary.test.mjs
//   + build: node scripts/verifyM33ConfigBoundary.test.mjs --build [--sentinels <file.json>]
//
// Adding an exception here requires founder approval (S3 plan §18).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

// ---------------------------------------------------------------- application source
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(p, out);
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}
const ROOT_FILES = ["proxy.ts", "instrumentation.ts", "instrumentation-node.ts", "next.config.ts"].map((f) => join(WEB, f));
const APP_FILES = [...walk(join(WEB, "app")), ...walk(join(WEB, "lib")), ...ROOT_FILES.filter(existsSync)];
const rel = (p) => relative(WEB, p);
const src = new Map(APP_FILES.map((p) => [rel(p), readFileSync(p, "utf8")]));
check(`application source scanned (${src.size} files: app/, lib/ excluding tests, proxy, instrumentation, next.config)`, src.size > 100);

// 1. Environment reads are centralized.
const ENV_READ = /\bprocess\s*(?:\.\s*env|\[\s*["'`]env["'`]\s*\])|import\.meta\.env|\bDeno\.env/g;
const envOffenders = [];
for (const [file, text] of src) {
  const hits = text.match(ENV_READ) ?? [];
  if (hits.length === 0 || file === "lib/config/index.ts") continue;
  if (file === "instrumentation.ts") {
    const stripped = text.replace(/process\.env\.NEXT_RUNTIME\b/g, "");
    if (ENV_READ.test(stripped)) envOffenders.push(`${file} (only process.env.NEXT_RUNTIME is permitted)`);
    ENV_READ.lastIndex = 0;
    continue;
  }
  envOffenders.push(file);
}
check("process.env is read only by lib/config/index.ts (+ NEXT_RUNTIME in instrumentation.ts)", envOffenders.length === 0, envOffenders.join(", "));
check("instrumentation.ts keeps exactly its NEXT_RUNTIME read", /process\.env\.NEXT_RUNTIME/.test(src.get("instrumentation.ts") ?? ""));

// 2. No NEXT_PUBLIC_* application authority.
const publicOffenders = [...src].filter(([f, t]) => t.includes("NEXT_PUBLIC_") && f !== "lib/config/parse.ts").map(([f]) => f);
check("no NEXT_PUBLIC_* in application source (only the refusal list in lib/config/parse.ts)", publicOffenders.length === 0, publicOffenders.join(", "));
check("lib/supabase/browser.ts (the unused NEXT_PUBLIC_* browser client) is gone", !existsSync(join(WEB, "lib/supabase/browser.ts")));
check("the M3.1 shims lib/env.ts / lib/envValidation.ts are gone", !existsSync(join(WEB, "lib/env.ts")) && !existsSync(join(WEB, "lib/envValidation.ts")));

// 3. Import graph (runtime imports only; `import type` is erased).
function importsOf(file, text) {
  const specs = [];
  const re = /(?:^|[^\w.])(?:import\s+(?!type\b)(?:[^'"`;]*?\s+from\s+)?|export\s+(?!type\b)[^'"`;]*?\s+from\s+|import\s*\(\s*|require\s*\(\s*)["'`]([^"'`]+)["'`]/gm;
  for (const m of text.matchAll(re)) specs.push(m[1]);
  const out = [];
  for (const s of specs) {
    let base = null;
    if (s.startsWith("@/")) base = join(WEB, s.slice(2));
    else if (s.startsWith("./") || s.startsWith("../")) base = resolve(dirname(join(WEB, file)), s);
    if (!base) continue;
    for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
      if (existsSync(c) && statSync(c).isFile()) { out.push(rel(c)); break; }
    }
  }
  return out;
}
const graph = new Map([...src].map(([f, t]) => [f, importsOf(f, t)]));
const SECRETS = "lib/config/secrets.ts";
const SECRET_IMPORTERS = [
  "lib/supabase/server.ts",
  "lib/safetyEmail/index.ts",
  "lib/email.ts",
  "app/api/internal/safety-notifications/dispatch/route.ts",
  // TEMPORARY legacy debt (founder Decision 2; removed with M6 legacy retirement):
  "lib/fastapi.ts",
  "app/api/auth/validate-bridge/route.ts",
  "app/api/internal/prescription-versions/route.ts",
  "app/api/internal/supervisor-patients-sync/route.ts",
];
const importers = [...graph].filter(([, deps]) => deps.includes(SECRETS)).map(([f]) => f).sort();
check("lib/config/secrets.ts importers are exactly the approved list", JSON.stringify(importers) === JSON.stringify([...SECRET_IMPORTERS].sort()), `actual: ${importers.join(", ")}`);
check("lib/config/secrets.ts is server-only", /^import "server-only";/m.test(src.get(SECRETS) ?? ""));

// A "use server" module imported from client code becomes an action
// reference: its code never reaches the client bundle, so a client walk
// stops there (server entries walk through everything).
const serverActionModules = new Set([...src].filter(([, t]) => /^\s*["']use server["'];?/.test(t)).map(([f]) => f));
function reaches(start, target, { client = false } = {}) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const f = stack.pop();
    if (f === target) return true;
    if (seen.has(f)) continue;
    seen.add(f);
    if (client && f !== start && serverActionModules.has(f)) continue;
    for (const d of graph.get(f) ?? []) stack.push(d);
  }
  return false;
}
for (const entry of ["proxy.ts", "instrumentation.ts", "instrumentation-node.ts", "next.config.ts"]) {
  check(`${entry} cannot reach the secret boundary (transitively)`, !reaches(entry, SECRETS));
}
const clientFiles = [...src].filter(([, t]) => /^\s*["']use client["'];?/.test(t)).map(([f]) => f);
const clientReach = clientFiles.filter((f) => reaches(f, SECRETS, { client: true }));
check(`no "use client" module reaches the secret boundary (${clientFiles.length} client modules)`, clientReach.length === 0, clientReach.join(", "));
const readiness = [...src.keys()].filter((f) => /app\/api\/ready\//.test(f));
check("readiness (when present) cannot reach the secret boundary", readiness.every((f) => !reaches(f, SECRETS)));

// 4. Raw reveal and the internal store accessor stay inside the boundary.
const revealOffenders = [...src].filter(([f, t]) => /\.reveal\s*\(/.test(t) && f !== SECRETS).map(([f]) => f);
check(".reveal() is called only inside lib/config/secrets.ts", revealOffenders.length === 0, revealOffenders.join(", "));
const storeOffenders = [...src].filter(([f, t]) => /\breadSecretStore\b/.test(t) && f !== SECRETS && f !== "lib/config/index.ts").map(([f]) => f);
check("readSecretStore is used only by lib/config/secrets.ts", storeOffenders.length === 0, storeOffenders.join(", "));
const rawBridge = [...src].filter(([, t]) => /[.[]\s*["'`]?BRIDGE_SECRET\b/.test(t)).map(([f]) => f).filter((f) => f !== "lib/config/parse.ts");
check("BRIDGE_SECRET is read only by the contract parser (no direct property reads anywhere else)", rawBridge.length === 0, rawBridge.join(", "));
const genericGetter = /export function (get|read)(Legacy)?Bridge(Secret|Credential)/.test(src.get(SECRETS) ?? "");
check("no raw bridge-secret getter exists in the secret boundary", !genericGetter);

// 5. The legacy bridge consumers keep their development-only gate.
for (const route of SECRET_IMPORTERS.filter((f) => f.startsWith("app/api/auth/validate-bridge") || f.startsWith("app/api/internal/prescription-versions") || f.startsWith("app/api/internal/supervisor-patients-sync"))) {
  const t = src.get(route) ?? "";
  const gate = t.indexOf("legacyRetiredResponse()");
  const verify = t.indexOf("verifyLegacyBridgeAuthorization(");
  check(`${route}: development-only gate (410 outside development) runs before the bridge check`, gate > 0 && verify > gate);
}
{
  const t = src.get("lib/fastapi.ts") ?? "";
  check("lib/fastapi.ts stays server-only and only uses the outbound bridge operation", /^import "server-only";/m.test(t) && /legacyBridgeAuthorizationHeader\(\)/.test(t) && !/verifyLegacyBridgeAuthorization/.test(t));
  const valueImporters = [...graph].filter(([, deps]) => deps.includes("lib/fastapi.ts")).map(([f]) => f).filter((f) => clientFiles.includes(f));
  check("client modules import lib/fastapi.ts for types only", valueImporters.length === 0, valueImporters.join(", "));
}

// ---------------------------------------------------------------- build output (optional)
const args = process.argv.slice(2);
if (args.includes("--build")) {
  const NEXT = join(WEB, ".next");
  const files = (dir) => existsSync(dir) ? walkAll(dir) : [];
  function walkAll(dir, out = []) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "cache") walkAll(p, out); } else out.push(p);
    }
    return out;
  }
  const staticBlob = Buffer.concat(files(join(NEXT, "static")).map((f) => readFileSync(f)));
  const serverBlob = Buffer.concat(files(join(NEXT, "server")).map((f) => readFileSync(f)));
  check(".next/static and .next/server present", staticBlob.length > 0 && serverBlob.length > 0);
  const SECRET_NAMES = ["SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY", "BRIDGE_SECRET", "SAFETY_DISPATCH_SECRET", "ANTHROPIC_API_KEY"];
  const named = SECRET_NAMES.filter((n) => staticBlob.includes(n));
  check("client bundle contains no secret variable names", named.length === 0, named.join(", "));
  const sIdx = args.indexOf("--sentinels");
  if (sIdx >= 0) {
    // { "VAR": "unique sentinel value", ... } — the values the build ran with.
    const sentinels = JSON.parse(readFileSync(args[sIdx + 1], "utf8"));
    for (const [k, v] of Object.entries(sentinels)) {
      const n = staticBlob.includes(v) || serverBlob.includes(v);
      check(`build froze no value of ${k} into .next/server or .next/static`, !n);
    }
  }
  // Values from the developer environment (counted, never printed).
  const envPath = join(WEB, ".env.local");
  if (existsSync(envPath)) {
    const env = {};
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#") && t.includes("=")) env[t.slice(0, t.indexOf("=")).trim()] = t.slice(t.indexOf("=") + 1).trim();
    }
    for (const k of ["SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY", "BRIDGE_SECRET", "SAFETY_DISPATCH_SECRET", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]) {
      const v = env[k];
      if (!v || v.length < 12) continue;
      check(`developer ${k} value appears in neither .next/static nor .next/server (count only)`, !staticBlob.includes(v) && !serverBlob.includes(v));
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
