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

export async function POST(req: Request) {
  const body = await req.text();

  const backendResp = await fetch(`${BACKEND_URL}/api/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });

  if (!backendResp.ok) {
    return new Response(
      JSON.stringify({ error: `Backend returned ${backendResp.status}` }),
      { status: backendResp.status, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!backendResp.body) {
    return new Response("No response body from backend", { status: 502 });
  }

  // Pipe the backend SSE stream through to the client
  const stream = new ReadableStream({
    async start(controller) {
      const reader = backendResp.body!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch (err) {
        console.error("[SSE proxy] Stream error:", err);
      } finally {
        controller.close();
        reader.releaseLock();
      }
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
