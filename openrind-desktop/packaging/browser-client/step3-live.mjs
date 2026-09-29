import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startInstalledBrowserRuntime } from '../../apps/desktop/electron/openshell/browser-runtime.mjs';
import { DISTRO_NAME, wslRun } from '../../apps/desktop/electron/openshell/wsl.mjs';

const directory = await mkdtemp(join(tmpdir(), 'openrind-browser-live-'));
let runtime;
try {
  runtime = await startInstalledBrowserRuntime({ resourcesPath: fileURLToPath(new URL('.', import.meta.url)),
    databasePath: join(directory, 'registry.sqlite'), port: 18789, image: 'openrind-shell-fuse:local' });
  const launch = await runtime.beginLaunch({ tenantId: 'tenant_live', workspaceId: 'workspace_live', sandboxId: 'sandbox_live',
    conversationId: 'conversation_live' }, { providers: ['local-chromium'], origins: [], revision: 1 });
  const script = `let text='';for await(const chunk of process.stdin)text+=chunk;
const config=JSON.parse(text);const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+config.token,'x-openrind-browser-grant':config.grant};
const r=await fetch(config.endpoint,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'live-check',version:'1'}}})});
if(r.status!==200||!r.headers.get('mcp-session-id'))throw Error('initialize failed');await r.text();
const id=r.headers.get('mcp-session-id');const closed=await fetch(config.endpoint,{method:'DELETE',headers:{...headers,'mcp-session-id':id}});if(closed.status!==200)throw Error('delete failed');process.stdout.write('PASS real WSL edge to Windows worker initialize/delete');`;
  const checked = await wslRun(['-d', DISTRO_NAME, '--', 'docker', 'run', '--rm', '-i', '--network', 'openshell-docker',
    '--add-host', `host.openshell.internal:${runtime.bridgeAddress}`, '--entrypoint', '/usr/bin/node',
    'openrind-shell-fuse:local', '--input-type=module', '-e', script], { timeout: 20_000,
    stdin: JSON.stringify({ endpoint: runtime.endpoint, token: runtime.serviceToken, grant: launch.token }) });
  assert.equal(checked.exitCode, 0, 'Private Linux-to-Windows request failed');
  process.stdout.write(checked.stdout + '\n');
  if (process.argv.includes('--native')) {
    const root = fileURLToPath(new URL('.', import.meta.url)).replaceAll('\\', '/');
    const mapped = await wslRun(['-d', DISTRO_NAME, '--', 'wslpath', '-a', root], { timeout: 10_000 });
    assert.equal(mapped.exitCode, 0);
    const native = await wslRun(['-d', DISTRO_NAME, '--', 'bash', `${mapped.stdout.trim().replace(/\/$/, '')}/step3-native.sh`],
      { timeout: 180_000, stdin: `${runtime.serviceToken}\n${launch.token}\n` });
    process.stdout.write(native.stdout);
    if (native.exitCode !== 0) process.stderr.write(native.stderr.replaceAll(runtime.serviceToken, '[redacted-service]')
      .replaceAll(launch.token, '[redacted-grant]').slice(-3000));
    assert.equal(native.exitCode, 0, 'Native OpenShell/Claude browser validation failed');
  }
  await runtime.stopLaunch(launch.launchId);
} finally {
  await runtime?.close();
  await rm(directory, { recursive: true, force: true });
}
