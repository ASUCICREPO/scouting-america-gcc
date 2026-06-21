import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {},
  // Static export for S3 + CloudFront hosting (US-only geo-restricted edge).
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
