import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getConfig, trustedRedirectUrl, type AppConfig } from "./lib/config";
import { observedRequestHost, originHost } from "./lib/config/origin";
import type { OperatingMode } from "./lib/config/types";
import { applySecurityHeaders, createSecurityContext, CSP_HEADER, type SecurityContext } from "./lib/securityHeaders";
import { checkMutationOrigin } from "./lib/mutationOrigin";

// Public paths that don't require authentication. "/api/internal" is the
// server-to-server namespace (FastAPI -> Next.js, matching the existing
// /api/auth/validate-bridge pattern) — every route under it authenticates
// via its own BRIDGE_SECRET check instead of a Supabase session cookie, so
// it must be exempted here or this middleware rejects it before that check
// ever runs. See web/app/api/internal/prescription-versions/route.ts
// (found via M5 Stage 1 founder-acceptance live verification: the route's
// own auth check was correct but unreachable without this exemption).
const PUBLIC_PATHS = ["/login", "/register", "/auth", "/invite", "/api/auth/validate-bridge", "/api/internal"];
// M3.3 S3d — the public readiness endpoint (exact path; canonical-host,
// mode and cross-origin rules still apply before it).
const READINESS_PATH = "/api/ready";

// M3.1 — operating-mode routing (the coarse first layer; route handlers,
// server actions and the clinical libraries enforce the same rules again).
// Legacy FastAPI-era / bridge routes exist only in development mode.
const LEGACY_ROUTE_PREFIXES = [
  "/api/patient/rehab-session",
  "/api/patient/morning-response",
  "/api/auth/launch-dashboard",
  "/api/auth/validate-bridge",
  "/api/internal/prescription-versions",
  "/api/internal/supervisor-patients-sync",
];
// F9 — the tester/admin invitation workflow is development-only.
const DEVELOPMENT_ONLY_PAGES = ["/admin/invitations", "/api/auth/debug"];
// Maintenance: every patient-facing page shows the unavailable experience.
const MAINTENANCE_PATIENT_PAGES = ["/patient", "/invite", "/setup"];
// Maintenance: signing in and out still works (patients then see the
// unavailable page; staff get read-only access).
const MAINTENANCE_SESSION_PATHS = ["/login", "/logout", "/auth/"];
// M3.2 (founder D1) — the narrow operational exception: safety email
// dispatch keeps running during maintenance. It authenticates with its own
// secret and performs no clinical mutation. Exactly this path, nothing else.
const MAINTENANCE_OPERATIONAL_PATHS = ["/api/internal/safety-notifications/dispatch"];

const startsWithAny = (pathname: string, prefixes: string[]) =>
  prefixes.some((p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`) || (p.endsWith("/") && pathname.startsWith(p)));

function modeRefusal(mode: OperatingMode, request: NextRequest): NextResponse | null {
  if (mode === "development") return null;
  const { pathname } = request.nextUrl;
  if (startsWithAny(pathname, LEGACY_ROUTE_PREFIXES)) {
    return NextResponse.json({ error: "LEGACY_RETIRED" }, { status: 410 });
  }
  if (startsWithAny(pathname, DEVELOPMENT_ONLY_PAGES)) {
    return new NextResponse("Not found", { status: 404 });
  }
  if (mode === "maintenance") {
    if (pathname === "/api/patient" || pathname.startsWith("/api/patient/")) {
      return NextResponse.json({ error: "MAINTENANCE" }, { status: 503 });
    }
    const readMethod = request.method === "GET" || request.method === "HEAD";
    const serverAction = request.headers.has("next-action");
    const operational = MAINTENANCE_OPERATIONAL_PATHS.includes(pathname) && request.method === "POST" && !serverAction;
    if ((!readMethod || serverAction) && !operational && !startsWithAny(pathname, MAINTENANCE_SESSION_PATHS)) {
      return NextResponse.json({ error: "MAINTENANCE" }, { status: 503 });
    }
  }
  return null;
}

// M3.3 S3b (founder C1) — production / maintenance serve exactly one
// canonical origin, TENOTRAINER_APP_ORIGIN. The observed host (first
// X-Forwarded-Host, else Host) is only COMPARED with it; the redirect
// destination comes from configuration alone (scheme, host and port), so
// request metadata can never choose where a client is sent. Unsafe methods
// (including OPTIONS) are refused, never redirected. Development keeps its
// request-local behaviour (localhost, 127.0.0.1, spawned test ports).
function canonicalHostRefusal(config: AppConfig, request: NextRequest): NextResponse | null {
  if (config.mode === "development") return null;
  const observed = observedRequestHost(request.headers.get("x-forwarded-host"), request.headers.get("host"));
  if (observed === originHost(config.appOrigin)) return null;
  if (request.method === "GET" || request.method === "HEAD") {
    // Only the path and query are taken from the request (as Next parsed
    // them: parameter-for-parameter, Next may re-encode e.g. %20 as +);
    // the origin — scheme, host and port — is the configured one.
    const { pathname, search } = new URL(request.url);
    const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
    return NextResponse.redirect(`${config.appOrigin}${path}${search}`, 308);
  }
  return NextResponse.json({ error: "NONCANONICAL_HOST_REFUSED" }, { status: 403 });
}

// M3.3 S2 — cross-origin browser mutations never reach a handler or a
// Server Action (see lib/mutationOrigin.ts). M3.3 S3b: in production and
// maintenance a present Origin must be exactly the canonical origin.
function crossOriginRefusal(config: AppConfig, request: NextRequest): NextResponse | null {
  const verdict = checkMutationOrigin({
    method: request.method,
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
    host: request.headers.get("host"),
    forwardedHost: request.headers.get("x-forwarded-host"),
    canonicalOrigin: config.mode === "development" ? null : config.appOrigin,
  });
  if (verdict.allowed) return null;
  console.warn(`[security] refused cross-origin ${request.method} ${request.nextUrl.pathname}: ${verdict.reason}`);
  return NextResponse.json({ error: "CROSS_ORIGIN_REQUEST_REFUSED" }, { status: 403 });
}

// The request headers the application renders with: the CSP carrying this
// request's nonce (Next reads the nonce from it and applies it to its own
// scripts and styles). A client-supplied policy is never trusted.
function forwardedHeaders(request: NextRequest, security: SecurityContext): Headers {
  const headers = new Headers(request.headers);
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.set(CSP_HEADER, security.csp);
  return headers;
}

export async function proxy(request: NextRequest) {
  // Fail closed: an invalid configuration serves nothing.
  let config: AppConfig;
  try {
    config = getConfig();
  } catch {
    // M3.3 S3d — readiness answers with its fixed public contract.
    const unavailable = request.nextUrl.pathname === READINESS_PATH
      ? (request.method === "HEAD" ? new NextResponse(null, { status: 503, headers: { "Content-Type": "application/json" } }) : NextResponse.json({ status: "unavailable" }, { status: 503 }))
      : new NextResponse("Service unavailable", { status: 503 });
    return secured(unavailable, createSecurityContext(null, false));
  }
  // One nonce per request (M3.3 S2). `next dev` is the only place React
  // needs eval; it is honoured in development mode only.
  const { mode } = config;
  const security = createSecurityContext(mode, config.platform.isDevServer);
  const refused = canonicalHostRefusal(config, request) ?? modeRefusal(mode, request) ?? crossOriginRefusal(config, request);
  if (refused) return secured(refused, security);
  return secured(await route(request, config, security), security);
}

function secured(response: NextResponse, security: SecurityContext): NextResponse {
  applySecurityHeaders(response.headers, security);
  return response;
}

async function route(request: NextRequest, config: AppConfig, security: SecurityContext): Promise<NextResponse> {
  const { mode } = config;
  let supabaseResponse = NextResponse.next({ request: { headers: forwardedHeaders(request, security) } });

  const supabase = createServerClient(
    config.supabase.url,
    config.supabase.anonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request: { headers: forwardedHeaders(request, security) } });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh session — must call getUser() (not getSession()) to validate JWT server-side
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const isPublic = pathname === READINESS_PATH || PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  if (!user && !isPublic) {
    // API routes get a 401 JSON response; page routes get a login redirect
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // M3.3 S3b — canonical origin in production/maintenance, request-local
    // in development; the original query is kept, as before.
    const url = trustedRedirectUrl(request.url, `/login${request.nextUrl.search}`);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Already authenticated — redirect away from login/register
  if (user && (pathname === "/login" || pathname === "/register")) {
    return NextResponse.redirect(trustedRedirectUrl(request.url, "/dashboard"));
  }

  // M3.1 — maintenance: patient pages show the unavailable experience.
  // (An internal rewrite, never sent to the client: it stays on this
  // request's own URL — only canonical-host requests reach this point — and
  // an absolute URL on another origin would make it an external proxy.)
  if (mode === "maintenance" && startsWithAny(pathname, MAINTENANCE_PATIENT_PAGES)) {
    const url = request.nextUrl.clone();
    url.pathname = "/maintenance";
    url.search = "";
    const rewrite = NextResponse.rewrite(url, { request: { headers: forwardedHeaders(request, security) } });
    for (const c of supabaseResponse.cookies.getAll()) rewrite.cookies.set(c);
    return rewrite;
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
