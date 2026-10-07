import { BrowserFault, LIMITS } from '@openrind/browser-contract';
import { newId } from './security.mjs';

export class References {
  constructor({ clock = Date.now } = {}) { this.clock = clock; this.refs = new Map(); }
  invalidate(sessionId, pageId) {
    for (const [ref, record] of this.refs) if (record.sessionId === sessionId && (!pageId || record.pageId === pageId)) this.refs.delete(ref);
  }
  snapshot(raw, context, options) {
    if (!Number.isSafeInteger(raw.documentGeneration) || raw.documentGeneration < 1 || !Array.isArray(raw.nodes)) throw new BrowserFault('BACKEND_UNAVAILABLE');
    // Only purge records from older document generations for this page;
    // preserve references from the current document generation.
    for (const [ref, record] of this.refs) {
      if (record.sessionId === context.sessionId && (!context.pageId || record.pageId === context.pageId)) {
        if (record.generation !== raw.documentGeneration) {
          this.refs.delete(ref);
        }
      }
    }
    let remaining = options.maxNodes, bytes = options.maxTextBytes, truncated = false;
    const text = value => {
      if (typeof value !== 'string') return undefined;
      const source = Buffer.from(value); const length = Math.min(source.length, bytes);
      bytes -= length; if (length < source.length) truncated = true;
      // Avoid splitting a multibyte character into malformed output.
      return source.subarray(0, length).toString('utf8').replace(/\uFFFD$/u, '');
    };
    const interactiveControls = [];
    let counter = 0;

    const walk = (nodes, depth) => {
      const output = [];
      for (const node of nodes) {
        if (remaining <= 0 || depth > options.depth || bytes <= 0) { truncated = true; break; }
        remaining--;
        if (!['element', 'text', 'frame-boundary'].includes(node.kind) || typeof node.frameId !== 'string' || node.frameId.length > 128) throw new BrowserFault('BACKEND_UNAVAILABLE');
        const safe = { kind: node.kind, frameId: node.frameId };
        for (const key of ['role', 'name', 'text']) if (node[key] !== undefined) safe[key] = text(node.sensitive ? '[redacted]' : node[key]);
        for (const key of ['editable', 'checked', 'disabled', 'inViewport', 'hitTestable']) if (typeof node[key] === 'boolean') safe[key] = node[key];
        if (node.bounds && typeof node.bounds === 'object') {
          safe.bounds = {
            x: Number(node.bounds.x) || 0,
            y: Number(node.bounds.y) || 0,
            width: Number(node.bounds.width) || 0,
            height: Number(node.bounds.height) || 0,
          };
        }
        if (Array.isArray(node.center) && node.center.length === 2) {
          safe.center = [Number(node.center[0]) || 0, Number(node.center[1]) || 0];
        }
        if (node.handle !== undefined && !node.sensitive) {
          // Re-use existing ref for this handle on the same document generation if possible
          let ref = null;
          for (const [r, rec] of this.refs) {
            if (rec.sessionId === context.sessionId && rec.pageId === context.pageId &&
                rec.generation === raw.documentGeneration && rec.handle === node.handle) {
              ref = r;
              break;
            }
          }
          if (!ref) {
            counter++;
            ref = `@e${counter}`;
          }
          safe.ref = ref;
          const rec = { ...context, frameId: node.frameId, generation: raw.documentGeneration,
            handle: node.handle, bounds: safe.bounds, center: safe.center, expiresAt: this.clock() + LIMITS.idleMs };
          this.refs.set(safe.ref, rec);
          if (safe.ref.startsWith('@')) {
            this.refs.set(safe.ref.slice(1), rec);
          }
          interactiveControls.push({
            ref: safe.ref,
            role: safe.role || 'element',
            name: safe.name || '',
            bounds: safe.bounds,
            center: safe.center,
            inViewport: safe.inViewport !== false,
            hitTestable: safe.hitTestable === true,
            editable: safe.editable,
            checked: safe.checked,
            disabled: safe.disabled,
          });
        }
        if (Array.isArray(node.children)) safe.children = walk(node.children, depth + 1);
        output.push(safe);
      }
      return output;
    };
    const walkedNodes = walk(raw.nodes, 1);

    // Build model-friendly interactive controls summary
    const inViewportControls = [];
    const offscreenControls = [];
    for (const c of interactiveControls) {
      const isActuallyInViewport = c.inViewport && (c.bounds ? c.bounds.width > 0 && c.bounds.height > 0 && c.bounds.x >= -50 && c.bounds.y >= -50 : true);
      if (isActuallyInViewport) {
        inViewportControls.push(c);
      } else {
        offscreenControls.push(c);
      }
    }
    inViewportControls.sort((a, b) => {
      const ay = a.bounds ? a.bounds.y : 0;
      const by = b.bounds ? b.bounds.y : 0;
      const ax = a.bounds ? a.bounds.x : 0;
      const bx = b.bounds ? b.bounds.x : 0;
      if (Math.abs(ay - by) > 15) return ay - by;
      return ax - bx;
    });

    const summaryLines = ['=== Interactive Controls (in viewport) ==='];
    if (inViewportControls.length === 0) {
      summaryLines.push('(No interactive controls visible in viewport)');
    } else {
      for (const c of inViewportControls) {
        const boundsStr = c.bounds ? ` (bounds: x=${c.bounds.x}, y=${c.bounds.y}, w=${c.bounds.width}, h=${c.bounds.height})` : '';
        const centerStr = c.center ? ` [center: (${c.center[0]}, ${c.center[1]})]` : '';
        const flags = [];
        if (c.hitTestable) flags.push('hit-testable');
        if (c.editable) flags.push('editable');
        if (c.checked) flags.push('checked');
        if (c.disabled) flags.push('disabled');
        const flagsStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
        const nameStr = c.name ? ` "${c.name}"` : '';
        summaryLines.push(`- ${c.role}${nameStr} [ref=${c.ref}]${boundsStr}${centerStr}${flagsStr}`.trim());
      }
    }
    if (offscreenControls.length > 0) {
      summaryLines.push('');
      summaryLines.push(`=== Off-screen / Scrolled Controls (${offscreenControls.length} controls below fold or off-screen) ===`);
      for (const c of offscreenControls.slice(0, 20)) {
        const boundsStr = c.bounds ? ` (bounds: x=${c.bounds.x}, y=${c.bounds.y}, w=${c.bounds.width}, h=${c.bounds.height})` : '';
        const nameStr = c.name ? ` "${c.name}"` : '';
        summaryLines.push(`- ${c.role}${nameStr} [ref=${c.ref}]${boundsStr} [off-screen]`.trim());
      }
      if (offscreenControls.length > 20) {
        summaryLines.push(`  ... and ${offscreenControls.length - 20} more off-screen controls`);
      }
    }

    return { protocol: 1, documentGeneration: raw.documentGeneration, summary: summaryLines.join('\n'), nodes: walkedNodes, truncated };
  }
  resolve(ref, context, generation) {
    const rawRef = String(ref);
    const cleanRef = rawRef.startsWith('@') ? rawRef.slice(1) : `@${rawRef}`;
    const record = this.refs.get(rawRef) || this.refs.get(cleanRef);
    if (!record || record.expiresAt <= this.clock() || record.generation !== generation ||
      ['owner', 'sessionId', 'sessionEpoch', 'pageId'].some(key => record[key] !== context[key])) throw new BrowserFault('STALE_REF');
    return Object.freeze({ handle: record.handle, frameId: record.frameId, documentGeneration: record.generation, bounds: record.bounds, center: record.center });
  }
}
