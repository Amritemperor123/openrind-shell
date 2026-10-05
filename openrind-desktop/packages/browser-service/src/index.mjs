import { dirname, join } from 'node:path';
import { BrowserCore, Repository, ArtifactsManager } from '@openrind/browser-core';
import { toolDefinitions } from '@openrind/browser-contract';
import { installedProviders, providerRegistry } from '@openrind/browser-providers';
export function createBrowserService({ databasePath, providers = installedProviders, ...options }) {
  const registry = providerRegistry(providers);
  const repository = new Repository(databasePath, options);
  const artifactsDir = options.stagingDir || join(dirname(databasePath), 'artifacts');
  const artifacts = options.artifacts || new ArtifactsManager({ stagingDir: artifactsDir });
  try {
    const core = new BrowserCore({ repository, providers: [...registry.values()], artifacts, ...options });
    return Object.freeze({ core, tools: toolDefinitions(),
      invoke: (credential, name, args, context) => core.call(credential, name, args, context),
      shutdown: () => core.shutdown() });
  } catch (error) { repository.close(); throw error; }
}
