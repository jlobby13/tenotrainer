import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getServerConfig } from "./lib/env";
import type { OperatingMode } from "./lib/envValidation";

// Public paths that don't require authentication. "/api/internal" is the
// server-to-server namespace (FastAPI -> Next.js, matching the existing
// /api/auth/validate-bridge pattern) — every route under it authenticates
// via its own BRIDGE_SECRET check instead of a Supabase session cookie, so
// it must be exempted here or this middleware rejects it before that check
// ever runs. See web/app/api/internal/prescription-versions/route.ts
// (found via M5 Stage 1 founder-acceptance live verification: the route's
// own auth check was correct but unreachable without this exemption).
const PUBLIC_PATHS = ["/login", "/register", "/auth", "/invite", "/api/auth/validate-bridge", "/api/internal"];

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

export async function proxy(request: NextRequest) {
  // Fail closed: an invalid configuration serves nothing.
  let mode: OperatingMode;
  try {
    mode = getServerConfig().mode;
  } catch {
    return new NextResponse("Service unavailable", { status: 503 });
  }
  const refused = modeRefusal(mode, request);
  if (refused) return refused;

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
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
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  if (!user && !isPublic) {
    // API routes get a 401 JSON response; page routes get a login redirect
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Already authenticated — redirect away from login/register
  if (user && (pathname === "/login" || pathname === "/register")) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // M3.1 — maintenance: patient pages show the unavailable experience.
  if (mode === "maintenance" && startsWithAny(pathname, MAINTENANCE_PATIENT_PAGES)) {
    const url = request.nextUrl.clone();
    url.pathname = "/maintenance";
    url.search = "";
    const rewrite = NextResponse.rewrite(url);
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
