// M3.4a — post-deployment canonical-origin / forwarded-host probe (M3.4e).
// Operator-supplied origins only; nothing is hard-coded. Read-only: GET /
// HEAD of public pages and readiness, and POSTs to /api/ready (no POST
// handler; refused or 405). Reports PASS / FAIL / OBSERVATION (founder
// review) / MANUAL. It never changes canonical-host behaviour: a result
// calling for Host-only comparison is reported for a separately reviewed
// change. See docs/m3-deployment-readiness.md.
//
//   node scripts/deploymentProbe.mjs --canonical-origin https://<canonical> \
//     --deployment-origin https://<deployment-url> [--timeout-ms 10000] \
//     [--resolve host=ip:port] [--json]
//
// Optional: TENOTRAINER_PROBE_PROTECTION_BYPASS (environment only).
// Exit: 0 all PASS (MANUAL allowed), 1 any FAIL, 2 OBSERVATION only, 3 usage error.
import { DeploymentToolError, deploymentProbe, networkTransport, parseOrigin } from "./lib/deploymentChecks.mjs";
import { parseToolArgs, redactor, transportOptions } from "./lib/deploymentCli.mjs";

const redact = redactor();
try {
  const a = parseToolArgs(process.argv.slice(2), { values: ["--canonical-origin", "--deployment-origin", "--timeout-ms"], flags: ["--json", "--allow-loopback-http"] });
  if (!a["canonical-origin"] || !a["deployment-origin"]) throw new DeploymentToolError("--canonical-origin and --deployment-origin are both required");
  const allow = !!a["allow-loopback-http"];
  const canonicalOrigin = parseOrigin(a["canonical-origin"], { allowLoopbackHttp: allow, label: "--canonical-origin" });
  const deploymentOrigin = parseOrigin(a["deployment-origin"], { allowLoopbackHttp: allow, label: "--deployment-origin" });
  const report = await deploymentProbe({ canonicalOrigin, deploymentOrigin, transport: networkTransport(transportOptions(a)) });
  if (a.json) console.log(redact(JSON.stringify(report)));
  else {
    for (const r of report.results) console.log(redact(`${r.status.padEnd(11)} [${r.id}] ${r.title} — ${r.detail}${r.note ? `\n            note: ${r.note}` : ""}`));
    console.log(redact(`DEPLOYMENT PROBE: ${report.verdict} (${Object.entries(report.counts).map(([k, v]) => `${k} ${v}`).join(", ")})${report.hostOnlyReview ? " — Host-only review required" : ""}`));
  }
  process.exitCode = { PASS: 0, FAIL: 1, OBSERVATION: 2 }[report.verdict];
} catch (e) {
  console.log(redact(`DEPLOYMENT PROBE: usage error — ${e instanceof DeploymentToolError ? e.message : e?.message}`));
  process.exitCode = 3;
}
