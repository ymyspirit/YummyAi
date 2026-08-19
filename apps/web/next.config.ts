import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: { serverActions: { bodySizeLimit: "25mb" } },
  reactStrictMode: true,
};

export default nextConfig;
