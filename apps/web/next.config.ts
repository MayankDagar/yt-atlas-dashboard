import type { NextConfig } from "next";

const apiInternalBase = (process.env.API_INTERNAL_URL || "http://localhost:4000").replace(/\/$/, "");
const allowedDevOrigins = (process.env.DEV_ALLOWED_ORIGINS || "192.168.100.107")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  allowedDevOrigins,
  productionBrowserSourceMaps: false,
  async rewrites() {
    return [{
      source: "/api/v1/:path*",
      destination: `${apiInternalBase}/api/v1/:path*`,
    }];
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }];
  },
};

export default nextConfig;
