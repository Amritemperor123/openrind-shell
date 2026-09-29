import { createBrowserService } from './index.mjs';
// Bootstrap factory only: opening a registry does not publish an unauthenticated
// HTTP listener or claim that a standalone deployment is installed.
export function createStandaloneService(config) {
  if (!config?.databasePath) throw new Error('Private service registry path required');
  return createBrowserService(config);
}
