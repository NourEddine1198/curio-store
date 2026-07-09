/** @type {import('next').NextConfig} */

// Applied to every page/route (defense against clickjacking + MIME sniffing).
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

// Admin/agent/console pages must never be indexed by search engines.
const NOINDEX_PATHS = [
  "/agent",
  "/agent/:path*",
  "/content-admin",
  "/products-admin",
  "/team-stats",
  "/dashboard",
];

const nextConfig = {
  // Restrict the image optimizer to hosts we actually use (was "**", which
  // turned /_next/image into an open proxy / SSRF vector).
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "cdn.youcan.shop" },
      { protocol: "https", hostname: "stirring-marigold-3dd8e9.netlify.app" },
      { protocol: "https", hostname: "curiodz.com" },
    ],
  },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      ...NOINDEX_PATHS.map((source) => ({
        source,
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      })),
    ];
  },
};

export default nextConfig;
