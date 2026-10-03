import { browserBinding } from './browser-binding.mjs';
import { buildFuseCliCommand, buildFuseWslEnv, runFuseOpenShell, resolveFuseRuntimeConfig } from './fuse-runtime.mjs';
import { DISTRO_NAME, wslRun } from './wsl.mjs';

// Called by trusted sandbox provisioning after the private service is ready.
// No renderer-provided profile files, shell commands or credential arguments.
export async function attachBrowserProvider({ endpoint, bridgeAddress, bindingId, sandboxName, serviceToken }) {
  if (typeof sandboxName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sandboxName) ||
      typeof serviceToken !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(serviceToken)) {
    throw new Error('Invalid browser provider provisioning');
  }
  const binding = browserBinding({ endpoint, bridgeAddress, bindingId });
  const run = async (args, options = {}) => {
    const response = await runFuseOpenShell(args, { ensure: false, timeout: 20_000, ...options });
    if (response.exitCode !== 0) throw new Error('Browser provider provisioning failed');
    return response;
  };
  // The existing CLI requires a .json/.yaml suffix. Stage only the non-secret
  // profile in a private temporary file and remove that exact file on exit.
  const { bin, gatewayEndpoint } = resolveFuseRuntimeConfig();
  const pyScript = [
    'import sys, tempfile, subprocess, os',
    'f = tempfile.NamedTemporaryFile(suffix=".json", dir="/tmp", delete=False)',
    'f.write(sys.stdin.buffer.read())',
    'f.close()',
    'path = f.name',
    'try:',
    `    res = subprocess.run([${JSON.stringify(bin)}, "--gateway-endpoint", ${JSON.stringify(gatewayEndpoint)}, "provider", "profile", "import", "--file", path], capture_output=True, text=True)`,
    '    if res.returncode != 0:',
    '        sys.stderr.write(res.stderr or res.stdout)',
    '        sys.exit(res.returncode)',
    '    sys.stdout.write(res.stdout)',
    'finally:',
    '    if os.path.exists(path): os.unlink(path)',
  ].join('\n');
  const imported = await wslRun(['-d', DISTRO_NAME, '--', 'python3', '-c', pyScript],
    { timeout: 20_000, stdin: JSON.stringify(binding.profile) });
  if (imported.exitCode !== 0) throw new Error(`Browser provider profile import failed: ${imported.stderr || imported.stdout}`);
  // A launch binding is unique; create failure must not update someone else's
  // provider or rotate a credential underneath another active sandbox.
  await run(['provider', 'create', '--name', binding.name, '--type', binding.name,
    '--credential', 'OPENRIND_BROWSER_SERVICE_TOKEN'], {
    env: buildFuseWslEnv({ OPENRIND_BROWSER_SERVICE_TOKEN: serviceToken }),
  });
  try {
    await run(['sandbox', 'provider', 'attach', sandboxName, binding.name]);
  } catch {
    // Delete only the provider this invocation successfully created.
    const cleanup = await runFuseOpenShell(['provider', 'delete', binding.name], { ensure: false, timeout: 20_000 });
    throw new Error(cleanup.exitCode === 0 ? 'Browser provider attachment failed' :
      'Browser provider attachment failed; provider cleanup is pending');
  }
  let detached = false;
  let providerRemoved = false;
  let removed = false;
  let cleanup;
  return Object.freeze({ name: binding.name, descriptor: binding.descriptor, networkPolicy: binding.networkPolicy,
    // Revoke the worker grant before invoking this host-side credential cleanup.
    detach() {
      if (removed) return Promise.resolve();
      return cleanup ??= (async () => {
        if (!detached) {
          await run(['sandbox', 'provider', 'detach', sandboxName, binding.name]);
          detached = true;
        }
        if (!providerRemoved) {
          await run(['provider', 'delete', binding.name]);
          providerRemoved = true;
        }
        await run(['provider', 'profile', 'delete', binding.name]);
        removed = true;
      })().finally(() => { cleanup = undefined; });
    },
  });
}
