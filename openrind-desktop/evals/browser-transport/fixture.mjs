import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { inputSchema, MAX_BODY, TOOL, toolDefinition } from "./contract.mjs";

function equal(a, b) {
  const left = Buffer.from(a ?? "");
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function startFixture({ tokens, host = "127.0.0.1", port = 0, publicHost,
  json = false, dropResult = false, ttlMs = 60_000, tls } = {}) {
  if (!tokens?.length || tokens.some((t) => !/^[a-zA-Z0-9_-]{32,128}$/.test(t))) {
    throw new Error("Fixture requires generated test credentials");
  }
  const sessions = new Map();
  const audit = { calls: 0, cancelled: 0, deleted: 0, denied: 0, notifications: 0 };
  let authority;
  const respond = (res, code) => { res.writeHead(code); res.end(); };
  const handler = (req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) respond(res, 500);
      else res.destroy();
    });
  };
  const server = tls ? createTlsServer(tls, handler) : createServer(handler);
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;

  async function handle(req, res) {
    // No browser CORS, redirects, general proxy, health data or URL-selected upstream.
    if (req.headers.host !== authority || req.headers.origin !== undefined) { audit.denied++; return respond(res, 403); }
    if (req.url !== "/mcp") return respond(res, 404);
    if (!["POST", "GET", "DELETE"].includes(req.method)) return respond(res, 405);
    const owner = tokens.findIndex((t) => equal(req.headers.authorization, `Bearer ${t}`));
    if (owner === -1) { audit.denied++; return respond(res, 401); }
    const id = req.headers["mcp-session-id"];
    let record = id ? sessions.get(id) : undefined;
    if (id && (!record || record.owner !== owner || Date.now() >= record.expires)) {
      audit.denied++;
      return respond(res, 403);
    }
    let body;
    if (req.method === "POST") {
      if (req.headers["content-encoding"] || !/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? "")) {
        return respond(res, 415);
      }
      if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return respond(res, 413);
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) { respond(res, 413); return; }
        chunks.push(chunk);
      }
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return respond(res, 400); }
    }
    if (!record) {
      if (req.method !== "POST" || !isInitializeRequest(body)) return respond(res, 400);
      if (sessions.size >= 8) return respond(res, 429);
      const mcp = new Server({ name: "openrind-transport-fixture", version: "0.0.1" },
        { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [toolDefinition] }));
      mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const parsed = inputSchema.safeParse(request.params.arguments ?? {});
        if (request.params.name !== TOOL || !parsed.success) {
          return { isError: true, content: [{ type: "text", text: "Invalid fixture tool request" }] };
        }
        audit.calls++;
        if (request.params._meta?.progressToken !== undefined) {
          await extra.sendNotification({ method: "notifications/progress", params: {
            progressToken: request.params._meta.progressToken, progress: 0, total: 1,
          } });
          audit.notifications++;
        }
        try { await sleep(parsed.data.delayMs ?? 0, undefined, { signal: extra.signal }); }
        catch { audit.cancelled++; throw new Error("Fixture request cancelled"); }
        if (dropResult) {
          // Simulate lost response after dispatch. Never an automatic retry fixture.
          setImmediate(() => { void transport.close(); });
          await sleep(50);
        }
        return { content: [{ type: "text", text: parsed.data.nonce }],
          structuredContent: { nonce: parsed.data.nonce, fixture: true } };
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID, enableJsonResponse: json,
        onsessioninitialized(sessionId) { sessions.set(sessionId, record); },
      });
      record = { owner, transport, mcp, expires: Date.now() + ttlMs };
      await mcp.connect(transport);
      mcp.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    }
    await record.transport.handleRequest(req, res, body);
    if (req.method === "DELETE") {
      audit.deleted++;
      sessions.delete(id);
      await record.mcp.close();
    }
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  authority = `${publicHost ?? host}:${server.address().port}`;
  const timer = setInterval(() => {
    for (const [id, record] of sessions) {
      if (Date.now() >= record.expires) {
        sessions.delete(id);
        void record.mcp.close();
      }
    }
  }, Math.min(ttlMs, 1000));
  timer.unref();
  return {
    endpoint: `${tls ? "https" : "http"}://${authority}/mcp`, audit, sessions,
    async close() {
      clearInterval(timer);
      await Promise.all([...sessions.values()].map((s) => s.mcp.close()));
      sessions.clear();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
