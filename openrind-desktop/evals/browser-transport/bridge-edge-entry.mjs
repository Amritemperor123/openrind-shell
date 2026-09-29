import { BridgePeer } from "./bridge-peer.mjs";
import { startHttpEdge } from "./bridge-http.mjs";
async function main() {
  let edge;
  const peer = new BridgePeer(process.stdin, process.stdout, { initiator: true,
    onDisconnect: () => { void edge?.close(); } });
  edge = await startHttpEdge(peer, { host: process.env.PROBE_BIND_ADDRESS, port: 18789,
    publicHost: "host.openshell.internal" });
  process.stderr.write("bridge edge ready\n");
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => peer.close());
}
main().catch(() => { process.stderr.write("bridge edge failed\n"); process.exitCode = 1; });
