import { encode, decode } from "cborg";
import { z } from "zod";

export const FRAME_LIMIT = 256 * 1024;
export const CHUNK_LIMIT = 64 * 1024;
export const WINDOW = 256 * 1024;
const id = z.string().regex(/^[a-f0-9]{32}$/);
const integer = z.number().int().min(0).max(0xffffffff);
const headers = z.record(z.string().regex(/^[a-z-]{1,64}$/), z.string().max(8192))
  .refine((h) => Object.keys(h).length <= 24 && Object.values(h).every((v) => !/[\r\n]/.test(v)));
const frame = (type, fields = {}) => z.object({ v: z.literal(1), type: z.literal(type), ...fields }).strict();
const schema = z.discriminatedUnion("type", [
  frame("hello", { nonce: id }), frame("ready", { nonce: id }),
  frame("request", { id, method: z.enum(["POST", "GET", "DELETE"]), route: z.literal("/mcp"), headers }),
  frame("response", { id, status: integer.refine((n) => n >= 200 && n <= 599), headers }),
  frame("data", { id, sequence: integer, bytes: z.instanceof(Uint8Array).refine((b) => b.length > 0 && b.length <= CHUNK_LIMIT) }),
  frame("credit", { id, bytes: integer.refine((n) => n > 0 && n <= WINDOW) }),
  frame("end", { id }), frame("cancel", { id }),
]);

// This envelope uses only unsigned integers, strings, bytes and bounded maps.
// Preflight before CBOR allocation/recursion; cborg then enforces canonical
// integer widths, valid UTF-8, duplicate-key rejection and complete consumption.
function preflight(bytes) {
  let offset = 0;
  function item(depth) {
    if (depth > 3 || offset >= bytes.length) throw new Error("Invalid CBOR structure");
    const head = bytes[offset++];
    const major = head >> 5;
    const info = head & 31;
    if (![0, 2, 3, 5].includes(major) || info > 26) throw new Error("Unsupported CBOR value");
    let length = info;
    if (info >= 24) {
      const count = 1 << (info - 24);
      if (offset + count > bytes.length) throw new Error("Truncated CBOR length");
      length = 0;
      for (let i = 0; i < count; i++) length = length * 256 + bytes[offset++];
    }
    if (major === 0) return;
    if (major === 5) {
      if (length > 24) throw new Error("CBOR map too large");
      for (let i = 0; i < length * 2; i++) item(depth + 1);
      return;
    }
    if (length > (major === 2 ? CHUNK_LIMIT : 8192) || offset + length > bytes.length) {
      throw new Error("Invalid CBOR content length");
    }
    offset += length;
  }
  item(0);
  if (offset !== bytes.length) throw new Error("Trailing CBOR data");
}

export function encodeFrame(value) {
  const bytes = encode(schema.parse({ v: 1, ...value }));
  if (!bytes.length || bytes.length > FRAME_LIMIT) throw new Error("Frame too large");
  const output = Buffer.allocUnsafe(bytes.length + 4);
  output.writeUInt32BE(bytes.length);
  output.set(bytes, 4);
  return output;
}

export class FrameReader {
  constructor(onFrame) { this.onFrame = onFrame; this.header = Buffer.alloc(4); this.offset = 0; this.body = null; this.failed = false; }
  push(chunk) {
    if (this.failed) throw new Error("Reader fenced");
    try {
      let cursor = 0;
      while (cursor < chunk.length) {
        const target = this.body ?? this.header;
        const count = Math.min(chunk.length - cursor, target.length - this.offset);
        target.set(chunk.subarray(cursor, cursor + count), this.offset);
        cursor += count; this.offset += count;
        if (this.offset !== target.length) continue;
        this.offset = 0;
        if (!this.body) {
          const size = this.header.readUInt32BE();
          if (!size || size > FRAME_LIMIT) throw new Error("Invalid frame length");
          this.body = Buffer.allocUnsafe(size);
        } else {
          const content = this.body;
          this.body = null;
          preflight(content);
          this.onFrame(schema.parse(decode(content, { strict: true, allowIndefinite: false,
            rejectDuplicateMapKeys: true, allowBigInt: false, allowUndefined: false, allowNaN: false, allowInfinity: false })));
        }
      }
    } catch (error) { this.failed = true; this.body = null; throw error; }
  }
  end() {
    if (this.offset || this.body) { this.failed = true; throw new Error("Truncated bridge frame"); }
  }
}
