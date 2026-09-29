import { isIP } from 'node:net';
import { BridgePeer } from './bridge/bridge-peer.mjs';
import { startHttpEdge } from './bridge/bridge-http.mjs';

async function main() {
  const host = process.env.OPENRIND_BROWSER_BRIDGE_ADDRESS;
  const port = Number(process.env.OPENRIND_BROWSER_BRIDGE_PORT);
  if (process.argv.length !== 2 || isIP(host ?? '') !== 4 ||
      !/^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host) ||
      !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid private bridge configuration');
  let edge;
  let disconnected = false;
  const peer = new BridgePeer(process.stdin, process.stdout, { initiator: true,
    onDisconnect: () => { disconnected = true; void edge?.close().catch(() => {}); } });
  try {
    edge = await startHttpEdge(peer, { host, port, publicHost: 'host.openshell.internal' });
    if (disconnected) { await edge.close(); throw new Error('Bridge disconnected'); }
    // stdout is exclusively the framed binary channel.
    process.stderr.write('openrind-browser: edge ready\n');
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => peer.close());
  } catch (error) { peer.close(); throw error; }
}
main().catch(() => {
  process.stderr.write('openrind-browser: edge startup failed\n');
  process.exitCode = 1;
});
