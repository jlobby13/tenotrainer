// M3.3 S3d — readiness core (lib/readiness.ts) with stubbed transports and
// clock: probe semantics, timeout, cache, configuration failure, and no
// information disclosure.
import { checkReadiness, READINESS_CACHE_MS, READINESS_TIMEOUT_MS, resetReadinessCache } from "../readiness";
import { ConfigError } from "../config/parse";
import type { AppConfig } from "../config/types";

let pass = 0;
let fail = 0;
async function test(name: string, fn: () => Promise<void>) {
  resetReadinessCache();
  try {
    await fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const config = (url = "https://kpdxlzqtvueiytwjamiw.supabase.co", anonKey = "anon-key-A"): AppConfig => ({
  mode: "production", isolatedTestProfile: false, appOrigin: "https://app.example.com",
  supabase: { url, anonKey, kind: "hosted", ref: "kpdxlzqtvueiytwjamiw" }, runtimeGate: true, publishGate: false,
  email: { provider: "resend", from: "n@x.org" }, safetyDispatchConfigured: true, platform: { isDevServer: false, onVercel: false }, warnings: [],
});
type Call = { url: string; method: string; headers: Record<string, string> };
function stub(respond: (call: Call, signal: AbortSignal | undefined) => Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()) };
    calls.push(call);
    return respond(call, init?.signal ?? undefined);
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

await test("valid configuration + successful anon probe -> ready", async () => {
  const s = stub(async () => json([]));
  assert(await checkReadiness({ getConfig: () => config(), fetchImpl: s.fetchImpl }), "ready");
});
await test("probe is ONE read-only anonymous GET: nil-uuid filter (zero rows), anon key only, no service role", async () => {
  const s = stub(async () => json([]));
  await checkReadiness({ getConfig: () => config(), fetchImpl: s.fetchImpl });
  const c = s.calls[0];
  assert(s.calls.length === 1 && c.method === "GET", JSON.stringify(s.calls));
  assert(c.url === "https://kpdxlzqtvueiytwjamiw.supabase.co/rest/v1/canonical_exercises?select=id&id=eq.00000000-0000-0000-0000-000000000000&limit=1", c.url);
  assert(c.headers.apikey === "anon-key-A" && c.headers.authorization === "Bearer anon-key-A", JSON.stringify(c.headers));
  assert(!JSON.stringify(c).toLowerCase().includes("service"), "no service role anywhere");
});
await test("zero-row success is ready (does not depend on any record existing)", async () => {
  const s = stub(async () => json([]));
  assert(await checkReadiness({ getConfig: () => config(), fetchImpl: s.fetchImpl }), "zero rows");
});
await test("connection failure -> unavailable", async () => {
  const s = stub(async () => { throw new TypeError("fetch failed: connect ECONNREFUSED 10.0.0.5:5432 SENTINEL-NET"); });
  assert(!(await checkReadiness({ getConfig: () => config(), fetchImpl: s.fetchImpl })), "unavailable");
});
await test("database / PostgREST errors -> unavailable (500, 401, 404, non-array body)", async () => {
  for (const r of [json({ message: "relation SENTINEL does not exist" }, 500), json({ message: "Invalid API key" }, 401), json({}, 404), json({ not: "an array" }, 200), new Response("<html>bad gateway</html>", { status: 502 })]) {
    resetReadinessCache();
    const s = stub(async () => r);
    assert(!(await checkReadiness({ getConfig: () => config(), fetchImpl: s.fetchImpl })), String(r.status));
  }
});
await test(`timeout (> ${READINESS_TIMEOUT_MS} ms) -> unavailable, bounded, and the request is aborted`, async () => {
  let aborted = false;
  const s = stub((_c, signal) => new Promise<Response>((resolve) => {
    signal?.addEventListener("abort", () => { aborted = true; });
    setTimeout(() => resolve(json([])), 4000);
  }));
  const t0 = Date.now();
  const ready = await checkReadiness({ getConfig: () => config(), fetchImpl: s.fetchImpl });
  const took = Date.now() - t0;
  assert(!ready && aborted && took >= READINESS_TIMEOUT_MS - 50 && took < READINESS_TIMEOUT_MS + 700, `ready=${ready} aborted=${aborted} took=${took}`);
});
await test("invalid configuration -> unavailable, and the database is never contacted", async () => {
  const s = stub(async () => json([]));
  const ready = await checkReadiness({ getConfig: () => { throw new ConfigError(["SUPABASE_URL: is required"]); }, fetchImpl: s.fetchImpl });
  assert(!ready && s.calls.length === 0, `${ready} ${s.calls.length}`);
});
await test(`cache: repeated checks within ${READINESS_CACHE_MS} ms reuse ONE probe`, async () => {
  let t = 1_000_000;
  const s = stub(async () => json([]));
  for (let i = 0; i < 5; i++) { assert(await checkReadiness({ getConfig: () => config(), fetchImpl: s.fetchImpl, now: () => t }), "ready"); t += 900; }
  assert(s.calls.length === 1, String(s.calls.length));
});
await test("cache: expires after the window and probes again", async () => {
  let t = 2_000_000;
  const s = stub(async () => json([]));
  await checkReadiness({ getConfig: () => config(), fetchImpl: s.fetchImpl, now: () => t });
  t += READINESS_CACHE_MS + 1;
  await checkReadiness({ getConfig: () => config(), fetchImpl: s.fetchImpl, now: () => t });
  assert(s.calls.length === 2, String(s.calls.length));
});
await test("cache: a failed probe is also reused only within the window (never a long-lived signal)", async () => {
  let t = 3_000_000;
  let ok = false;
  const s = stub(async () => (ok ? json([]) : json({}, 500)));
  assert(!(await checkReadiness({ getConfig: () => config(), fetchImpl: s.fetchImpl, now: () => t })), "fail");
  ok = true;
  t += 1000;
  assert(!(await checkReadiness({ getConfig: () => config(), fetchImpl: s.fetchImpl, now: () => t })), "cached fail inside window");
  t += READINESS_CACHE_MS;
  assert(await checkReadiness({ getConfig: () => config(), fetchImpl: s.fetchImpl, now: () => t }), "recovers after window");
});
await test("cache never hides an invalid configuration: success, then an invalid config context -> unavailable", async () => {
  let t = 4_000_000;
  const s = stub(async () => json([]));
  assert(await checkReadiness({ getConfig: () => config(), fetchImpl: s.fetchImpl, now: () => t }), "ready first");
  t += 100;
  assert(!(await checkReadiness({ getConfig: () => { throw new ConfigError(["TENOTRAINER_MODE: is required"]); }, fetchImpl: s.fetchImpl, now: () => t })), "invalid config inside the window");
});
await test("cache is keyed by the configured Supabase identity: another project / key re-probes", async () => {
  let t = 5_000_000;
  const s = stub(async (c) => (c.url.includes("bbbbbbbbbbbbbbbbbbbb") ? json({}, 500) : json([])));
  assert(await checkReadiness({ getConfig: () => config(), fetchImpl: s.fetchImpl, now: () => t }), "A ready");
  t += 100;
  assert(!(await checkReadiness({ getConfig: () => config("https://bbbbbbbbbbbbbbbbbbbb.supabase.co"), fetchImpl: s.fetchImpl, now: () => t })), "B probed, not served from A");
  assert(s.calls.length === 2, String(s.calls.length));
});
await test("no failure detail leaks into the log events (fixed event names only)", async () => {
  const events: string[] = [];
  const s = stub(async () => json({ message: "SENTINEL-relation SENTINEL-https://x.supabase.co re_SENTINELKEY stack-SENTINEL" }, 500));
  await checkReadiness({ getConfig: () => config(), fetchImpl: s.fetchImpl, log: (e) => events.push(e) });
  assert(events.length === 1 && events[0] === "tenotrainer.readiness.probe_failed", JSON.stringify(events));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
