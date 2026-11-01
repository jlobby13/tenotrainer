// M3.3 S3d — public readiness (GET/HEAD /api/ready): is this instance
// correctly configured AND able to perform the minimal read-only anonymous
// database operation? Nothing more — never a diagnostic surface.
//
//   1. configuration validity (the centralized S3a contract — evaluated on
//      EVERY request, never cached: an invalid configuration can never be
//      answered from a previous success);
//   2. one anonymous PostgREST read with a 1.5 s timeout: canonical_exercises
//      (already anon-readable through its pre-existing "global read" RLS
//      policy, M3 C5 stage 2) filtered to the nil uuid, so it always returns
//      zero rows — no exercise, patient or safety data is read and no record
//      needs to exist, yet the query still runs through the anon role / RLS
//      in Postgres. GET only: no mutation is possible.
//
// The probe result (only) is cached per instance for 5 s, keyed by the
// configured Supabase identity, so aggressive probing cannot multiply
// database traffic. The public answer is exactly ready / unavailable; the
// reason is never exposed. No service role, no secrets, no email.
import type { AppConfig } from "./config/types";

export const READINESS_TIMEOUT_MS = 1500;
export const READINESS_CACHE_MS = 5000;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const PROBE_PATH = `/rest/v1/canonical_exercises?select=id&id=eq.${NIL_UUID}&limit=1`;

export type ReadinessDeps = {
  getConfig: () => AppConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (event: string) => void;
};

type CacheEntry = { key: string; at: number; ready: boolean };
let cache: CacheEntry | null = null;

// Test isolation only.
export function resetReadinessCache(): void {
  cache = null;
}

async function probe(config: AppConfig, fetchImpl: typeof fetch): Promise<boolean> {
  const { url, anonKey } = config.supabase;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(false); }, READINESS_TIMEOUT_MS);
  });
  const attempt = (async () => {
    const res = await fetchImpl(`${url}${PROBE_PATH}`, {
      method: "GET",
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (res.status !== 200) return false;
    const body: unknown = await res.json();
    return Array.isArray(body);
  })().catch(() => false);
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function checkReadiness(deps: ReadinessDeps): Promise<boolean> {
  const log = deps.log ?? (() => {});
  let config: AppConfig;
  try {
    config = deps.getConfig();
  } catch {
    log("tenotrainer.readiness.config_invalid");
    return false;
  }
  const now = (deps.now ?? Date.now)();
  const key = `${config.supabase.url}\u0000${config.supabase.anonKey}`;
  if (cache && cache.key === key && now - cache.at < READINESS_CACHE_MS) return cache.ready;
  const ready = await probe(config, deps.fetchImpl ?? fetch);
  cache = { key, at: (deps.now ?? Date.now)(), ready };
  if (!ready) log("tenotrainer.readiness.probe_failed");
  return ready;
}
