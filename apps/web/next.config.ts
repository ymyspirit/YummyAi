import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  devIndicators: { position: "bottom-right" },
  experimental: { serverActions: { bodySizeLimit: "25mb" } },
  reactStrictMode: true,
  async headers() {
    return [{ source: "/plugins/:file*", headers: [{ key: "Access-Control-Allow-Origin", value: "*" }, { key: "X-Content-Type-Options", value: "nosniff" }] }];
  },
};

export default nextConfig;
