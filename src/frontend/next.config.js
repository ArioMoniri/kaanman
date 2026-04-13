/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  env: {
    // Empty string = same origin (API calls go through Next.js rewrites below)
    // Override with full URL for local-only development without rewrites
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "",
  },
  // Increase proxy timeout for long-running SSE streams (AI agent pipelines)
  experimental: {
    proxyTimeout: 300000, // 5 minutes
  },
  async rewrites() {
    // Proxy all /api/* and /health calls to the backend service
    // EXCEPT /api/chat/stream which has a custom route handler with SSE timeout handling
    const backendUrl = process.env.BACKEND_URL || "http://localhost:8100";
    return {
      beforeFiles: [
        // Let the Next.js route handler at /api/chat/stream handle SSE
        // (it has proper AbortController + long timeout for AI pipelines)
      ],
      afterFiles: [
        // All other API calls proxy to backend
        {
          source: "/api/chat/stream",
          destination: `${backendUrl}/api/chat/stream`,
          has: [{ type: "header", key: "x-use-rewrite" }], // never matches — forces route handler
        },
        {
          source: "/api/:path*",
          destination: `${backendUrl}/api/:path*`,
        },
        {
          source: "/health",
          destination: `${backendUrl}/health`,
        },
      ],
    };
  },
};

module.exports = nextConfig;
