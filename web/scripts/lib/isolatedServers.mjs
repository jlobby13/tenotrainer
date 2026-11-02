// M3.4a — isolated `next start` servers for verification suites (test
// infrastructure). A suite starts servers only on ports nobody is listening
// on (an occupied port is refused, never killed), runs each in its own
// process group, and stops only the groups it started. Never :3000 / :8000.
//
// The developer .env.local is still loaded by Next itself, so every
// mode-relevant key is set explicitly (an empty string counts as unset and
// overrides .env.local); see verifyM3OperatingModes.mjs for the rationale.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { withEmailContainment, withoutRetiredNames } from "./harnessEnv.mjs";

const PROTECTED_PORTS = new Set([3000, 8000]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Production / maintenance under the isolated test profile: reserved .test
// canonical origin, inert email credentials (the Resend transport is
// intercepted by withEmailContainment; nothing is ever sent).
export function productionProfile(canonicalOrigin, extra = {}) {
  return {
    TENOTRAINER_MODE: "production", TENOTRAINER_APP_ORIGIN: canonicalOrigin, FASTAPI_URL: "", BRIDGE_SECRET: "",
    C5_PATIENT_RUNTIME_ENABLED: "true", C5_PRESCRIPTION_PUBLISH_ENABLED: "false",
    TENOTRAINER_EMAIL_PROVIDER: "resend", SAFETY_DISPATCH_SECRET: `m34a-${randomUUID()}-${randomUUID()}`,
    RESEND_API_KEY: "re_isolated_never_called", TENOTRAINER_NOTIFICATION_EMAIL_FROM: "TenoTrainer <safety@tenotrainer.test>",
    ...extra,
  };
}

function serverEnv(overrides) {
  const base = withoutRetiredNames({ ...process.env });
  for (const k of ["FASTAPI_URL", "BRIDGE_SECRET", "TENOTRAINER_APP_ORIGIN", "VERCEL", "VERCEL_ENV"]) delete base[k];
  for (const k of ["TENOTRAINER_MODE", "C5_PATIENT_RUNTIME_ENABLED", "C5_PRESCRIPTION_PUBLISH_ENABLED", "TENOTRAINER_EMAIL_PROVIDER", "SAFETY_DISPATCH_SECRET",
    "RESEND_API_KEY", "TENOTRAINER_NOTIFICATION_EMAIL_FROM", "TENOTRAINER_DEV_EMAIL_RECIPIENTS", "SAFETY_FAKE_PROVIDER_LOG", "SAFETY_FAKE_PROVIDER_SCRIPT"]) base[k] = "";
  return { ...base, ...overrides };
}

export async function listening(port) {
  try {
    await globalThis.fetch(`http://127.0.0.1:${port}/login`, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

export class IsolatedServers {
  constructor() {
    this.started = [];
  }

  async start(port, overrides) {
    if (PROTECTED_PORTS.has(port)) throw new Error(`port ${port} is reserved for the accepted development servers`);
    if (await listening(port)) throw new Error(`port ${port} is already in use — refusing to touch a server this suite did not start`);
    const proc = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
      env: withEmailContainment(serverEnv(overrides)), detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const s = { port, proc, pid: proc.pid, log: "", exited: null };
    proc.stdout.on("data", (d) => (s.log += d));
    proc.stderr.on("data", (d) => (s.log += d));
    proc.on("exit", (code) => (s.exited = code ?? -1));
    this.started.push(s);
    for (let i = 0; i < 120; i++) {
      if (s.exited !== null) throw new Error(`server on ${port} exited (${s.exited}):\n${s.log.slice(-1500)}`);
      if (await listening(port)) return s;
      await sleep(500);
    }
    throw new Error(`server on ${port} did not become ready`);
  }

  async stop(s) {
    if (s.exited !== null) return;
    try { process.kill(-s.pid, "SIGTERM"); } catch { /* gone */ }
    for (let i = 0; i < 40 && s.exited === null; i++) await sleep(250);
    if (s.exited === null) { try { process.kill(-s.pid, "SIGKILL"); } catch { /* gone */ } }
    for (let i = 0; i < 40 && (await listening(s.port)); i++) await sleep(250);
  }

  async stopAll() {
    for (const s of this.started) await this.stop(s);
  }
}
