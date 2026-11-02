// M3.4a — shared argument handling for the deployment tools. Secrets are
// never accepted as arguments (unknown arguments are refused); the only
// secret, an optional Deployment Protection bypass, comes from the
// environment and is redacted from all output.
import { DeploymentToolError } from "./deploymentChecks.mjs";

const BYPASS_ENV = "TENOTRAINER_PROBE_PROTECTION_BYPASS";

export function parseToolArgs(argv, { values, flags }) {
  const out = { resolve: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--resolve") {
      const v = argv[++i] ?? "";
      const m = /^([a-z0-9.-]+)=([0-9.]+|\[[0-9a-f:]+\]):(\d{1,5})$/i.exec(v);
      if (!m) throw new DeploymentToolError("--resolve must be host=ip:port");
      out.resolve[m[1].toLowerCase()] = `${m[2]}:${m[3]}`;
    } else if (values.includes(a)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new DeploymentToolError(`${a} needs a value`);
      out[a.slice(2)] = argv[++i];
    } else if (flags.includes(a)) {
      out[a.slice(2)] = true;
    } else {
      throw new DeploymentToolError(`unknown argument ${JSON.stringify(a.slice(0, 40))}`);
    }
  }
  return out;
}

export function transportOptions(a) {
  const timeoutMs = a["timeout-ms"] ? Number(a["timeout-ms"]) : 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60000) throw new DeploymentToolError("--timeout-ms must be 500-60000");
  const bypass = process.env[BYPASS_ENV];
  return { timeoutMs, resolve: a.resolve, extraHeaders: bypass ? { "x-vercel-protection-bypass": bypass } : {} };
}

export function redactor() {
  const bypass = process.env[BYPASS_ENV];
  return (s) => (bypass && bypass.length >= 6 ? String(s).split(bypass).join("[redacted]") : String(s));
}
