// M3.4g — static guards for the enforced Content-Security-Policy (no
// database, no network, no server). The policy (lib/securityHeaders.ts)
// allows only same-origin resources and nonce'd scripts/styles; these
// checks fail on application code that would need it loosened:
//
//   1. inline style attributes: a React `style` prop is server-rendered as
//      style="…", which style-src without 'unsafe-inline' blocks. The only
//      permitted `style` props are listed below, and each may hold only
//      values that are undefined at rest (applied in the browser through
//      the CSSOM, which the CSP allows);
//   2. dangerouslySetInnerHTML;
//   3. next/script / next/head, and raw <script>, <style>, <link>,
//      <iframe>, <object>, <embed>, <base> elements in JSX;
//   4. eval / new Function (no 'unsafe-eval' outside `next dev`);
//   5. external resource origins: absolute or protocol-relative URLs in
//      browser-reachable code (app/, lib/*.tsx, globals.css), CSS @import /
//      url() of anything but the Tailwind entry, fonts other than next/font;
//   6. the policy itself: no unsafe-inline / unsafe-eval / wildcard /
//      scheme or host sources in production, maintenance or a production
//      build in development mode.
//
// Run from web/:  node --experimental-strip-types scripts/verifyCspStaticGuards.test.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { buildContentSecurityPolicy } from "../lib/securityHeaders.ts";

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? `\n      ${String(detail).slice(0, 800)}` : ""}`); }
};

const ROOT = process.cwd();
function walk(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".next" || name === "__tests__") continue;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}
const rel = (p) => relative(ROOT, p);
const read = (p) => readFileSync(p, "utf8");
// Line-oriented scan with the line's own // comment removed (URLs and
// examples in comments are documentation, not dependencies).
function scan(files, re, { skipComments = true } = {}) {
  const hits = [];
  for (const f of files) {
    read(f).split("\n").forEach((line, i) => {
      const code = skipComments ? line.replace(/(^|[^:"'`])\/\/.*$/, "$1").replace(/^\s*\*.*$/, "").replace(/\/\*.*?\*\//g, "") : line;
      if (re.test(code)) hits.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  return hits;
}

const appCode = walk(join(ROOT, "app"), [".ts", ".tsx"]);
const appTsx = appCode.filter((f) => f.endsWith(".tsx"));
const libCode = walk(join(ROOT, "lib"), [".ts", ".tsx"]);
const libTsx = libCode.filter((f) => f.endsWith(".tsx"));
const browserReachable = [...appCode, ...libTsx];
const allCode = [...appCode, ...libCode, join(ROOT, "proxy.ts")];
const css = walk(join(ROOT, "app"), [".css"]);

console.log(`--- scope: ${appCode.length} app files, ${libCode.length} lib files, ${css.length} stylesheets ---`);
check("the scan found the application", appCode.length > 50 && css.length >= 1);

console.log("--- 1. inline style attributes ---");
// Each permitted `style` prop: file and why it is safe under the policy.
const STYLE_PROP_ALLOWED = {
  "app/clinician/patients/[id]/prescription/builder/DraftPanel.tsx": "dnd-kit drag transform; every value undefined at rest",
};
const styleHits = scan([...appTsx, ...libTsx], /\bstyle=\{/);
const unexpectedStyle = styleHits.filter((h) => !Object.keys(STYLE_PROP_ALLOWED).some((f) => h.startsWith(`${f}:`)));
check("no React style props outside the reviewed list", unexpectedStyle.length === 0, unexpectedStyle.join("\n"));
for (const f of Object.keys(STYLE_PROP_ALLOWED)) {
  const src = read(join(ROOT, f));
  const block = src.match(/const style: React\.CSSProperties = \{([\s\S]*?)\n\s*\};/);
  const entries = block ? block[1].split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//")) : [];
  const staticEntries = entries.filter((l) => !/\?[^:]+:\s*undefined,?$/.test(l));
  check(`${f}: the style object exists and every value is conditional (undefined at rest → no server-rendered style attribute)`,
    !!block && entries.length > 0 && staticEntries.length === 0, staticEntries.join(" | ") || "style object not found");
}

console.log("--- 2–4. inline HTML, scripts, eval ---");
check("no dangerouslySetInnerHTML", scan(allCode, /dangerouslySetInnerHTML/).length === 0, scan(allCode, /dangerouslySetInnerHTML/).join("\n"));
check("no next/script or next/head", scan(allCode, /from\s+["']next\/(script|head)["']/).length === 0, scan(allCode, /from\s+["']next\/(script|head)["']/).join("\n"));
const rawElements = scan([...appTsx, ...libTsx], /<(script|style|link|iframe|object|embed|base)[\s>/]/);
check("no raw <script>/<style>/<link>/<iframe>/<object>/<embed>/<base> in JSX", rawElements.length === 0, rawElements.join("\n"));
const evals = scan(allCode, /(^|[^.\w])eval\s*\(|new\s+Function\s*\(/);
check("no eval() or new Function() (no 'unsafe-eval' in production)", evals.length === 0, evals.join("\n"));

console.log("--- 5. external resources ---");
const urls = scan(browserReachable, /(["'`(=]\s*)(https?:)?\/\/[a-z0-9-]+(\.[a-z0-9-]+)+/i);
check("no absolute or protocol-relative URLs in browser-reachable code (app/, lib/*.tsx)", urls.length === 0, urls.join("\n"));
for (const f of css) {
  const src = read(f);
  const imports = [...src.matchAll(/@import\s+([^;]+);/g)].map((m) => m[1].trim());
  check(`${rel(f)}: the only @import is the Tailwind entry`, imports.every((i) => i === '"tailwindcss"'), imports.join(", "));
  const cssUrls = [...src.matchAll(/url\(\s*["']?([^"')]+)/g)].map((m) => m[1]).filter((u) => /^(https?:)?\/\//i.test(u) || /^data:/i.test(u));
  check(`${rel(f)}: no external or data: url() references`, cssUrls.length === 0, cssUrls.join(", "));
}
const fontImports = scan(allCode, /from\s+["'](@fontsource|next\/font\/[a-z]+)/).filter((h) => !/next\/font\/(google|local)/.test(h));
check("fonts only through next/font (self-hosted at build time)", fontImports.length === 0, fontImports.join("\n"));

console.log("--- 6. the policy itself ---");
for (const [mode, devServer] of [["production", false], ["maintenance", false], ["development", false]]) {
  const csp = buildContentSecurityPolicy("bm9uY2Vub25jZW5vbmNlMQ==", mode, devServer);
  const sources = csp.split(";").flatMap((d) => d.trim().split(/\s+/).slice(1));
  const bad = sources.filter((s) => /unsafe|^\*|^https?:|^data:|^blob:|^\w[\w.-]*\.\w+/.test(s));
  check(`${mode}${mode === "development" ? " (production build)" : ""}: only 'self' / 'none' / nonce / 'strict-dynamic' sources`, bad.length === 0, bad.join(" "));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
