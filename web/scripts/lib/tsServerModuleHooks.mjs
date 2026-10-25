// Node module-resolution hooks that let a verification script import the
// app's REAL server modules (web/lib/*.ts) in-process, under
// `node --conditions=react-server --experimental-strip-types`:
//   - "@/x"  -> web/x(.ts|.tsx|/index.ts)   (the tsconfig path alias)
//   - extensionless relative imports from .ts files -> the .ts file
//   - extensionless CommonJS package subpaths ("next/headers") -> ".js"
// The react-server condition makes the `server-only` guard a no-op exactly
// as it is inside Next's server runtime. Test infrastructure only — never
// imported by application code.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

const WEB_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const EXTS = [".ts", ".tsx", "/index.ts"];

function tryTs(base) {
  if (existsSync(base) && !base.endsWith("/")) {
    if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(base)) return base;
  }
  for (const ext of EXTS) if (existsSync(base + ext)) return base + ext;
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const hit = tryTs(join(WEB_ROOT, specifier.slice(2)));
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.endsWith(".ts")) {
    const hit = tryTs(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier));
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // CommonJS package subpaths without an exports map (e.g. "next/headers")
    // need their file extension under ESM resolution.
    if (err?.code === "ERR_MODULE_NOT_FOUND" && !specifier.startsWith(".") && !/\.[cm]?js$/.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }
    throw err;
  }
}
