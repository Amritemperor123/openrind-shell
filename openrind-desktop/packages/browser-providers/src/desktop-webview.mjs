import { randomBytes } from 'node:crypto';
import { BrowserFault } from '@openrind/browser-contract';

export const desktopWebviewCapabilities = Object.freeze({
  protocol: 1,
  provider: 'desktop-webview',
  driver: 'electron-debugger',
  browserVersion: 'electron-sidebar',
  navigation: true,
  semanticSnapshot: true,
  elementActions: true,
  crossOriginFrames: false,
  screenshots: true,
  fileUpload: true,
  fileDownload: false,
  managedPopups: false,
  backgroundAutomation: false,
  manualControl: 'sidebar',
  profiles: 'ephemeral',
  reconnect: 'existing-session',
  networkEnforcement: 'application-guardrails',
});

const pendingCalls = new Map();

if (typeof process !== 'undefined' && typeof process.on === 'function') {
  process.on('message', (msg) => {
    if (msg?.type === 'desktop_provider_reply' && msg.id && pendingCalls.has(msg.id)) {
      const { resolve, reject, timer } = pendingCalls.get(msg.id);
      pendingCalls.delete(msg.id);
      clearTimeout(timer);
      if (msg.ok) {
        resolve(msg.result);
      } else {
        const fault = new BrowserFault(msg.code || 'BACKEND_UNAVAILABLE');
        if (msg.error) fault.message = msg.error;
        reject(fault);
      }
    }
  });
}

function callParent(method, ...args) {
  if (typeof process === 'undefined' || typeof process.send !== 'function') {
    throw new BrowserFault('BACKEND_UNAVAILABLE');
  }
  return new Promise((resolve, reject) => {
    const id = randomBytes(16).toString('hex');
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new BrowserFault('BACKEND_UNAVAILABLE'));
    }, 45_000);
    pendingCalls.set(id, { resolve, reject, timer });
    process.send({ type: 'desktop_provider_call', id, method, args });
  });
}

export function createBridgedDesktopWebviewProvider() {
  const activeSessions = new Map();

  return {
    kind: 'desktop-webview',
    capabilities: desktopWebviewCapabilities,

    async create(spec, ctx) {
      if (ctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
      if (spec.provider !== 'desktop-webview') throw new BrowserFault('CAPABILITY_UNAVAILABLE');

      const data = await callParent('create', spec);
      const { handle, pages } = data;
      const initialPageId = pages?.[0]?.pageId || `bp_${randomBytes(12).toString('hex')}`;
      let currentDocGen = pages?.[0]?.documentGeneration || 1;
      const pageUrl = typeof pages?.[0]?.url === 'string' ? pages[0].url : (pages?.[0]?.url?.href || 'about:blank');
      let currentUrl = pageUrl;

      const pageDrivers = new Map();

      function getOrCreatePageDriver(pageId) {
        if (pageDrivers.has(pageId)) return pageDrivers.get(pageId);
        const driver = {
          pageId,
          get documentGeneration() { return currentDocGen; },
          async navigate(url, nctx) {
            if (nctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
            const target = typeof url === 'string' ? url : (url?.href || 'about:blank');
            const res = await callParent('navigate', handle, pageId, target);
            currentDocGen = res.documentGeneration;
            currentUrl = typeof res?.url === 'string' ? res.url : target;
            return res;
          },
          async snapshot(options, sctx) {
            if (sctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
            return callParent('snapshot', handle, pageId, options);
          },
          async act(action, actx) {
            if (actx?.signal?.aborted) throw new BrowserFault('CANCELLED');
            return callParent('act', handle, pageId, action);
          },
          async screenshot(options, sctx) {
            if (sctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
            const res = await callParent('screenshot', handle, pageId, options);
            if (typeof res === 'string') {
              return Buffer.from(res, 'base64');
            }
            return Buffer.from(res || []);
          },
          async close() {
            pageDrivers.delete(pageId);
            return callParent('closePage', handle, pageId);
          },
        };
        pageDrivers.set(pageId, driver);
        return driver;
      }

      const initialDriver = getOrCreatePageDriver(initialPageId);

      const session = {
        handle,
        capabilities: desktopWebviewCapabilities,
        async pages() {
          return [{ pageId: initialPageId, documentGeneration: currentDocGen, url: typeof currentUrl === 'string' ? currentUrl : (currentUrl?.href || 'about:blank') }];
        },
        async openPage(url, opctx) {
          if (url) await initialDriver.navigate(url, opctx);
          return { pageId: initialPageId, documentGeneration: currentDocGen, url: currentUrl };
        },
        page(id) {
          return getOrCreatePageDriver(id);
        },
        async setHumanControl(active) {
          return callParent('setHumanControl', handle, active);
        },
        async close() {
          activeSessions.delete(handle);
          return callParent('close', handle);
        },
      };

      activeSessions.set(handle, session);
      return session;
    },

    async recover(record, _ctx) {
      const active = activeSessions.get(record.handle);
      if (!active) return { lost: true, reason: 'Embedded view unavailable' };
      return active;
    },

    async close(session, _reason) {
      const handle = typeof session === 'string' ? session : session.handle;
      const active = activeSessions.get(handle);
      if (active) {
        activeSessions.delete(handle);
        await active.close().catch(() => {});
      }
      return { closed: true };
    },
  };
}
