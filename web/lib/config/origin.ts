// M3.3 S3 — canonical application origin primitives. Pure: no I/O.
//
// The canonical origin is configuration (TENOTRAINER_APP_ORIGIN), never
// derived from a request. Every generated absolute application URL is
// built from it with absoluteUrl().

export type OriginParse =
  | { ok: true; origin: string; protocol: "http:" | "https:"; hostname: string }
  | { ok: false; rule: string };

const EXACT_ORIGIN_RULE =
  "must be an exact origin: scheme://host[:port] with no path, trailing slash, query, fragment, user info or explicit default port";

export function parseOrigin(raw: string): OriginParse {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, rule: "must be an absolute http(s) origin" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, rule: "must be an absolute http(s) origin" };
  // URL.origin drops path, query, fragment and user info and normalizes
  // case and default ports: anything that differs was not an exact origin.
  if (url.origin !== raw) return { ok: false, rule: EXACT_ORIGIN_RULE };
  return { ok: true, origin: url.origin, protocol: url.protocol, hostname: url.hostname };
}

// Loopback / unspecified hosts that can never be a public application origin.
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    /^127(\.\d{1,3}){3}$/.test(h) ||
    h === "0.0.0.0" ||
    h === "[::1]" ||
    h === "[::]"
  );
}

// Whether a hostname lies under one of the given top-level domains
// (RFC 6761 reserved names such as "test" can never resolve publicly).
export function isUnderTld(hostname: string, tlds: readonly string[]): boolean {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".");
  return labels.length > 0 && tlds.includes(labels[labels.length - 1]);
}

// An absolute application URL on the configured canonical origin. `path`
// must be an internal path (starting with exactly one "/").
export function absoluteUrl(origin: string, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("absoluteUrl: path must be an internal path");
  return `${origin}${path}`;
}

// ---------------------------------------------------------------- M3.3 S3b — canonical host / redirects

// The host the request was addressed to, OBSERVED only for comparison with
// the configured canonical host: the first X-Forwarded-Host value when
// present (the platform proxy's view of the public host — the assumption
// M3.4 must verify on a real deployment), otherwise Host. Never used to
// build a URL.
export function observedRequestHost(forwardedHost: string | null, host: string | null): string | null {
  const first = (v: string | null) => {
    const f = v?.split(",")[0]?.trim().toLowerCase();
    return f ? f : null;
  };
  return first(forwardedHost) ?? first(host);
}

// The host (name plus any non-default port) of a canonical origin, exactly
// as it appears in a Host header for that origin.
export function originHost(origin: string): string {
  return new URL(origin).host;
}

// The base origin for a redirect answering a request: in production and
// maintenance ALWAYS the configured canonical origin; in development the
// request's own origin, so localhost, 127.0.0.1 and spawned test ports
// redirect back to themselves.
export function redirectBase(config: { mode: string; appOrigin: string }, requestUrl: string): string {
  return config.mode === "development" ? new URL(requestUrl).origin : config.appOrigin;
}
