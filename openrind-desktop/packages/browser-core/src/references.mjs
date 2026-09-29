import { BrowserFault, LIMITS } from '@openrind/browser-contract';
import { newId } from './security.mjs';

export class References {
  constructor({ clock = Date.now } = {}) { this.clock = clock; this.refs = new Map(); }
  invalidate(sessionId, pageId) {
    for (const [ref, record] of this.refs) if (record.sessionId === sessionId && (!pageId || record.pageId === pageId)) this.refs.delete(ref);
  }
  snapshot(raw, context, options) {
    if (!Number.isSafeInteger(raw.documentGeneration) || raw.documentGeneration < 1 || !Array.isArray(raw.nodes)) throw new BrowserFault('BACKEND_UNAVAILABLE');
    this.invalidate(context.sessionId, context.pageId);
    let remaining = options.maxNodes, bytes = options.maxTextBytes, truncated = false;
    const text = value => {
      if (typeof value !== 'string') return undefined;
      const source = Buffer.from(value); const length = Math.min(source.length, bytes);
      bytes -= length; if (length < source.length) truncated = true;
      // Avoid splitting a multibyte character into malformed output.
      return source.subarray(0, length).toString('utf8').replace(/\uFFFD$/u, '');
    };
    const walk = (nodes, depth) => {
      const output = [];
      for (const node of nodes) {
        if (remaining <= 0 || depth > options.depth || bytes <= 0) { truncated = true; break; }
        remaining--;
        if (!['element', 'text', 'frame-boundary'].includes(node.kind) || typeof node.frameId !== 'string' || node.frameId.length > 128) throw new BrowserFault('BACKEND_UNAVAILABLE');
        const safe = { kind: node.kind, frameId: node.frameId };
        for (const key of ['role', 'name', 'text']) if (node[key] !== undefined) safe[key] = text(node.sensitive ? '[redacted]' : node[key]);
        for (const key of ['editable', 'checked', 'disabled']) if (typeof node[key] === 'boolean') safe[key] = node[key];
        if (node.handle !== undefined && !node.sensitive) {
          safe.ref = newId('br');
          this.refs.set(safe.ref, { ...context, frameId: node.frameId, generation: raw.documentGeneration,
            handle: node.handle, expiresAt: this.clock() + LIMITS.idleMs });
        }
        if (Array.isArray(node.children)) safe.children = walk(node.children, depth + 1);
        output.push(safe);
      }
      return output;
    };
    return { protocol: 1, documentGeneration: raw.documentGeneration, nodes: walk(raw.nodes, 1), truncated };
  }
  resolve(ref, context, generation) {
    const record = this.refs.get(ref);
    if (!record || record.expiresAt <= this.clock() || record.generation !== generation ||
      ['owner', 'sessionId', 'sessionEpoch', 'pageId'].some(key => record[key] !== context[key])) throw new BrowserFault('STALE_REF');
    return Object.freeze({ handle: record.handle, frameId: record.frameId, documentGeneration: record.generation });
  }
}
