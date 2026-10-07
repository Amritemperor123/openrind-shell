import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { browserBinding } from './browser-binding.mjs';
import { DISTRO_NAME, wslRun, wslSpawn } from './wsl.mjs';
import { resolveBrowserResources } from './browser-resources.mjs';
import { createDesktopWebviewProvider } from '../browser/desktop-provider.mjs';

export async function startInstalledBrowserRuntime({ resourcesPath, databasePath, port, image, broker, onDisconnect }) {
  const resources = await resolveBrowserResources(resourcesPath);
  return startBrowserRuntime({ ...resources, databasePath, port, image, broker, onDisconnect });
}

// Main-process API. Paths and port come from installed resource provisioning,
// never a renderer message. Requires a Node runtime with built-in SQLite.
export async function startBrowserRuntime({ resourceRoot, nodeExecutable, databasePath, port, image, broker, onDisconnect = () => {} }) {
  if (![resourceRoot, nodeExecutable, databasePath].every(value => typeof value === 'string' && isAbsolute(value)) ||
      !Number.isInteger(port) || port < 1024 || port > 65535 ||
      typeof image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,255}$/.test(image)) throw new Error('Invalid browser runtime provisioning');
  const network = await wslRun(['-d', DISTRO_NAME, '--', 'docker', 'network', 'inspect', 'openshell-docker',
    '--format', '{{range .IPAM.Config}}{{.Gateway}}{{end}}'], { timeout: 15_000 });
  if (network.exitCode !== 0) throw new Error('Browser bridge network is unavailable');
  const bridgeAddress = network.stdout.trim();
  const bindingId = randomBytes(16).toString('hex');
  const endpoint = `http://host.openshell.internal:${port}/mcp`;
  browserBinding({ endpoint, bridgeAddress, bindingId });
  const mapped = await wslRun(['-d', DISTRO_NAME, '--', 'wslpath', '-a', join(resourceRoot, 'edge.cjs').replaceAll('\\', '/')], { timeout: 10_000 });
  const edgePath = mapped.stdout.trim();
  if (mapped.exitCode !== 0 || !edgePath.startsWith('/') || /[\r\n,]/.test(edgePath)) throw new Error('Browser edge resource is unavailable');
  const serviceToken = randomBytes(32).toString('base64url');
  const container = `openrind-browser-${bindingId}`;

  // Clean up any stale browser edge containers holding the port from a previous run
  await wslRun(['-d', DISTRO_NAME, '--', 'sh', '-c', 'docker ps -q --filter name=openrind-browser- | xargs -r docker rm -f'], { timeout: 15_000 }).catch(() => {});

  // Verify that the required image exists locally in Docker; if missing or untagged, resolve from existing container or dangling image
  const imgCheck = await wslRun(['-d', DISTRO_NAME, '--', 'docker', 'image', 'inspect', image, '--format', '{{.Id}}'], { timeout: 10_000 }).catch(() => ({ exitCode: 1 }));
  if (imgCheck.exitCode !== 0) {
    console.warn(`[browser-runtime] Image ${image} not found locally in Docker. Checking for fallback or untagged sandbox image...`);
    const containerImg = await wslRun(['-d', DISTRO_NAME, '--', 'sh', '-c',
      `docker ps -a --filter "label=openshell.ai/managed-by=openshell" --format "{{.Image}}" | head -n 1`], { timeout: 10_000 }).catch(() => null);
    const fallbackImage = containerImg?.stdout?.trim();
    if (fallbackImage && fallbackImage !== image) {
      console.log(`[browser-runtime] Tagging sandbox image ${fallbackImage} as ${image}...`);
      await wslRun(['-d', DISTRO_NAME, '--', 'docker', 'tag', fallbackImage, image], { timeout: 15_000 }).catch(() => {});
    } else {
      const untagged = await wslRun(['-d', DISTRO_NAME, '--', 'sh', '-c',
        `docker images --filter "dangling=true" -q | head -n 1`], { timeout: 10_000 }).catch(() => null);
      const untaggedId = untagged?.stdout?.trim();
      if (untaggedId) {
        console.log(`[browser-runtime] Tagging untagged image ${untaggedId} as ${image}...`);
        await wslRun(['-d', DISTRO_NAME, '--', 'docker', 'tag', untaggedId, image], { timeout: 15_000 }).catch(() => {});
      }
    }
  }
  // Do not inherit Node injection settings, model credentials or database URLs.
  const env = { OPENRIND_ENABLE_LOCAL_PROVIDER: '1' };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'OPENRIND_ENABLE_LOCAL_PROVIDER']) if (process.env[key]) env[key] = process.env[key];
  const worker = fork(join(resourceRoot, 'worker.cjs'), [], {
    execPath: nodeExecutable, execArgv: ['--experimental-sqlite'], env,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let edge;
  let ready = false;
  let closing;
  let startupReject;
  const pending = new Map();
  const desktopProvider = broker ? createDesktopWebviewProvider({ broker }) : null;
  const desktopSessions = new Map();
  async function handleDesktopProviderCall(message) {
    const { id, method, args = [] } = message;
    if (!desktopProvider) {
      worker.send({ type: 'desktop_provider_reply', id, ok: false, error: 'Desktop webview provider is not configured in main process', code: 'BACKEND_UNAVAILABLE' });
      return;
    }
    try {
      let result;
      if (method === 'create') {
        const spec = args[0] || {};
        const ctx = args[1];
        const session = await desktopProvider.create(spec, ctx);
        desktopSessions.set(session.handle, session);
        const pages = await session.pages();
        result = { handle: session.handle, pages };
      } else if (method === 'navigate') {
        const [handle, pageId, url] = args;
        const session = desktopSessions.get(handle);
        if (!session) throw new Error('SESSION_LOST');
        const page = session.page(pageId);
        result = await page.navigate(url);
      } else if (method === 'snapshot') {
        const [handle, pageId, options] = args;
        const session = desktopSessions.get(handle);
        if (!session) throw new Error('SESSION_LOST');
        const page = session.page(pageId);
        result = await page.snapshot(options);
      } else if (method === 'act') {
        const [handle, pageId, action] = args;
        const session = desktopSessions.get(handle);
        if (!session) throw new Error('SESSION_LOST');
        const page = session.page(pageId);
        result = await page.act(action);
      } else if (method === 'screenshot') {
        const [handle, pageId, options] = args;
        const session = desktopSessions.get(handle);
        if (!session) throw new Error('SESSION_LOST');
        const page = session.page(pageId);
        const buffer = await page.screenshot(options);
        result = buffer ? buffer.toString('base64') : null;
      } else if (method === 'close') {
        const [handle] = args;
        const session = desktopSessions.get(handle);
        if (session) {
          desktopSessions.delete(handle);
          await desktopProvider.close(session).catch(() => {});
        }
        result = { closed: true };
      } else if (method === 'closePage') {
        const [handle, pageId] = args;
        const session = desktopSessions.get(handle);
        if (session) {
          const page = session.page(pageId);
          await page?.close?.().catch(() => {});
        }
        result = { closed: true };
      } else if (method === 'setHumanControl') {
        const [handle, active] = args;
        const session = desktopSessions.get(handle);
        if (session) await session.setHumanControl(active);
        result = { ok: true };
      } else {
        throw new Error(`Unknown desktop provider method: ${method}`);
      }
      worker.send({ type: 'desktop_provider_reply', id, ok: true, result });
    } catch (err) {
      console.error('[browser-runtime] handleDesktopProviderCall error:', method, err);
      worker.send({
        type: 'desktop_provider_reply',
        id,
        ok: false,
        error: err?.message || String(err),
        code: err?.code || 'BACKEND_UNAVAILABLE',
      });
    }
  }

  const close = () => {
    if (closing) return closing;
    ready = false;
    for (const session of desktopSessions.values()) {
      desktopProvider?.close(session).catch(() => {});
    }
    desktopSessions.clear();
    startupReject?.(new Error('Browser runtime stopped during startup'));
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Browser runtime disconnected')); }
    pending.clear();
    // IPC loss revokes worker grants; EOF closes the owned bridge, with no restart.
    if (worker.connected) worker.disconnect();
    closing = Promise.resolve().then(async () => {
      try {
        let absent = false;
        for (let attempt = 0; attempt < 3 && !absent; attempt++) {
          await wslRun(['-d', DISTRO_NAME, '--', 'docker', 'rm', '-f', container], { timeout: 15_000 });
          // --rm can race explicit removal. Verify absence instead of treating
          // an already-in-progress Docker removal as a leaked container.
          const remaining = await wslRun(['-d', DISTRO_NAME, '--', 'docker', 'ps', '-a',
            '--filter', `name=^/${container}$`, '--format', '{{.ID}}'], { timeout: 10_000 });
          absent = remaining.exitCode === 0 && remaining.stdout.trim() === '';
        }
        if (!absent) throw new Error('Browser edge cleanup is incomplete');
      } finally {
        if (worker.exitCode === null && worker.signalCode === null) worker.kill();
        if (edge && edge.exitCode === null && edge.signalCode === null) edge.kill();
      }
    });
    return closing;
  };
  let diagnostics = '';
  let workerDiagnostics = '';
  worker.stderr.on('data', chunk => { workerDiagnostics += chunk.toString(); });
  const failed = (reason) => {
    const wasReady = ready;
    const errDetail = [
      diagnostics.trim() ? `edge: ${diagnostics.trim()}` : null,
      workerDiagnostics.trim() ? `worker: ${workerDiagnostics.trim()}` : null,
      reason ? `reason: ${reason}` : null,
    ].filter(Boolean).join('; ');
    if (errDetail) console.error('[browser-runtime] Startup failure:', errDetail);
    startupReject?.(new Error(`Browser runtime startup failed: ${errDetail || 'process exited'}`));
    void close().catch(() => {});
    if (wasReady) { try { onDisconnect(); } catch { /* Cleanup must continue. */ } }
  };
  worker.once('error', (err) => failed(err));
  worker.once('exit', (code, signal) => failed(`worker exited with code ${code}, signal ${signal}`));
  worker.stdin.on('error', failed);
  let startupTimer;
  try {
    const started = new Promise((resolve, reject) => {
      startupReject = reject;
      let workerReady = false, edgeReady = false;
      const finish = () => { if (workerReady && edgeReady) resolve(); };
      startupTimer = setTimeout(() => {
        const errDetail = [
          diagnostics.trim() ? `edge: ${diagnostics.trim()}` : null,
          workerDiagnostics.trim() ? `worker: ${workerDiagnostics.trim()}` : null,
        ].filter(Boolean).join('; ');
        reject(new Error(`Browser runtime startup timed out after 60s (${errDetail || 'no output from edge container'})`));
      }, 60_000);
      worker.on('message', message => {
        if (message?.type === 'ready' && message.protocol === 1) { workerReady = true; finish(); return; }
        if (message?.type === 'desktop_provider_call') {
          handleDesktopProviderCall(message);
          return;
        }
        if (message?.type !== 'result' || typeof message.id !== 'string') return failed();
        const request = pending.get(message.id);
        if (!request) return failed();
        pending.delete(message.id); clearTimeout(request.timer);
        if (message.ok === true) request.resolve(message.value);
        else request.reject(new Error('Browser control request failed'));
      });
      edge = wslSpawn(['-d', DISTRO_NAME, '--', 'docker', 'run', '--rm', '-i', '--name', container,
        '-p', `${port}:${port}`, '--entrypoint', '/usr/bin/node',
        '-e', 'OPENRIND_BROWSER_BRIDGE_ADDRESS=0.0.0.0', '-e', `OPENRIND_BROWSER_BRIDGE_PORT=${port}`,
        '--mount', `type=bind,src=${edgePath},dst=/opt/openrind-browser-edge.cjs,readonly`, image, '/opt/openrind-browser-edge.cjs']);
      edge.once('error', failed); edge.once('exit', failed); edge.stdin.on('error', failed);
      edge.stdout.pipe(worker.stdin); worker.stdout.pipe(edge.stdin);
      let diagnostics = '';
      edge.stderr.on('data', bytes => {
        diagnostics = (diagnostics + bytes.toString()).slice(-1024);
        if (diagnostics.split(/\r?\n/).includes('openrind-browser: edge ready')) { edgeReady = true; finish(); }
      });
      worker.send({ type: 'initialize', databasePath, serviceToken }, error => { if (error) failed(); });
    });
    await started;
    if (closing) throw new Error('Browser runtime disconnected');
    ready = true;
  } catch (err) {
    console.error('startBrowserRuntime inner error:', err);
    await close().catch(() => {});
    throw new Error('Browser runtime startup failed');
  } finally { clearTimeout(startupTimer); startupReject = undefined; }
  const request = (type, fields) => new Promise((resolve, reject) => {
    if (!ready || pending.size >= 32) { reject(new Error('Browser runtime is unavailable')); return; }
    const id = randomBytes(16).toString('hex');
    const timer = setTimeout(() => { failed(); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    worker.send({ id, type, ...fields }, error => { if (error) failed(); });
  });
  return Object.freeze({ endpoint, bridgeAddress, bindingId, serviceToken,
    get ready() { return ready; },
    beginLaunch: (scope, policy) => request('begin', { scope, policy }),
    heartbeat: launchId => request('heartbeat', { launchId }),
    stopLaunch: launchId => request('stop', { launchId }), close,
  });
}
