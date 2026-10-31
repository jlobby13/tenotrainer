import type { NextConfig } from "next";
import { STATIC_SECURITY_HEADERS } from "./lib/securityHeaders";

const nextConfig: NextConfig = {
  // M3.3 S1 — TenoTrainer never uses next/image, so the image optimizer
  // (/_next/image) is disabled rather than left reachable.
  images: { unoptimized: true },
  // M3.3 S1 — do not advertise the framework in an X-Powered-By header.
  poweredByHeader: false,
  // M3.3 S2 — mode-independent security headers on every response,
  // including the static assets the proxy never sees. The mode-aware ones
  // (CSP, HSTS, no-store) are set per request by the proxy.
  async headers() {
    return [{ source: "/:path*", headers: [...STATIC_SECURITY_HEADERS] }];
  },
};

export default nextConfig;
