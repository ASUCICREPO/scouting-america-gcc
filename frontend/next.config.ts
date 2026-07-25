import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    // Prevent an unrelated workspace-level lockfile from changing Next's root.
    root: process.cwd(),
  },
  // Static export for S3 + CloudFront hosting (deployed via deploy.sh).
  output: "export",
  images: { unoptimized: true },
  // Emit per-route index.html (e.g. /dashboard/ -> /dashboard/index.html) so
  // CloudFront/S3 serve routes without a server.
  trailingSlash: true,
};

export default nextConfig;
