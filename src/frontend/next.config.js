/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  env: {
    // Empty string = same origin (API calls go through Next.js rewrites below)
    // Override with full URL for local-only development without rewrites
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "",
  },
  async rewrites() {
    // Proxy all /api/* and /health calls to the backend service
    const backendUrl = process.env.BACKEND_URL || "http://localhost:8100";
    return [
      {
        source: "/api/:path*",
        destination: `${backendUrl}/api/:path*`,
      },
      {
        source: "/health",
        destination: `${backendUrl}/health`,
      },
    ];
  },
};

module.exports = nextConfig;
