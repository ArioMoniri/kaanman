/**
 * HTTP bridge for medical-mcp stdio server.
 * Spawns medical-mcp as a child process via MCP SDK's StdioClientTransport,
 * then exposes an HTTP server so the Python backend can call tools via JSON-RPC.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";

const PORT = parseInt(process.env.PORT || "3001");

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["node_modules/medical-mcp/build/index.js"],
  });

  const client = new Client({ name: "mcp-bridge", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected to medical-mcp via stdio");

  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.method === "POST" && req.url === "/mcp") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body);
          const params = parsed.params || {};
          const result = await client.callTool({
            name: params.name,
            arguments: params.arguments || {},
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id || 1, result }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: e.message } })
          );
        }
      });
      return;
    }

    if (req.method === "GET" && req.url === "/tools") {
      try {
        const tools = await client.listTools();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(tools));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  server.listen(PORT, () => {
    console.log(`MCP HTTP bridge listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error("Bridge startup failed:", err);
  process.exit(1);
});
