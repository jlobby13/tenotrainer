import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // M3.3 S1 — TenoTrainer never uses next/image, so the image optimizer
  // (/_next/image) is disabled rather than left reachable.
  images: { unoptimized: true },
  // M3.3 S1 — do not advertise the framework in an X-Powered-By header.
  poweredByHeader: false,
};

export default nextConfig;
