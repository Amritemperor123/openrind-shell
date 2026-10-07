import { randomBytes } from 'node:crypto';
import { BrowserFault, LIMITS } from '@openrind/browser-contract';

export function createDesktopWebviewProvider({ broker, clock = Date.now } = {}) {
  if (!broker) throw new Error('OwnedContentsBroker is required');

  const capabilities = {
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
  };

  const activeSessions = new Map();

  return {
    kind: 'desktop-webview',
    capabilities,

    async create(spec, ctx) {
      if (ctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
      if (spec.provider !== 'desktop-webview') throw new BrowserFault('CAPABILITY_UNAVAILABLE');

      const sessionId = `bs_${randomBytes(16).toString('hex')}`;
      const owner = ctx?.owner || 'desktop_owner';
      const handle = `dw_${randomBytes(16).toString('hex')}`;

      // Check if an existing active view is already open in the Desktop window
      let activeViewId = null;
      let activeDocGen = 1;
      let activeOwner = owner;

      for (const [vId, rec] of broker.views) {
        if (!rec.wc.isDestroyed() && !rec.fenced) {
          activeViewId = vId;
          activeDocGen = rec.documentGeneration;
          activeOwner = rec.owner;
          break;
        }
      }

      let viewId = activeViewId;
      let documentGeneration = activeDocGen;
      let effectiveOwner = activeOwner;

      if (!viewId) {
        const created = broker.createView({
          owner,
          sessionId,
          conversationId: spec.conversationId,
          allowedOrigins: spec.allowedOrigins || [],
        });
        viewId = created.viewId;
        documentGeneration = created.documentGeneration;
        effectiveOwner = owner;
      }

      const pageId = `bp_${randomBytes(12).toString('hex')}`;
      let currentDocGen = documentGeneration;
      const targetInitialUrl = typeof spec.initialUrl === 'string' ? spec.initialUrl : (spec.initialUrl?.href || 'about:blank');
      let currentUrl = targetInitialUrl;

      const pageDriver = {
        pageId,
        get documentGeneration() { return currentDocGen; },
        async navigate(url, nctx) {
          if (nctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
          const target = typeof url === 'string' ? url : (url?.href || 'about:blank');
          const res = await broker.navigate(viewId, effectiveOwner, target);
          currentDocGen = res.documentGeneration;
          currentUrl = typeof res?.url === 'string' ? res.url : target;
          await broker.initDebugger(viewId, effectiveOwner).catch(() => {});
          return res;
        },
        async snapshot(options, sctx) {
          if (sctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
          return broker.snapshot(viewId, effectiveOwner, options);
        },
        async act(action, actx) {
          if (actx?.signal?.aborted) throw new BrowserFault('CANCELLED');
          return broker.act(viewId, effectiveOwner, action);
        },
        async screenshot(options, sctx) {
          if (sctx?.signal?.aborted) throw new BrowserFault('CANCELLED');
          return broker.screenshot(viewId, effectiveOwner, options);
        },
        async close() {
          if (!activeViewId) {
            broker.destroyView(viewId);
          }
        },
      };

      const session = {
        handle,
        capabilities,
        async pages() {
          return [{ pageId, documentGeneration: currentDocGen, url: typeof currentUrl === 'string' ? currentUrl : (currentUrl?.href || 'about:blank') }];
        },
        async openPage(url, opctx) {
          if (url) await pageDriver.navigate(url, opctx);
          return { pageId, documentGeneration: currentDocGen, url: currentUrl };
        },
        page(id) {
          if (id !== pageId) throw new BrowserFault('SESSION_LOST');
          return pageDriver;
        },
        async setHumanControl(active) {
          // In sidebar mode, human control controls whether native overlay/shield is visible
        },
        async close() {
          broker.destroyView(viewId);
          activeSessions.delete(handle);
        },
      };

      activeSessions.set(handle, { session, viewId, owner, sessionId });

      try {
        await pageDriver.navigate(currentUrl, ctx);
      } catch (err) {
        await session.close().catch(() => {});
        throw err;
      }

      return session;
    },

    async recover(record, _ctx) {
      const active = activeSessions.get(record.handle);
      if (!active) return { lost: true, reason: 'Embedded view unavailable' };
      return active.session;
    },

    async close(session, _reason) {
      const handle = typeof session === 'string' ? session : session.handle;
      const active = activeSessions.get(handle);
      if (active) {
        activeSessions.delete(handle);
        await active.session.close().catch(() => {});
      }
      return { closed: true };
    },
  };
}
