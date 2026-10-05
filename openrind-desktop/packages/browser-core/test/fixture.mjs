// Test-only deterministic provider. Never exported by browser-providers.
export function fixtureProvider({ act, create, close, profile = 'ephemeral', snapshotNodes } = {}) {
  const events = [], resources = new Map(); let next = 0;
  const capabilities = { protocol: 1, provider: 'local-chromium', driver: 'playwright', browserVersion: 'TEST-ONLY',
    navigation: true, semanticSnapshot: true, elementActions: true, crossOriginFrames: false,
    screenshots: false, fileUpload: false, fileDownload: false, managedPopups: false, backgroundAutomation: true,
    manualControl: 'local-window', profiles: profile, reconnect: 'existing-session', networkEnforcement: 'application-guardrails' };
  return { kind: 'local-chromium', capabilities, events,
    async create(spec, ctx) {
      events.push('create'); await create?.(spec, ctx);
      const pages = new Map();
      function add(url = 'about:blank') {
        const record = { pageId: `bp_fixture_${++next}`, documentGeneration: 1, url };
        pages.set(record.pageId, record); return record;
      }
      add(spec.initialUrl?.href);
      const session = { handle: `fixture_${++next}`, capabilities,
        async pages() { return [...pages.values()].map(p => ({ ...p })); },
        async openPage(url) { return { ...add(url.href) }; },
        async setHumanControl(active) { events.push(active ? 'human' : 'agent'); },
        page(id) {
          const record = pages.get(id); if (!record) throw new Error('Unknown fixture page');
          return { pageId: id,
            async navigate(url) { events.push('navigate'); record.url = url.href; record.documentGeneration++; return { url: record.url, documentGeneration: record.documentGeneration }; },
            async snapshot() { events.push('snapshot'); return { documentGeneration: record.documentGeneration,
              nodes: snapshotNodes || [{ kind: 'element', frameId: 'frame_fixture', role: 'button', name: 'Submit', handle: { fixtureNode: 1 } },
                { kind: 'element', frameId: 'frame_fixture', role: 'textbox', name: 'private value', text: 'secret fixture text', sensitive: true, handle: 2 }] }; },
            async act(action, ctx) { events.push(action.kind); await act?.(action, ctx); },
            async close() { pages.delete(id); },
          };
        },
      };
      resources.set(session.handle, session); return session;
    },
    async recover(record) { return resources.get(record.handle) || { lost: true, reason: 'fixture resource absent' }; },
    async close(session, reason) { events.push('close'); if (close) return close(session, reason); resources.delete(session.handle); return { closed: true }; },
  };
}
