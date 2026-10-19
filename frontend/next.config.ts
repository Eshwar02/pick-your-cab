import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: { root: process.cwd() },
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
