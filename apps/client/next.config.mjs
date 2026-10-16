const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:4000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  // The dev-only "N" badge sat over the bottom-left of the setup rail and cut off its text. Errors still show.
  devIndicators: false,
  experimental: { proxyTimeout: 180_000 },
  async redirects() {
    // The blocklist is the suppress list now.
    return [{ source: "/app/blocklist", destination: "/app/suppression", permanent: true }];
  },
  async rewrites() {
    return process.env.API_PROXY === "off" ? [] : [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
