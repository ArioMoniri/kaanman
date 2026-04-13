/**
 * SSE streaming proxy — forwards /api/chat/stream to the backend
 * and streams the response back chunk-by-chunk.
 *
 * Next.js rewrites buffer responses, breaking SSE. This route handler
 * uses a ReadableStream to pipe events in real-time.
 */

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8100";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/* Max duration for serverless/edge — set high for long AI pipelines */
export const maxDuration = 300;

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

  // Pipe the backend SSE stream through to the client
  const stream = new ReadableStream({
    async start(ctrl) {
      const reader = backendResp.body!.getReader();
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
