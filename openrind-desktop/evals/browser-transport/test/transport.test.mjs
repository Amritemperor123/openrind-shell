import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFixture } from "../fixture.mjs";
import { connectRemote } from "../client.mjs";
import { descriptor, MAX_BODY, TOOL } from "../contract.mjs";

const key = () => randomBytes(32).toString("hex");
const config = (endpoint) => ({ protocol: 1, endpoint, requireProxy: false });
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await sleep(10); }
  assert.fail("Expected fixture observation did not arrive");
}

for (const json of [true, false]) {
  test(`SDK HTTP ${json ? "JSON" : "SSE"}: discovery, call, notification and DELETE`, async (t) => {
    const token = key();
    const fixture = await startFixture({ tokens: [token], json });
    t.after(() => fixture.close());
    const responses = [];
    const remote = await connectRemote(config(fixture.endpoint), token, { fetch: async (...args) => {
      const response = await fetch(...args);
      responses.push(response.headers.get("content-type"));
      return response;
    } });
    t.after(() => remote.close());
    assert.deepEqual((await remote.client.listTools()).tools.map((x) => x.name), [TOOL]);
    const progress = [];
    const result = await remote.client.callTool({ name: TOOL, arguments: { nonce: "hello" } },
      undefined, { onprogress: (p) => progress.push(p) });
    assert.equal(result.structuredContent.nonce, "hello");
    assert.ok(responses.some((v) => v?.includes(json ? "application/json" : "text/event-stream")));
    if (!json) await waitFor(() => progress.length > 0);
    await remote.close();
    assert.equal(fixture.audit.deleted, 1);
    assert.equal(fixture.sessions.size, 0);
  });
}

test("credentials, session ownership, revocation and browser Origin are enforced", async (t) => {
  const token = key();
  const other = key();
  const tokens = [token, other];
  const fixture = await startFixture({ tokens });
  t.after(() => fixture.close());
  await assert.rejects(connectRemote(config(fixture.endpoint), key()), /connection failed/);
  const remote = await connectRemote(config(fixture.endpoint), token);
  t.after(() => remote.close());
  const headers = { authorization: `Bearer ${other}`, "mcp-session-id": remote.transport.sessionId };
  assert.equal((await fetch(fixture.endpoint, { method: "DELETE", headers })).status, 403);
  assert.equal((await fetch(fixture.endpoint, { headers: { authorization: `Bearer ${token}`, origin: "https://attacker.example" } })).status, 403);
  tokens[0] = key(); // Trusted revocation: an existing MCP session is not a credential.
  await assert.rejects(remote.client.listTools());
});

test("HTTP route, Host, body limits and strict tool allowlist", async (t) => {
  const token = key();
  const fixture = await startFixture({ tokens: [token] });
  t.after(() => fixture.close());
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  assert.equal((await fetch(fixture.endpoint + "/extra", { headers })).status, 404);
  const badHost = await new Promise((resolve, reject) => {
    const req = request(fixture.endpoint, { headers: { ...headers, host: "evil.example" } }, (res) => {
      res.resume(); resolve(res.statusCode);
    });
    req.on("error", reject); req.end();
  });
  assert.equal(badHost, 403);
  assert.equal((await fetch(fixture.endpoint, { method: "POST", headers, body: "x".repeat(MAX_BODY + 1) })).status, 413);
  assert.equal((await fetch(fixture.endpoint, { method: "POST", headers: { ...headers, "content-encoding": "gzip" }, body: "{}" })).status, 415);
  const remote = await connectRemote(config(fixture.endpoint), token);
  t.after(() => remote.close());
  for (const request of [{ name: "browser_run_code_unsafe", arguments: {} },
    { name: TOOL, arguments: { nonce: "ok", endpoint: "https://evil.example" } }]) {
    assert.equal((await remote.client.callTool(request)).isError, true);
  }
  assert.equal(fixture.audit.calls, 0);
});

test("cancellation crosses HTTP and aborts the server request", async (t) => {
  const token = key();
  const fixture = await startFixture({ tokens: [token] });
  t.after(() => fixture.close());
  const remote = await connectRemote(config(fixture.endpoint), token);
  t.after(() => remote.close());
  const controller = new AbortController();
  const result = remote.client.callTool({ name: TOOL, arguments: { nonce: "cancel", delayMs: 5000 } },
    undefined, { signal: controller.signal });
  const rejection = assert.rejects(result);
  await waitFor(() => fixture.audit.calls === 1);
  controller.abort();
  await rejection;
  await waitFor(() => fixture.audit.cancelled === 1);
});

test("lost dispatched response is not automatically replayed", async (t) => {
  const token = key();
  const fixture = await startFixture({ tokens: [token], dropResult: true });
  t.after(() => fixture.close());
  const remote = await connectRemote(config(fixture.endpoint), token);
  t.after(() => remote.close());
  await assert.rejects(remote.client.callTool({ name: TOOL, arguments: { nonce: "once" } },
    undefined, { timeout: 500 }));
  await sleep(150);
  assert.equal(fixture.audit.calls, 1);
});

test("fixed endpoint validation and required proxy fail closed", async () => {
  for (const endpoint of ["http://evil.example/mcp", "https://example.com/mcp?secret=x",
    "https://user:pass@example.com/mcp", "https://example.com/other"]) {
    assert.throws(() => descriptor(config(endpoint)));
  }
  await assert.rejects(connectRemote({ ...config("http://host.openshell.internal:8789/mcp"),
    requireProxy: true }, key(), { env: {} }), /proxy is required/);
});

test("stdio adapter preserves discovery, progress, cancellation and EOF cleanup", async (t) => {
  const token = key();
  const fixture = await startFixture({ tokens: [token] });
  t.after(() => fixture.close());
  const directory = await mkdtemp(join(tmpdir(), "openrind-browser-probe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "settings.json");
  await writeFile(path, JSON.stringify({ descriptor: config(fixture.endpoint), token }), { mode: 0o600 });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("./stdio-entry.mjs", import.meta.url)), path], stderr: "pipe" });
  const client = new Client({ name: "fixture-stdio-consumer", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools[0].name, TOOL);
  const progress = [];
  const result = await client.callTool({ name: TOOL, arguments: { nonce: "stdio" } },
    undefined, { onprogress: (p) => progress.push(p) });
  assert.equal(result.structuredContent.nonce, "stdio");
  await waitFor(() => progress.length > 0);
  const controller = new AbortController();
  const pending = client.callTool({ name: TOOL, arguments: { nonce: "stop", delayMs: 5000 } },
    undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending);
  await waitFor(() => fixture.audit.calls === 2);
  controller.abort();
  await rejected;
  await waitFor(() => fixture.audit.cancelled === 1);
  await client.close();
  await waitFor(() => fixture.sessions.size === 0);
});
