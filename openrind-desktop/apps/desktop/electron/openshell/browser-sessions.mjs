import { attachBrowserProvider } from './browser-provider.mjs';
import { createBrowserPtyLease } from './browser-pty-lease.mjs';
import { installBrowserSandbox } from './browser-install.mjs';

// Trusted main-process coordinator. installSandbox must provision the immutable
// descriptor and merge the native-only network policy using the existing host
// provisioning authority. Scope and policy come from authenticated host state.
export function createBrowserSessions({ runtime, installSandbox = installBrowserSandbox }) {
  if (!runtime || typeof installSandbox !== 'function') throw new Error('Browser provisioning authority is required');
  const sandboxes = new Map();
  let closed = false;
  let closing;
  const retire = async entry => {
    entry.retired = true;
    const failures = [];
    for (const lease of [...entry.leases]) {
      if (!runtime.ready) {
        entry.leases.delete(lease);
        continue;
      }
      try { await lease.stop(); } catch { failures.push(true); }
    }
    try { await entry.preparing; } catch { /* Preparation reports its own failure. */ }
    if (entry.provider) {
      try { await entry.provider.detach(); } catch { failures.push(true); }
    }
    if (failures.length && runtime.ready) throw new Error('Browser sandbox cleanup is incomplete');
  };
  return Object.freeze({
    async prepare({ sandboxName, scope, policy, onLost }) {
      if (closed || !runtime.ready) throw new Error('Browser runtime is unavailable');
      let entry = sandboxes.get(sandboxName);
      if (!entry) {
        entry = { leases: new Set(), retired: false, provider: undefined, preparing: undefined };
        sandboxes.set(sandboxName, entry);
        entry.preparing = (async () => {
          const provider = await attachBrowserProvider({ ...runtime, sandboxName,
            bindingId: `${runtime.bindingId}_${sandboxName}` });
          entry.provider = provider;
          await installSandbox({ sandboxName, descriptor: provider.descriptor, networkPolicy: provider.networkPolicy });
        })();
      }
      try { await entry.preparing; }
      catch (error) {
        entry.retired = true;
        try { await entry.provider?.detach().catch(() => {}); }
        finally {
          if (sandboxes.get(sandboxName) === entry) {
            sandboxes.delete(sandboxName);
          }
        }
        throw new Error('Browser sandbox provisioning failed');
      }
      if (closed || entry.retired || !runtime.ready) throw new Error('Browser sandbox is unavailable');
      const lease = await createBrowserPtyLease(runtime, scope, policy, { onLost });
      if (closed || entry.retired) {
        await lease.stop();
        throw new Error('Browser sandbox closed during launch');
      }
      let stopped;
      const tracked = Object.freeze({ token: lease.token, activate: lease.activate,
        stop() {
          return stopped ??= lease.stop().then(() => { entry.leases.delete(tracked); }, error => {
            stopped = undefined; throw error;
          });
        },
      });
      entry.leases.add(tracked);
      return tracked;
    },
    async removeSandbox(sandboxName) {
      const entry = sandboxes.get(sandboxName);
      if (!entry) return;
      await retire(entry);
      sandboxes.delete(sandboxName);
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        const results = await Promise.allSettled([...sandboxes.values()].map(retire));
        await runtime.close();
        if (results.some(result => result.status === 'rejected')) throw new Error('Browser provider cleanup is incomplete');
        sandboxes.clear();
      })();
      return closing;
    },
  });
}
