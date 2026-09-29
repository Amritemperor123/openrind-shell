import { randomBytes } from "node:crypto";
import { FrameReader, encodeFrame, WINDOW, CHUNK_LIMIT } from "./bridge-wire.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  // Rejection may precede the HTTP consumer attaching; consumers still see it.
  promise.catch(() => {});
  return { promise, resolve, reject };
};

class BridgeStream {
  constructor(peer, id, outbound) {
    this.peer = peer; this.id = id; this.outbound = outbound;
    this.sendCredit = 0; this.receiveCredit = WINDOW;
    this.sentSequence = 0; this.receivedSequence = 0;
    this.queue = []; this.buffered = 0; this.sentEnd = false; this.receivedEnd = false;
    this.controller = new AbortController(); this.signal = this.controller.signal;
    this.headers = deferred(); this.response = this.headers.promise;
    this.timer = setTimeout(() => this.cancel(), 120_000); this.timer.unref();
  }
  async respond(status, headers) {
    if (this.outbound || this.responded) throw new Error("Invalid response transition");
    this.responded = true;
    await this.peer.write({ type: "response", id: this.id, status, headers });
  }
  async send(bytes) {
    if (this.sending || this.sentEnd || (!this.outbound && !this.responded)) throw new Error("Invalid send transition");
    if (bytes.length > WINDOW) throw new Error("Unbounded producer chunk");
    this.sending = true;
    try {
      for (let offset = 0; offset < bytes.length;) {
        this.check();
        if (!this.sendCredit) { this.creditWait = deferred(); await this.creditWait.promise; continue; }
        const length = Math.min(this.sendCredit, CHUNK_LIMIT, bytes.length - offset);
        this.sendCredit -= length;
        await this.peer.write({ type: "data", id: this.id, sequence: this.sentSequence++, bytes: bytes.subarray(offset, offset + length) });
        offset += length;
      }
    } finally { this.sending = false; }
  }
  async end() {
    this.check();
    if (this.sentEnd || this.sending || (!this.outbound && !this.responded)) throw new Error("Invalid end transition");
    this.sentEnd = true;
    await this.peer.write({ type: "end", id: this.id });
    this.retire();
  }
  async *body() {
    if (this.consuming) throw new Error("Body already consumed");
    this.consuming = true;
    try {
      while (true) {
        this.check();
        if (this.queue.length) {
          const bytes = this.queue.shift();
          // Remains in the flow-control budget until the consumer asks for more.
          yield bytes;
          this.check();
          this.buffered -= bytes.length;
          if (!this.receivedEnd) {
            this.receiveCredit += bytes.length;
            await this.peer.write({ type: "credit", id: this.id, bytes: bytes.length });
          }
        } else if (this.receivedEnd) { this.retire(); return; }
        else { this.dataWait = deferred(); await this.dataWait.promise; }
      }
    } finally { if ((!this.receivedEnd || this.buffered) && !this.signal.aborted) this.cancel(); }
  }
  check() { if (this.signal.aborted || this.peer.closed) throw new Error("Bridge stream disconnected"); }
  cancel() {
    if (this.signal.aborted || this.finished) return;
    void this.peer.write({ type: "cancel", id: this.id }).catch(() => {});
    this.abort();
  }
  abort() {
    clearTimeout(this.timer);
    this.controller.abort(); this.queue.length = 0; this.buffered = 0;
    const error = new Error("Bridge stream disconnected");
    this.headers.reject(error); this.creditWait?.reject(error); this.dataWait?.reject(error);
    this.peer.retire(this, true);
  }
  retire() {
    if (this.sentEnd && this.receivedEnd && !this.buffered) {
      clearTimeout(this.timer); this.finished = true; this.peer.retire(this, false);
    }
  }
}

export class BridgePeer {
  constructor(input, output, { initiator = false, onRequest, onDisconnect = () => {} } = {}) {
    this.input = input; this.output = output; this.initiator = initiator;
    this.onRequest = onRequest; this.onDisconnect = onDisconnect;
    this.streams = new Map(); this.retired = new Map(); this.readyState = deferred();
    this.ready = this.readyState.promise; this.closed = false; this.established = false;
    this.nonce = initiator ? randomBytes(16).toString("hex") : null;
    this.reader = new FrameReader((frame) => this.handle(frame));
    input.on("data", (bytes) => { try { this.reader.push(bytes); } catch { this.close(); } });
    input.on("end", () => { try { this.reader.end(); } catch { /* Fenced below. */ } this.close(); });
    input.on("error", () => this.close()); output.on("error", () => this.close());
    this.handshakeTimer = setTimeout(() => this.close(), 5000); this.handshakeTimer.unref();
    if (initiator) void this.write({ type: "hello", nonce: this.nonce }).catch(() => this.close());
  }
  async write(frame) {
    if (this.closed) throw new Error("Bridge disconnected");
    if (this.output.writableLength > 4 * 1024 * 1024) { this.close(); throw new Error("Bridge output quota"); }
    const bytes = encodeFrame(frame);
    await new Promise((resolve, reject) => this.output.write(bytes, (error) => error ? reject(error) : resolve()));
  }
  async open(method, route, headers) {
    await this.ready;
    if (!this.initiator || this.streams.size >= 32 || this.retired.size >= 1024) throw new Error("Bridge request quota");
    const id = randomBytes(16).toString("hex");
    const stream = new BridgeStream(this, id, true);
    this.streams.set(id, stream);
    try {
      await this.write({ type: "request", id, method, route, headers });
      await this.write({ type: "credit", id, bytes: WINDOW });
    } catch (error) { stream.abort(); throw error; }
    return stream;
  }
  handle(frame) {
    if (!this.established) {
      if (this.initiator) {
        if (frame.type !== "ready" || frame.nonce !== this.nonce) throw new Error("Invalid handshake");
      } else {
        if (frame.type !== "hello") throw new Error("Handshake required");
        this.nonce = frame.nonce;
        void this.write({ type: "ready", nonce: frame.nonce }).catch(() => this.close());
      }
      clearTimeout(this.handshakeTimer); this.established = true; this.readyState.resolve(); return;
    }
    if (frame.type === "hello" || frame.type === "ready") throw new Error("Repeated handshake");
    if (frame.type === "request") {
      if (this.initiator || this.streams.has(frame.id) || this.retired.has(frame.id) || this.streams.size >= 32 || this.retired.size >= 1024) {
        throw new Error("Invalid stream creation");
      }
      const stream = new BridgeStream(this, frame.id, false);
      this.streams.set(frame.id, stream);
      void this.write({ type: "credit", id: frame.id, bytes: WINDOW }).catch(() => this.close());
      Promise.resolve().then(() => this.onRequest?.(frame, stream)).catch(() => stream.cancel());
      return;
    }
    const stream = this.streams.get(frame.id);
    if (!stream) {
      const retired = this.retired.get(frame.id);
      // Credit may already be in the opposite pipe when completion crosses it.
      if (retired && frame.type === "credit") return;
      if (retired?.cancelled && ["cancel", "end", "response"].includes(frame.type)) return;
      if (retired?.cancelled && frame.type === "data" && (retired.remaining -= frame.bytes.length) >= 0) return;
      throw new Error("Unknown or completed stream");
    }
    if (frame.type === "credit") {
      if (stream.sendCredit + frame.bytes > WINDOW) throw new Error("Excess stream credit");
      stream.sendCredit += frame.bytes; stream.creditWait?.resolve();
    } else if (frame.type === "response") {
      if (!stream.outbound || stream.responded) throw new Error("Invalid response");
      stream.responded = true; stream.headers.resolve(frame);
    } else if (frame.type === "data") {
      if (stream.receivedEnd || (stream.outbound && !stream.responded) || frame.sequence !== stream.receivedSequence++ || frame.bytes.length > stream.receiveCredit) {
        throw new Error("Invalid stream data");
      }
      stream.receiveCredit -= frame.bytes.length; stream.buffered += frame.bytes.length;
      stream.queue.push(frame.bytes); stream.dataWait?.resolve();
    } else if (frame.type === "end") {
      if (stream.receivedEnd || (stream.outbound && !stream.responded)) throw new Error("Repeated/premature end");
      stream.receivedEnd = true; stream.dataWait?.resolve(); stream.retire();
    } else if (frame.type === "cancel") stream.abort();
  }
  retire(stream, cancelled) {
    this.streams.delete(stream.id);
    if (!this.retired.has(stream.id)) this.retired.set(stream.id, { cancelled, remaining: stream.receiveCredit });
  }
  close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.handshakeTimer);
    this.readyState.reject(new Error("Bridge disconnected"));
    for (const stream of [...this.streams.values()]) stream.abort();
    this.input.destroy(); this.output.destroy();
    this.onDisconnect();
  }
}
