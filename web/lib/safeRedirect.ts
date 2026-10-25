// M2 — the ONE validator for every redirect target that came from a request
// (login `next`, auth callback `next`, invitation login handoff, admin
// `_redirect_base`, the legacy launch-dashboard `dest`). Never maintain a
// second, subtly different check: call this.
//
// Accepts only a same-origin path: it must start with exactly one "/", and
// after the URL parser has normalized it (which is where "/\evil.com",
// tab/newline stripping and similar tricks would turn into another host) it
// must still resolve to our own origin. Returns the normalized
// path + query + hash, or `fallback`.

const PROBE_ORIGIN = "https://tenotrainer.invalid";

export function safeInternalPath(raw: unknown, fallback: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return fallback;
  // Control characters and backslashes are never part of a legitimate
  // internal path; browsers strip/convert them, which is how bypasses work.
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  // Percent-encoded slashes/backslashes at the start are rejected outright.
  if (/^\/(%2f|%5c)/i.test(raw)) return fallback;

  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PROBE_ORIGIN) return fallback;
  if (!url.pathname.startsWith("/") || url.pathname.startsWith("//")) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

// Appends query parameters to an already-validated internal path, whether or
// not it already has a query string.
export function withQuery(path: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(path, PROBE_ORIGIN);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  return `${url.pathname}${url.search}${url.hash}`;
}
