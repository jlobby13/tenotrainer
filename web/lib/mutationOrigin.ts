// M3.3 S2 — the cross-origin mutation boundary (CSRF), applied by the proxy
// to every non-safe request: Route Handlers, Server Actions and the
// internal endpoints alike. Pure, so it is unit-tested directly.
//
// Algorithm (the same shape as Go's net/http CrossOriginProtection and
// Next's own Server Action check):
//   1. GET / HEAD / OPTIONS are not mutations.
//   2. Sec-Fetch-Site (sent by every modern browser): "same-origin" or
//      "none" (user-initiated) continue; "same-site" / "cross-site" and any
//      unknown value are refused.
//   3. Origin, when present, must be a well-formed http(s) origin whose
//      host equals the request's own host. "null", malformed values or
//      several values are refused.
//   4. Neither header: not a browser (curl, server-to-server). No ambient
//      browser credentials can be forged that way, so it continues to the
//      route's own authentication (session, or the dispatch secret).
//
// The expected host is the forwarded host (the platform's proxy) or Host,
// exactly what Next compares for Server Actions. S3 centralizes the
// validated application URL; this check then also accepts that one origin
// (and should compare scheme as well) — see expectedHosts.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const FETCH_SITES = new Set(["same-origin", "same-site", "cross-site", "none"]);

export type MutationOriginInput = {
  method: string;
  origin: string | null;
  secFetchSite: string | null;
  host: string | null;
  forwardedHost: string | null;
};

export type MutationOriginVerdict = { allowed: true } | { allowed: false; reason: string };

function firstValue(v: string | null): string | null {
  if (v === null) return null;
  const first = v.split(",")[0]?.trim().toLowerCase();
  return first ? first : null;
}

export function checkMutationOrigin(input: MutationOriginInput): MutationOriginVerdict {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { allowed: true };

  const site = input.secFetchSite?.trim().toLowerCase() ?? null;
  if (site !== null) {
    if (!FETCH_SITES.has(site)) return { allowed: false, reason: "malformed Sec-Fetch-Site" };
    if (site === "same-site" || site === "cross-site") return { allowed: false, reason: `Sec-Fetch-Site ${site}` };
  }

  if (input.origin !== null) {
    const raw = input.origin.trim();
    if (raw === "" || raw === "null" || raw.includes(",") || raw.includes(" ")) return { allowed: false, reason: "malformed Origin" };
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return { allowed: false, reason: "malformed Origin" };
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== raw.toLowerCase().replace(/\/$/, "")) {
      return { allowed: false, reason: "malformed Origin" };
    }
    const expected = expectedHosts(input);
    if (expected.length === 0 || !expected.includes(parsed.host)) return { allowed: false, reason: "Origin does not match host" };
    return { allowed: true };
  }

  // No Origin: a browser (which sent Sec-Fetch-Site same-origin / none) or
  // a non-browser client. Neither can carry a forged cross-site credential.
  return { allowed: true };
}

function expectedHosts(input: MutationOriginInput): string[] {
  const forwarded = firstValue(input.forwardedHost);
  const host = firstValue(input.host);
  return forwarded ? [forwarded] : host ? [host] : [];
}
