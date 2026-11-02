// M3.4a — pre-promotion readiness gate (operator / CI). Checks exactly ONE
// explicit origin: GET and HEAD /api/ready must answer 200 with exactly
// {"status":"ready"} and Cache-Control no-store. Redirects are never
// followed and fail the gate; timeouts, 401/403, 503 and malformed
// responses fail it. See docs/m3-deployment-readiness.md.
//
//   node scripts/readinessGate.mjs --origin https://<deployment-host> \
//     [--timeout-ms 10000] [--attempts 3] [--resolve host=ip:port] [--json]
//
// Optional: TENOTRAINER_PROBE_PROTECTION_BYPASS (environment only) is sent
// as x-vercel-protection-bypass for a protected deployment; never printed.
// Exit: 0 ready, 1 not ready / refused, 2 usage error.
import { DeploymentToolError, networkTransport, parseOrigin, readinessGate } from "./lib/deploymentChecks.mjs";
import { parseToolArgs, redactor, transportOptions } from "./lib/deploymentCli.mjs";

const redact = redactor();
try {
  const a = parseToolArgs(process.argv.slice(2), { values: ["--origin", "--timeout-ms", "--attempts"], flags: ["--json", "--allow-loopback-http"] });
  if (!a.origin) throw new DeploymentToolError("--origin <scheme://host[:port]> is required");
  const origin = parseOrigin(a.origin, { allowLoopbackHttp: !!a["allow-loopback-http"], label: "--origin" });
  const attempts = a.attempts ? Number(a.attempts) : 3;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) throw new DeploymentToolError("--attempts must be 1-10");
  const r = await readinessGate(origin, { transport: networkTransport(transportOptions(a)), attempts });
  if (a.json) console.log(redact(JSON.stringify(r)));
  else {
    for (const l of r.log) console.log(redact(`${l.ok ? "ok  " : "fail"}  attempt ${l.attempt} ${l.method} ${r.url}${l.reason ? ` — ${l.reason}` : ""}`));
    console.log(redact(`READINESS GATE: ${r.ok ? "PASS" : "FAIL"} — ${r.origin} (${r.reason})`));
  }
  process.exitCode = r.ok ? 0 : 1;
} catch (e) {
  console.log(redact(`READINESS GATE: usage error — ${e instanceof DeploymentToolError ? e.message : e?.message}`));
  process.exitCode = 2;
}
