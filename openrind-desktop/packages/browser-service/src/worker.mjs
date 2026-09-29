import { createBrowserService } from './index.mjs';
import { createLaunchLeases } from './launch-leases.mjs';
// Electron-free trusted worker bootstrap. Do not serialize launch controls to MCP.
export function createWorkerService(config) {
  const service = createBrowserService(config);
  const launches = createLaunchLeases(service.core, { clock: config.clock });
  let sweeping;
  let stopping = false;
  const timer = setInterval(() => {
    if (stopping || sweeping) return;
    sweeping = service.core.sweep().catch(() => {}).finally(() => { sweeping = undefined; });
  }, 1000);
  timer.unref();
  return Object.freeze({ ...service, launches,
    async shutdown() {
      stopping = true; clearInterval(timer); launches.close();
      await sweeping;
      await service.shutdown();
    },
  });
}
