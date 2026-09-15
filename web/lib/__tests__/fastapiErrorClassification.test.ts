// Patient FastAPI failure UX repair — classification tests for
// bridgeFetch()'s two failure shapes (see lib/fastapi.ts). A transport-level
// failure (fetch() itself throws — connection refused, DNS failure, etc.)
// must become a BackendUnavailableError; a reached-but-non-2xx response
// must become a BackendApplicationError carrying its status. Neither error's
// message may leak the underlying URL/port/body — that detail is logged via
// console.error only (asserted below via a captured mock), never thrown.
//
// lib/fastapi.ts imports "server-only", which throws under Node's default
// export condition — run with the "react-server" condition active so
// "server-only" resolves to its no-op branch instead:
//   NODE_OPTIONS="--conditions=react-server" npx tsx lib/__tests__/fastapiErrorClassification.test.ts
import { getPatientSummary, BackendUnavailableError, BackendApplicationError } from "../fastapi";

let pass = 0;
let fail = 0;
async function test(name: string, fn: () => Promise<void>) {
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

const originalFetch = global.fetch;
const originalConsoleError = console.error;

function withMockedFetch<T>(impl: typeof global.fetch, fn: () => Promise<T>): Promise<T> {
  global.fetch = impl as typeof global.fetch;
  return fn().finally(() => {
    global.fetch = originalFetch;
  });
}

function withCapturedConsoleError<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; logs: unknown[][] }> {
  const logs: unknown[][] = [];
  console.error = (...args: unknown[]) => logs.push(args);
  return fn()
    .then((result) => ({ result, logs }))
    .catch((error) => ({ error, logs }))
    .finally(() => {
      console.error = originalConsoleError;
    });
}

async function main() {
  await test("transport-level fetch failure becomes BackendUnavailableError", async () => {
    const { error, logs } = await withCapturedConsoleError(() =>
      withMockedFetch(
        async () => {
          throw new TypeError("fetch failed");
        },
        () => getPatientSummary("patient@example.com")
      )
    );
    assert(error instanceof BackendUnavailableError, `expected BackendUnavailableError, got ${error}`);
    assert(
      !(error as Error).message.includes("localhost") && !(error as Error).message.includes("8000"),
      "thrown error message must never leak the backend URL/port"
    );
    assert(logs.length === 1, "the raw transport error must be logged server-side exactly once");
  });

  await test("a reached-but-404 response becomes BackendApplicationError with the real status, never mislabeled as unavailable", async () => {
    const { error, logs } = await withCapturedConsoleError(() =>
      withMockedFetch(
        async () =>
          new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: { "content-type": "application/json" } }),
        () => getPatientSummary("unknown@example.com")
      )
    );
    assert(error instanceof BackendApplicationError, `expected BackendApplicationError, got ${error}`);
    assert((error as BackendApplicationError).status === 404, `expected status 404, got ${(error as BackendApplicationError).status}`);
    assert(!(error instanceof BackendUnavailableError), "a structured application error must never be classified as backend-unavailable");
    assert(
      !(error as Error).message.includes("User not found") && !(error as Error).message.includes("localhost"),
      "thrown error message must never leak the raw backend response body or URL"
    );
    assert(logs.length === 1, "the raw application-error response body must be logged server-side exactly once");
  });

  await test("a 401 (e.g. bridge-secret mismatch) is also BackendApplicationError, never BackendUnavailableError", async () => {
    const { error } = await withCapturedConsoleError(() =>
      withMockedFetch(
        async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
        () => getPatientSummary("patient@example.com")
      )
    );
    assert(error instanceof BackendApplicationError, `expected BackendApplicationError, got ${error}`);
    assert((error as BackendApplicationError).status === 401, "status must be preserved");
  });

  await test("a healthy 200 response resolves normally with no error thrown", async () => {
    const fakeSummary = {
      user: { id: 1, name: "Test Patient", email: "patient@example.com" },
      has_plan: true,
      has_onboarding: true,
      current_plan: { id: 1, stage: 1, irritability: "low", decision: "STAY", created_at: "2026-01-01" },
      current_stage: 1,
      current_irritability: "low",
      session_plan: [],
      today_logged: false,
      recent_logs: [],
      previous_performance: {},
    };
    const { result, error } = await withCapturedConsoleError(() =>
      withMockedFetch(
        async () => new Response(JSON.stringify(fakeSummary), { status: 200, headers: { "content-type": "application/json" } }),
        () => getPatientSummary("patient@example.com")
      )
    );
    assert(error === undefined, `expected no error, got ${error}`);
    assert(JSON.stringify(result) === JSON.stringify(fakeSummary), "healthy response must be returned unchanged");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main();
