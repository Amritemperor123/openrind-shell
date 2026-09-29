import { createServer } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { MAX_BODY } from "./contract.mjs";

const requestNames = new Set(["authorization", "accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"]);
const responseNames = new Set(["content-type", "mcp-session-id", "mcp-protocol-version", "cache-control", "allow"]);
const ignoredRequestNames = new Set(["host", "connection", "content-length", "transfer-encoding", "user-agent", "accept-encoding", "accept-language", "sec-fetch-mode"]);
function selectedHeaders(headers, names, strict = false) {
  const selected = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!names.has(name)) {
      if (strict && !ignoredRequestNames.has(name)) throw new Error("Unsupported header");
      continue;
    }
    if (typeof value !== "string" || value.length > 8192 || /[\r\n]/.test(value)) throw new Error("Invalid header");
    selected[name] = value;
  }
  return selected;
}

export async function startHttpEdge(peer, { host = "127.0.0.1", port = 0, publicHost = host } = {}) {
  let authority;
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    const fail = (status) => { if (!res.headersSent) { res.writeHead(status); res.end(); } else res.destroy(); };
    let stream;
    void (async () => {
      if (req.headers.host !== authority || req.headers.origin !== undefined) return fail(403);
      if (req.url !== "/mcp") return fail(404);
      if (!["GET", "POST", "DELETE"].includes(req.method)) return fail(405);
      if (req.headers["content-encoding"]) return fail(415);
      if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return fail(413);
      let headers;
      try { headers = selectedHeaders(req.headers, requestNames, true); } catch { return fail(400); }
      if (!headers.authorization) return fail(401);
      stream = await peer.open(req.method, req.url, headers);
      res.once("close", () => { if (!res.writableEnded) stream.cancel(); });
      req.once("aborted", () => stream.cancel());
      const send = (async () => {
        let size = 0;
        for await (const bytes of req) {
          size += bytes.length;
          if (size > MAX_BODY) throw new Error("HTTP body quota");
          await stream.send(bytes);
        }
        await stream.end();
      })();
      send.catch(() => { stream.cancel(); fail(502); });
      const response = await stream.response;
      res.writeHead(response.status, selectedHeaders(response.headers, responseNames));
      // SSE headers must be visible even before the first notification arrives.
      res.flushHeaders();
      let size = 0;
      for await (const bytes of stream.body()) {
        size += bytes.length;
        if (size > MAX_BODY) throw new Error("MCP response quota");
        if (!res.write(bytes)) await once(res, "drain", { signal: stream.signal });
      }
      await send;
      res.end();
    })().catch(() => { stream?.cancel(); fail(502); });
  });
  server.headersTimeout = 5000; server.requestTimeout = 10_000;
  await peer.ready;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  authority = `${publicHost}:${server.address().port}`;
  return { endpoint: `http://${authority}/mcp`, async close() {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  } };
}

// Installed by the trusted worker with ONE fixed upstream. The edge cannot pick
// a Host, URL, method outside MCP, redirect target or arbitrary upstream service.
export function forwardToService(endpoint) {
  const target = new URL(endpoint);
  if (target.pathname !== "/mcp" || target.username || target.password || target.search || target.hash) throw new Error("Invalid service target");
  if (target.protocol !== "https:" && !(target.protocol === "http:" && target.hostname === "127.0.0.1")) throw new Error("Invalid service transport");
  return async (request, stream) => {
    if (Object.keys(request.headers).some((name) => !requestNames.has(name))) throw new Error("Unexpected private request header");
    const headers = selectedHeaders(request.headers, requestNames, true);
    // No compression layer whose expanded bytes could bypass bridge limits.
    headers["accept-encoding"] = "identity";
    let body;
    if (request.method === "POST") body = Readable.from((async function* () {
      let received = 0;
      for await (const bytes of stream.body()) {
        received += bytes.length;
        if (received > MAX_BODY) throw new Error("Service request quota");
        yield bytes;
      }
    })());
    else for await (const bytes of stream.body()) { if (bytes.length) throw new Error("Unexpected MCP body"); }
    const response = await fetch(target, { method: request.method, headers,
      body, duplex: "half", redirect: "error", signal: stream.signal });
    if (response.headers.get("content-encoding")) throw new Error("Compressed service response rejected");
    await stream.respond(response.status, selectedHeaders(Object.fromEntries(response.headers), responseNames));
    let size = 0;
    if (response.body) for await (const bytes of response.body) {
      size += bytes.length;
      if (size > MAX_BODY) throw new Error("Service response quota");
      await stream.send(bytes);
    }
    await stream.end();
  };
}
