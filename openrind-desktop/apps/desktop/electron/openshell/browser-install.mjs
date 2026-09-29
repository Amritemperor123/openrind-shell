import { runFuseOpenShell } from './fuse-runtime.mjs';
import { DISTRO_NAME, wslRun } from './wsl.mjs';

// Host-only installation into the single running, managed FUSE container.
// The agent never receives docker access, sudo, or an arbitrary root command.
export async function installBrowserSandbox({ sandboxName, descriptor, networkPolicy }) {
  if (typeof sandboxName !== 'string' || !/^[a-z0-9][a-z0-9_.-]+$/i.test(sandboxName)) throw new Error('Invalid browser sandbox');
  const effective = await runFuseOpenShell(['policy', 'get', sandboxName, '--full', '-o', 'json'],
    { ensure: false, timeout: 20_000 });
  if (effective.exitCode !== 0) throw new Error('Browser effective policy is unavailable');
  let policy;
  try { policy = JSON.parse(effective.stdout).policy; } catch { throw new Error('Invalid browser effective policy'); }
  // Provider attachment composes its endpoint rules into the effective policy.
  // Verify that composition instead of replacing the base Haloop/FUSE policy.
  const entries = Object.values(policy?.network_policies ?? {});
  const route = networkPolicy?.endpoints?.[0];
  if (!route || descriptor?.endpoint !== new URL(`${route.tls === 'none' ? 'http' : 'https'}://${route.host}:${route.port}/mcp`).href ||
      !entries.some(entry => entry.binaries?.length === 1 && entry.binaries[0].path === '/usr/local/bin/openrind-browser-client' &&
        entry.endpoints?.length === 1 && entry.endpoints.some(endpoint => endpoint.host === route.host && endpoint.port === route.port &&
          endpoint.enforcement === 'enforce' && endpoint.tls === route.tls && endpoint.protocol === 'rest' &&
          JSON.stringify(endpoint.allowed_ips) === JSON.stringify(route.allowed_ips) &&
          endpoint.rules?.length === 3 && ['POST', 'GET', 'DELETE'].every(method =>
            endpoint.rules.some(rule => rule.allow?.method === method && rule.allow?.path === '/mcp'))))) {
    throw new Error('The native-only browser endpoint policy is not effective');
  }
  const containers = await wslRun(['-d', DISTRO_NAME, '--', 'docker', 'ps', '--no-trunc',
    '--filter', 'label=openshell.ai/managed-by=openshell',
    '--filter', `label=openshell.ai/sandbox-name=${sandboxName}`,
    '--filter', 'label=com.nvidia.openshell.fuse-requested=true', '--format', '{{.ID}}'], { timeout: 15_000 });
  const ids = containers.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (containers.exitCode !== 0 || ids.length !== 1 || !/^[a-f0-9]{64}$/.test(ids[0])) {
    throw new Error('Browser provisioning requires one uniquely identified managed FUSE container');
  }
  const installed = await wslRun(['-d', DISTRO_NAME, '--', 'docker', 'exec', '-i', '--user', '0', ids[0],
    '/usr/bin/node', '/opt/openrind-browser/provision.cjs'], {
    stdin: JSON.stringify(descriptor), timeout: 15_000,
  });
  if (installed.exitCode !== 0) throw new Error('Browser endpoint installation failed; rebuild or repair the sandbox');
}
