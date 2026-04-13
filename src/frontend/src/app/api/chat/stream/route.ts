/**
 * SSE streaming proxy — forwards /api/chat/stream to the backend
 * and streams the response back chunk-by-chunk.
 *
 * Next.js rewrites buffer responses, breaking SSE. This route handler
 * uses a ReadableStream to pipe events in real-time.
 *
 * Includes periodic keepalive comments (`:keepalive`) to prevent
 * Cloudflare Tunnel / reverse proxy idle-timeout disconnects.
 */

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8100";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/* Max duration for serverless/edge — set high for long AI pipelines */
export const maxDuration = 300;

/** Interval (ms) between keepalive SSE comments — 15 s is well within
 *  Cloudflare's 100 s idle timeout and most reverse proxies. */
const KEEPALIVE_INTERVAL = 15_000;

export async function POST(req: Request) {
  const body = await req.text();

  /* 5 min abort controller — AI agent pipelines can take 2-3 min */
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);

  let backendResp: Response;
  try {
    backendResp = await fetch(`${BACKEND_URL}/api/chat/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body,
      signal: controller.signal,
      keepalive: true,
    });
  } catch (err) {
    clearTimeout(timeout);
    console.error("[SSE proxy] Backend fetch failed:", err);
    return new Response(
      JSON.stringify({ error: "Backend connection failed" }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!backendResp.ok) {
    clearTimeout(timeout);
    return new Response(
      JSON.stringify({ error: `Backend returned ${backendResp.status}` }),
      { status: backendResp.status, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!backendResp.body) {
    clearTimeout(timeout);
    return new Response("No response body from backend", { status: 502 });
  }

  const encoder = new TextEncoder();
  const keepaliveChunk = encoder.encode(":keepalive\n\n");

  // Pipe the backend SSE stream through to the client,
  // injecting periodic keepalive comments to prevent proxy timeouts.
  const stream = new ReadableStream({
    async start(ctrl) {
      const reader = backendResp.body!.getReader();

      // Keepalive timer — sends `:keepalive` SSE comments every 15 s.
      // SSE comment lines (starting with `:`) are silently ignored by
      // EventSource clients and by our manual parser in page.tsx
      // (which only processes lines starting with `event:` or `data:`).
      const keepalive = setInterval(() => {
        try {
          ctrl.enqueue(keepaliveChunk);
        } catch {
          // stream already closed — clearInterval below will handle it
        }
      }, KEEPALIVE_INTERVAL);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          ctrl.enqueue(value);
        }
      } catch (err) {
        // Only log if not an intentional abort
        if (!controller.signal.aborted) {
          console.error("[SSE proxy] Stream error:", err);
        }
      } finally {
        clearInterval(keepalive);
        clearTimeout(timeout);
        try { ctrl.close(); } catch { /* already closed */ }
        reader.releaseLock();
      }
    },
    cancel() {
      clearTimeout(timeout);
      controller.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
