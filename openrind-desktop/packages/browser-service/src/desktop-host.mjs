import { createServer } from 'node:http';
import { createWorkerService } from './worker.mjs';
import { createMcpHttpHandler } from './http.mjs';

// Runs in the dedicated worker. The Desktop supervisor supplies its fixed
// bridge factory over private control IPC; this is not a renderer-facing API.
export async function startDesktopBrowserHost({ sdk, serviceToken, startBridge, onDisconnect = () => {}, ...config }) {
  if (typeof startBridge !== 'function') throw new Error('A private browser bridge is required');
  const service = createWorkerService(config);
  let http;
  let bridge;
  let ready = false;
  let closing;
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    if (!http || !ready) { res.writeHead(503); res.end(); return; }
    http.handler(req, res);
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  server.maxConnections = 128;
  const close = () => {
    if (closing) return closing;
    ready = false;
    // Revoke synchronously, before waiting for sockets/processes to terminate.
    service.launches.close();
    closing = Promise.resolve().then(async () => {
      const failures = [];
      const attempt = async work => { try { await work(); } catch { failures.push(true); } };
      await attempt(() => bridge?.close());
      await attempt(() => http?.close());
      server.closeAllConnections();
      if (server.listening) await attempt(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
      await attempt(() => service.shutdown());
      if (failures.length) throw new Error('Browser host cleanup is incomplete');
    });
    return closing;
  };
  // EOF/process loss must fence grants even if no HTTP request is in progress.
  const disconnected = () => {
    void close().catch(() => {});
    onDisconnect();
  };
  server.on('error', disconnected);
  try {
    await new Promise((resolve, reject) => {
      const failed = error => { server.removeListener('listening', listening); reject(error); };
      const listening = () => { server.removeListener('error', failed); resolve(); };
      server.once('error', failed); server.once('listening', listening);
      // The service never binds a LAN or wildcard address.
      server.listen(0, '127.0.0.1');
    });
    const authority = `127.0.0.1:${server.address().port}`;
    http = createMcpHttpHandler({ service, sdk, serviceToken, authority });
    bridge = await startBridge({ endpoint: `http://${authority}/mcp`, onDisconnect: disconnected });
    // EOF can arrive before the asynchronous factory returns its handle.
    if (closing) {
      await bridge?.close();
      throw new Error('Browser bridge disconnected during startup');
    }
    if (!bridge || typeof bridge.close !== 'function' || !bridge.ready) throw new Error('Browser bridge failed to initialize');
    await bridge.ready;
    if (closing) throw new Error('Browser bridge disconnected during startup');
    ready = true;
    return Object.freeze({
      get ready() { return ready; },
      beginLaunch(scope, policy) {
        if (!ready) throw new Error('Browser service is not ready');
        return service.launches.begin(scope, policy);
      },
      heartbeat: id => {
        if (!ready) throw new Error('Browser service is not ready');
        return service.launches.heartbeat(id);
      },
      stopLaunch: id => service.launches.stop(id),
      close,
    });
  } catch {
    await close().catch(() => {});
    throw new Error('Browser host startup failed');
  }
}
