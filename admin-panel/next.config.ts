import type { NextConfig } from "next";

// Internal tool: no public assets, no image optimizer, no PWA. The admin API is only ever called
// from the server (see lib/api.ts), so nothing here needs a browser-facing origin.
const nextConfig: NextConfig = {
  poweredByHeader: false,
};

export default nextConfig;
