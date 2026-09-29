import { Capabilities, BrowserFault } from '@openrind/browser-contract';
export function providerRegistry(providers = []) {
  const registry = new Map();
  for (const provider of providers) {
    Capabilities.parse(provider.capabilities);
    if (registry.has(provider.kind) || provider.kind !== provider.capabilities.provider ||
        ['create', 'recover', 'close'].some(name => typeof provider[name] !== 'function')) throw new BrowserFault('BACKEND_UNAVAILABLE');
    registry.set(provider.kind, provider);
  }
  return registry;
}
// Deliberately no installed providers yet. A fixture is never a production fallback.
export const installedProviders = Object.freeze([]);
