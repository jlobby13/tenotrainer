// M3.3 S3c — TEST-ONLY Resend transport interceptor (a Node --import
// preload for test processes; never imported by application code).
//
// The Resend SDK sends with the global fetch. This preload replaces fetch
// BEFORE the application loads: any request to the Resend API is answered
// locally with a synthetic accepted response and recorded (method, path,
// recipients, sender — NEVER the Authorization header or key) as one JSON
// line in $RESEND_INTERCEPT_LOG. Nothing ever reaches api.resend.com, so a
// test that accidentally reaches a delivery path still cannot send mail,
// and a test can prove exactly how many provider calls were attempted.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const RESEND_HOSTS = new Set(["api.resend.com"]);
const LOG = process.env.RESEND_INTERCEPT_LOG || null;
const original = globalThis.fetch;

function record(entry) {
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
}

globalThis.fetch = async function interceptedFetch(input, init) {
  let url;
  try { url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url); } catch { url = null; }
  if (url && RESEND_HOSTS.has(url.hostname.toLowerCase())) {
    let body = null;
    try { body = JSON.parse(typeof init?.body === "string" ? init.body : ""); } catch { body = null; }
    const to = body ? [].concat(body.to ?? []) : [];
    record({ intercepted: true, method: init?.method ?? "GET", path: url.pathname, to, from: body?.from ?? null });
    return new Response(JSON.stringify({ id: `intercepted_${randomUUID()}` }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return original(input, init);
};
globalThis.__tenotrainerResendInterceptor = true;
