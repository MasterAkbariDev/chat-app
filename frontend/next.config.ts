import type { NextConfig } from "next";
import createBundleAnalyzer from "@next/bundle-analyzer";

// `next/image` refuses to load from any host not explicitly allowed here —
// this is the API's own origin (message attachments/wallpaper come back as
// absolute URLs pointing at it, e.g. `${NEXT_PUBLIC_API_URL}/uploads/media/**`
// — see lib/media-url.ts), not a CDN. Falls back to the same localhost
// default every other API-URL read in this app uses (lib/api/client.ts) so a
// build with no env var configured still parses a valid URL instead of
// throwing here.
const apiUrl = new URL(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001");

// Next's image optimizer refuses to fetch from a private/local IP by default
// (a real SSRF guard) — found live-testing this: every local dev/test setup
// in this project points NEXT_PUBLIC_API_URL at exactly that (localhost),
// which otherwise 400s every single message photo the moment `next/image`
// tries to resize one. Scoped to only actually loosen anything when the
// configured API host genuinely is local — a real production deployment's
// own public domain never matches this, so it stays fully SSRF-guarded there.
const apiHostIsLocal = ["localhost", "127.0.0.1", "::1"].includes(apiUrl.hostname);

const nextConfig: NextConfig = {
  // Needed for a lean production Docker image (see frontend/Dockerfile) —
  // copies only the traced production dependency graph into `.next/standalone`
  // instead of shipping the full node_modules tree.
  output: "standalone",
  images: {
    remotePatterns: [
      {
        protocol: apiUrl.protocol.replace(":", "") as "http" | "https",
        hostname: apiUrl.hostname,
        port: apiUrl.port,
        pathname: "/uploads/media/**",
      },
    ],
    ...(apiHostIsLocal ? { dangerouslyAllowLocalIP: true } : {}),
  },
};

// `ANALYZE=true npm run build` (see the `analyze` script) opens an
// interactive treemap of every route's client bundle — F0's own
// acceptance criterion for a bundle-size report. A no-op otherwise, so
// this doesn't change normal `next build`/`next dev` behavior at all.
const withBundleAnalyzer = createBundleAnalyzer({ enabled: process.env.ANALYZE === "true" });

export default withBundleAnalyzer(nextConfig);
