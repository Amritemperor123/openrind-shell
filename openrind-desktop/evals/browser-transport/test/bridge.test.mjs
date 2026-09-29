import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import { FrameReader, encodeFrame, FRAME_LIMIT, WINDOW, CHUNK_LIMIT } from "../bridge-wire.mjs";
import { BridgePeer } from "../bridge-peer.mjs";
const id = "a".repeat(32);
function pair(t, onRequest) {
  const a = new PassThrough(), b = new PassThrough();
  const service = new BridgePeer(a, b, { onRequest });
  const edge = new BridgePeer(b, a, { initiator: true });
  t.after(() => { edge.close(); service.close(); });
  return { edge, service, a, b };
}
async function until(fn) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(10); }
  assert.fail("Expected bridge transition");
}

test("binary framing survives every byte split and coalesced frames", () => {
  const input = { type: "data", id, sequence: 0, bytes: Uint8Array.from([0, 255, 13, 10, 128]) };
  const framed = Buffer.concat([encodeFrame(input), encodeFrame({ type: "end", id })]);
  const frames = [];
  const reader = new FrameReader((f) => frames.push(f));
  for (const byte of framed) reader.push(Buffer.from([byte]));
  reader.end();
  assert.deepEqual([...frames[0].bytes], [...input.bytes]);
  assert.equal(frames[1].type, "end");
  const batched = [];
  new FrameReader((f) => batched.push(f)).push(framed);
  assert.equal(batched.length, 2);
});

test("framing rejects oversize, truncation, duplicate keys and indefinite CBOR before dispatch", () => {
  const malformed = [Buffer.from([0, 0, 0, 0]), Buffer.from([0, 4, 0, 1])];
  // Duplicate 'v', indefinite map, excessive nesting, trailing CBOR, huge map declaration.
  for (const hex of ["a2617601617601", "bfff", "a16161a16161a16161a16161a0", "a000", "ba00ffffff"]) {
    const body = Buffer.from(hex, "hex");
    const head = Buffer.alloc(4); head.writeUInt32BE(body.length);
    malformed.push(Buffer.concat([head, body]));
  }
  for (const bytes of malformed) {
    const reader = new FrameReader(() => assert.fail("Malformed frame delivered"));
    assert.throws(() => reader.push(bytes));
    assert.equal(reader.failed, true);
  }
  const reader = new FrameReader(() => {});
  reader.push(encodeFrame({ type: "end", id }).subarray(0, 8));
  assert.throws(() => reader.end(), /Truncated/);
  assert.throws(() => encodeFrame({ type: "request", id, method: "CONNECT", route: "/mcp", headers: {} }));
  assert.throws(() => encodeFrame({ type: "request", id, method: "GET", route: "/other", headers: {} }));
  assert.throws(() => encodeFrame({ type: "data", id, sequence: 0, bytes: new Uint8Array(FRAME_LIMIT) }));
});

test("streaming larger than the credit window preserves bytes and response ordering", async (t) => {
  const expected = Buffer.alloc(WINDOW * 5, 197);
  const { edge, service } = pair(t, async (_request, stream) => {
    const hash = createHash("sha256");
    for await (const bytes of stream.body()) hash.update(bytes);
    await stream.respond(200, { "content-type": "application/octet-stream" });
    await stream.send(Buffer.from(hash.digest("hex")));
    await stream.end();
  });
  const stream = await edge.open("POST", "/mcp", {});
  for (let offset = 0; offset < expected.length; offset += CHUNK_LIMIT) await stream.send(expected.subarray(offset, offset + CHUNK_LIMIT));
  await stream.end();
  assert.equal((await stream.response).status, 200);
  const output = [];
  for await (const bytes of stream.body()) output.push(bytes);
  assert.equal(Buffer.concat(output).toString(), createHash("sha256").update(expected).digest("hex"));
  await until(() => edge.streams.size === 0 && service.streams.size === 0);
});

test("slow consumer stops the producer at its credit budget", async (t) => {
  let received;
  const { edge } = pair(t, (_request, stream) => { received = stream; });
  const stream = await edge.open("POST", "/mcp", {});
  await until(() => received);
  await stream.send(Buffer.alloc(WINDOW, 7));
  let completed = false;
  const pending = stream.send(Buffer.alloc(CHUNK_LIMIT, 9)).then(() => { completed = true; });
  await sleep(30);
  assert.equal(completed, false);
  assert.equal(received.buffered, WINDOW);
  const consuming = (async () => { for await (const _chunk of received.body()) {} })();
  await pending; await stream.end(); await consuming;
  assert.equal(completed, true);
  received.cancel();
});

test("EOF aborts blocked streams and new peers cannot reuse old request IDs", async (t) => {
  const { edge, service } = pair(t, () => {});
  const stream = await edge.open("POST", "/mcp", {});
  await stream.send(Buffer.alloc(WINDOW));
  const sending = stream.send(Buffer.alloc(1));
  const rejected = assert.rejects(sending, /disconnected/);
  service.close();
  // In real OS pipes close produces EOF; explicitly close the paired half here.
  edge.close();
  await rejected;
  assert.equal(stream.signal.aborted, true);
  await assert.rejects(edge.open("GET", "/mcp", {}));
  const fresh = pair(t, () => {});
  await fresh.edge.ready;
  await fresh.service.write({ type: "response", id: stream.id, status: 200, headers: {} });
  await until(() => fresh.edge.closed);
});

test("invalid sequence, duplicate request and pre-handshake traffic fence the connection", async (t) => {
  for (const mode of ["sequence", "duplicate"]) {
    const { edge, service } = pair(t, () => {});
    const stream = await edge.open("POST", "/mcp", {});
    if (mode === "sequence") await edge.write({ type: "data", id: stream.id, sequence: 3, bytes: new Uint8Array([1]) });
    else await edge.write({ type: "request", id: stream.id, method: "GET", route: "/mcp", headers: {} });
    await until(() => service.closed);
  }
  const input = new PassThrough(), output = new PassThrough();
  const peer = new BridgePeer(input, output);
  t.after(() => peer.close());
  input.write(encodeFrame({ type: "end", id }));
  assert.equal(peer.closed, true);
});
