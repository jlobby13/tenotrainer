// M3.3 S2 — the web-security response boundary.
//
// One module owns every security header so the proxy (per-request, mode-
// aware) and next.config.ts (static assets the proxy never sees) cannot
// drift apart. Pure: no Next/server imports, so next.config.ts can load it.
import type { OperatingMode } from "./envValidation";

// Browser features TenoTrainer never uses: deny them for every origin
// (including embedded third parties). The app needs none of camera,
// microphone, location, payment, sensors, USB/serial/HID, fullscreen video
// or wake lock (exercise media opens as an external link, not embedded).
// Only features Chromium recognises: an unknown name is logged as an error
// on every page (the S2 suite checks for that).
const DENIED_FEATURES = [
  "accelerometer",
  "autoplay",
  "browsing-topics",
  "camera",
  "display-capture",
  "encrypted-media",
  "fullscreen",
  "geolocation",
  "gyroscope",
  "hid",
  "idle-detection",
  "magnetometer",
  "microphone",
  "midi",
  "payment",
  "picture-in-picture",
  "publickey-credentials-get",
  "screen-wake-lock",
  "serial",
  "usb",
  "xr-spatial-tracking",
];
export const PERMISSIONS_POLICY = DENIED_FEATURES.map((f) => `${f}=()`).join(", ");

// Mode-independent headers: safe on every response, including static assets.
export const STATIC_SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Invitation tokens travel in URLs: never send a Referer anywhere, not
  // even to this origin (founder decision: privacy first).
  { key: "Referrer-Policy", value: "no-referrer" },
  // CSP frame-ancestors is authoritative once enforced; until then (Report-
  // Only) this is the enforced clickjacking protection.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
];

// Authenticated / clinical content must never be reused from a browser,
// CDN or intermediary cache. Applied to every response the proxy handles
// (all pages and APIs); static assets keep Next's immutable caching.
export const SENSITIVE_CACHE_CONTROL = "private, no-store, max-age=0";

// No preload (an M3.4 decision); production / maintenance only, so local
// http development is never pinned to HTTPS.
export const HSTS_VALUE = "max-age=31536000; includeSubDomains";

// The CSP stays Report-Only until the production-mode suite proves it
// (founder D4). Flipping this is the single enforcement switch.
export const CSP_HEADER = "Content-Security-Policy-Report-Only";

// 128 bits from the platform CSPRNG, base64 — fresh per request.
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// devServer: running under `next dev` (React needs eval for debugging and
// the dev overlay injects inline styles). Only honoured in development
// mode, so production / maintenance can never inherit those allowances.
export function buildContentSecurityPolicy(nonce: string, mode: OperatingMode, devServer: boolean): string {
  const dev = mode === "development" && devServer;
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // A nonce disables 'unsafe-inline', so development uses one or the other.
    dev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    // No embedded media today (canonical media_url is NULL and only ever
    // rendered as an external link). Hosting media needs an explicit
    // allow-list change here.
    "media-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ];
  return directives.join("; ");
}

export type SecurityContext = { mode: OperatingMode | null; nonce: string; csp: string };

// mode null = the configuration is invalid; treated as production (the
// strictest headers) since nothing is served anyway.
export function createSecurityContext(mode: OperatingMode | null, devServer: boolean): SecurityContext {
  const nonce = createNonce();
  return { mode, nonce, csp: buildContentSecurityPolicy(nonce, mode ?? "production", devServer) };
}

export function applySecurityHeaders(headers: Headers, ctx: SecurityContext): void {
  for (const { key, value } of STATIC_SECURITY_HEADERS) headers.set(key, value);
  headers.set(CSP_HEADER, ctx.csp);
  headers.set("Cache-Control", SENSITIVE_CACHE_CONTROL);
  if (ctx.mode !== "development") headers.set("Strict-Transport-Security", HSTS_VALUE);
}
