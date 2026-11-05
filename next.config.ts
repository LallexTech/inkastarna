import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  env: {
    INKASTARNA_DEPLOY_PRIME_URL: process.env.DEPLOY_PRIME_URL ?? "",
    INKASTARNA_DEPLOY_URL: process.env.DEPLOY_URL ?? "",
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};
export default config;
