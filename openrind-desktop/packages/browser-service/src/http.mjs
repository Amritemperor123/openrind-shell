import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { failure, LIMITS } from '@openrind/browser-contract';

const digest = value => createHash('sha256').update(value).digest();
const result = value => ({ ...(value.ok === false ? { isError: true } : {}),
  content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

// A host attaches this handler only to its provisioned private listener/bridge.
// This module never selects a bind address or exposes trusted control methods.
export function createMcpHttpHandler({ service, sdk, authority, serviceToken,
  json = false, maxSessions = 32, ttlMs = 15 * 60_000 }) {
  if (typeof authority !== 'string' || !/^[a-zA-Z0-9.\[\]:-]{1,255}$/.test(authority) ||
      typeof serviceToken !== 'string' || !/^[\x21-\x7e]{16,8192}$/.test(serviceToken) ||
      !Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 128 ||
      !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 15 * 60_000) {
    throw new Error('Invalid browser HTTP provisioning');
  }
  const expected = digest(`Bearer ${serviceToken}`);
  const sessions = new Map();
  const records = new Set();
  let closed = false;
  let activeRequests = 0;
  const reply = (res, status) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'Cache-Control': 'no-store' }); res.end();
  };
  const dispose = async record => {
    if (record.closing) return record.closing;
    records.delete(record);
    if (record.transport.sessionId) sessions.delete(record.transport.sessionId);
    record.closing = record.mcp.close().catch(() => {});
    return record.closing;
  };
  const authenticate = token => service.core.grants.authenticate(token);
  async function handle(req, res) {
    if (closed) return reply(res, 503);
    if (req.headers.host !== authority || req.headers.origin !== undefined) return reply(res, 403);
    if (req.url !== '/mcp') return reply(res, 404);
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) return reply(res, 405);
    // Reject duplicated security headers instead of relying on HTTP parser joining.
    for (const name of ['authorization', 'x-openrind-browser-grant', 'mcp-session-id', 'host']) {
      let count = 0;
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) count++;
      if (count > 1) return reply(res, 400);
    }
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || authorization.length > 8200 ||
        !timingSafeEqual(digest(authorization), expected)) return reply(res, 401);
    const token = req.headers['x-openrind-browser-grant'];
    let auth;
    try { auth = authenticate(token); } catch { return reply(res, 401); }
    const id = req.headers['mcp-session-id'];
    let record = id === undefined ? undefined : sessions.get(id);
    if (id !== undefined && (!record || record.token !== token || record.owner !== auth.owner ||
        record.grantId !== auth.principal.grantId || record.expires <= Date.now() || auth.principal.expiresAt <= Date.now())) return reply(res, 403);
    if (record && record.active >= 34) return reply(res, 429);
    if (record) {
      record.active++;
      record.expires = Math.min(Date.now() + ttlMs, auth.principal.expiresAt);
    }
    try {
      let body;
      if (req.method === 'POST') {
        if (req.headers['content-encoding'] !== undefined ||
            !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return reply(res, 415);
        if (Number(req.headers['content-length'] ?? 0) > LIMITS.bodyBytes) return reply(res, 413);
        let size = 0;
        const chunks = [];
        const deadline = setTimeout(() => req.destroy(), 10_000);
        try {
          for await (const chunk of req) {
            size += chunk.length;
            if (size > LIMITS.bodyBytes) return reply(res, 413);
            chunks.push(chunk);
          }
        } finally { clearTimeout(deadline); }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return reply(res, 400); }
      }
      // Reading a slow request must not extend a revoked/expired grant.
      let freshAuth;
      try { freshAuth = authenticate(token); } catch { return reply(res, 401); }
      if (record) record.expires = Math.min(Date.now() + ttlMs, freshAuth.principal.expiresAt);
      if (!record) {
        if (req.method !== 'POST' || !sdk.isInitializeRequest(body)) return reply(res, 400);
        if (records.size >= maxSessions) return reply(res, 429);
        const mcp = new sdk.Server({ name: 'openrind-browser-service', version: '0.0.0' }, { capabilities: { tools: {} } });
        const transport = new sdk.StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
          enableJsonResponse: json, onsessioninitialized: sessionId => sessions.set(sessionId, record) });
        record = { mcp, transport, token, owner: auth.owner, grantId: auth.principal.grantId,
          expires: Math.min(Date.now() + ttlMs, auth.principal.expiresAt), active: 1 };
        // Reserve before the first await, including pending initialize requests.
        records.add(record);
        mcp.setRequestHandler(sdk.ListToolsRequestSchema, async () => {
          authenticate(token);
          return { tools: service.tools };
        });
        mcp.setRequestHandler(sdk.CallToolRequestSchema, async (request, extra) => {
          try {
            return result(await service.invoke(token, request.params.name, request.params.arguments,
              { signal: extra.signal }));
          } catch (error) { return result(failure(error)); }
        });
        mcp.onclose = () => {
          records.delete(record);
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        try { await mcp.connect(transport); }
        catch (error) { await dispose(record); throw error; }
      }
      res.setHeader('Cache-Control', 'no-store');
      try { await record.transport.handleRequest(req, res, body); }
      catch (error) {
        if (!record.transport.sessionId) await dispose(record);
        throw error;
      }
      if (req.method === 'DELETE' || !record.transport.sessionId) await dispose(record);
    } finally { if (record) record.active--; }
  }
  const timer = setInterval(() => {
    for (const record of records) {
      try {
        const auth = authenticate(record.token);
        if (record.active > 0) record.expires = Math.min(Date.now() + ttlMs, auth.principal.expiresAt);
        if (Date.now() >= record.expires || Date.now() >= auth.principal.expiresAt) throw new Error('expired');
      } catch { void dispose(record); }
    }
  }, 1000);
  timer.unref();
  return Object.freeze({
    handler(req, res) {
      if (activeRequests >= 128) return reply(res, 429);
      activeRequests++;
      let released = false;
      const release = () => { if (!released) { released = true; activeRequests--; } };
      res.once('close', release);
      res.once('finish', release);
      void handle(req, res).catch(() => reply(res, 500));
    },
    async close() {
      closed = true; clearInterval(timer);
      await Promise.all([...records].map(dispose));
    },
  });
}
