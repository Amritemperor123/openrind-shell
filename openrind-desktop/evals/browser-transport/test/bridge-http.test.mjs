import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { BridgePeer } from "../bridge-peer.mjs";
import { startHttpEdge, forwardToService } from "../bridge-http.mjs";
import { startFixture } from "../fixture.mjs";
import { connectRemote } from "../client.mjs";
import { TOOL } from "../contract.mjs";

for (const json of [true, false]) test(`HTTP over binary bridge: ${json ? "JSON" : "SSE"}, cancellation and teardown`, async (t) => {
  const token = randomBytes(32).toString("hex");
  const fixture = await startFixture({ tokens: [token], json });
  t.after(() => fixture.close());
  const up = new PassThrough(), down = new PassThrough();
  const worker = new BridgePeer(up, down, { onRequest: forwardToService(fixture.endpoint) });
  const bridge = new BridgePeer(down, up, { initiator: true });
  t.after(() => { worker.close(); bridge.close(); });
  const edge = await startHttpEdge(bridge);
  t.after(() => edge.close());
  assert.equal((await fetch(edge.endpoint, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await fetch(edge.endpoint + "/other")).status, 404);
  assert.equal((await fetch(edge.endpoint)).status, 401);
  const remote = await connectRemote({ protocol: 1, endpoint: edge.endpoint, requireProxy: false }, token);
  t.after(() => remote.close());
  assert.equal((await remote.client.listTools()).tools[0].name, TOOL);
  assert.equal((await remote.client.callTool({ name: TOOL, arguments: { nonce: "bridged" } })).structuredContent.nonce, "bridged");
  const controller = new AbortController();
  const pending = remote.client.callTool({ name: TOOL, arguments: { nonce: "cancel", delayMs: 5000 } }, undefined,
    { signal: controller.signal });
  const rejected = assert.rejects(pending);
  while (fixture.audit.calls !== 2) await sleep(10);
  controller.abort(); await rejected;
  for (let i = 0; i < 100 && fixture.audit.cancelled !== 1; i++) await sleep(10);
  assert.equal(fixture.audit.cancelled, 1);
  await remote.close();
  assert.equal(fixture.audit.deleted, 1);
});
