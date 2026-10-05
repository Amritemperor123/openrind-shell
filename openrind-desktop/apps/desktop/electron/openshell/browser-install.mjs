import { runFuseOpenShell } from './fuse-runtime.mjs';
import { DISTRO_NAME, wslRun } from './wsl.mjs';

// Host-only installation into the single running, managed FUSE container.
// The agent never receives docker access, sudo, or an arbitrary root command.
export async function installBrowserSandbox({ sandboxName, descriptor, networkPolicy, serviceToken }) {
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
      !entries.some(entry => entry.binaries?.some(b => b.path === '/usr/local/bin/openrind-browser-client') &&
        entry.endpoints?.length === 1 && entry.endpoints.some(endpoint => endpoint.host === route.host && endpoint.port === route.port &&
          endpoint.enforcement === 'enforce' && endpoint.tls === route.tls && endpoint.protocol === 'rest' &&
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
    'sh', '-c', 'mkdir -p /etc/openrind-browser /var/lib/openrind-shell/runtime && cat > /etc/openrind-browser/descriptor.json && chmod 644 /etc/openrind-browser/descriptor.json'], {
    stdin: JSON.stringify(descriptor) + '\n', timeout: 15_000,
  });
  if (installed.exitCode !== 0) throw new Error('Browser endpoint installation failed; rebuild or repair the sandbox');

  if (serviceToken) {
    const tokenRes = await wslRun(['-d', DISTRO_NAME, '--', 'docker', 'exec', '-i', '--user', '0', ids[0],
      'sh', '-c', `
        mkdir -p /etc/openrind-browser /var/lib/openrind-shell/runtime
        cat > /etc/openrind-browser/service-token
        chmod 644 /etc/openrind-browser/service-token
        cat /etc/openrind-browser/service-token > /var/lib/openrind-shell/runtime/browser-token
        chmod 644 /var/lib/openrind-shell/runtime/browser-token
        chown -R sandbox:sandbox /var/lib/openrind-shell/runtime
      `], {
      stdin: serviceToken.trim(),
      timeout: 15_000,
    }).catch(err => ({ exitCode: -1, stderr: String(err) }));
    if (tokenRes.exitCode !== 0) console.warn('[browser-install] Service token write failed:', tokenRes.stderr);
  }

  const mcpRes = await wslRun(['-d', DISTRO_NAME, '--', 'docker', 'exec', '-i', '--user', '0', ids[0],
    'sh', '-c', `
      mkdir -p /opt/openrind-browser /sandbox/claude-home
      printf '{"mcpServers":{"openrind-browser":{"type":"stdio","command":"/usr/local/bin/openrind-browser-client","args":[]}}}\\n' > /opt/openrind-browser/mcp.json
      chmod 0644 /opt/openrind-browser/mcp.json
      
      # Write MCP server directly into claude-home config
      if [ -f /sandbox/claude-home/.claude.json ]; then
        node -e 'try { const fs=require("fs"); const p="/sandbox/claude-home/.claude.json"; const c=JSON.parse(fs.readFileSync(p,"utf8")); c.mcpServers=c.mcpServers||{}; c.mcpServers["openrind-browser"]={"type":"stdio","command":"/usr/local/bin/openrind-browser-client","args":[]}; fs.writeFileSync(p,JSON.stringify(c,null,2)); } catch {}'
      fi
    `], { timeout: 15_000 }).catch(err => ({ exitCode: -1, stderr: String(err) }));
  if (mcpRes.exitCode !== 0) console.warn('[browser-install] MCP config write failed:', mcpRes.stderr);

  const binRes = await wslRun(['-d', DISTRO_NAME, '--', 'docker', 'exec', '-i', '--user', '0', ids[0],
    'sh', '-c', 'cat > /usr/local/bin/browser && sed -i "s/\\r$//" /usr/local/bin/browser && chmod 0755 /usr/local/bin/browser && for cmd in start navigate snapshot click fill close status tabs open type press screenshot; do ln -sf /usr/local/bin/browser "/usr/local/bin/browser_$cmd"; done'], {
    stdin: '#!/bin/sh\nbase="$(basename "$0")"\nexport OPENRIND_BROWSER_BIN="$base"\nexec /usr/bin/node /opt/openrind-browser/cli.cjs "$@"\n',
    timeout: 15_000,
  }).catch(err => ({ exitCode: -1, stderr: String(err) }));
  if (binRes.exitCode !== 0) console.warn('[browser-install] Browser binary installation failed:', binRes.stderr);

  // Run the MCP preflight / startup verification inside the sandbox container
  const verification = await wslRun(['-d', DISTRO_NAME, '--', 'docker', 'exec', '-i', '--user', 'sandbox', ids[0],
    'sh', '-c', `
      if [ -x /usr/local/bin/openrind-browser-client ] && [ -f /etc/openrind-browser/descriptor.json ]; then
        node /opt/openrind-browser/preflight.cjs
        echo "openrind-browser-mcp: verified"
      fi
    `], { timeout: 15_000 }).catch(err => ({ exitCode: -1, stdout: '', stderr: String(err) }));

  if (verification?.stdout?.includes('openrind-browser-mcp: verified')) {
    console.log(`[browser-install] Sandbox ${sandboxName}: Browser MCP and CLI successfully verified.`);
  } else {
    console.warn(`[browser-install] Sandbox ${sandboxName}: Browser MCP verification warning:`, verification?.stderr || verification?.stdout);
  }
}
