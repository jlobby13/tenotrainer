// M3.1 — test-only resolve hook for m3MaintenanceLibraryProbe.mjs: replaces
// Next's navigation/cache modules (which need the Next runtime) with inert
// stubs, so the clinical libraries can be imported in plain Node. Never
// imported by application code.
// M3.3 S3 — inert Supabase clients: every query, RPC or auth call resolves
// to a connection error and nothing ever reaches the network (the probe's
// no-write guarantee no longer depends on an unreachable URL, which the
// centralized contract refuses in maintenance/production).
// D1 — every client construction is counted on globalThis
// (__probeSupabaseClients) so a probe can prove a refusal happened first.
const INERT_SUPABASE = `
const failure = { data: null, error: { message: "probe: Supabase network access is disabled", code: "PROBE_NO_NETWORK" }, count: null, status: 0 };
function chain() {
  const fn = function () { return proxy; };
  const proxy = new Proxy(fn, {
    get(_t, prop) {
      if (prop === "then") return (resolve) => resolve(failure);
      return proxy;
    },
    apply() { return proxy; },
  });
  return proxy;
}
const counted = () => { globalThis.__probeSupabaseClients = (globalThis.__probeSupabaseClients ?? 0) + 1; return chain(); };
export function createServerClient() { return counted(); }
export function createBrowserClient() { return counted(); }
export function createClient() { return counted(); }
`;
const STUBS = {
  "next/navigation": "export function redirect(u){throw new Error('redirect:'+u)} export function notFound(){throw new Error('notFound')}",
  "next/cache": "export function revalidatePath(){} export function revalidateTag(){}",
  "@supabase/ssr": INERT_SUPABASE,
  "@supabase/supabase-js": INERT_SUPABASE,
};
export async function resolve(specifier, context, nextResolve) {
  const key = specifier.replace(/\.js$/, "");
  if (key in STUBS) return { url: `data:text/javascript,${encodeURIComponent(STUBS[key])}`, shortCircuit: true };
  return nextResolve(specifier, context);
}
