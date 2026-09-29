import { startFixture } from "./fixture.mjs";
import { forwardToService } from "./bridge-http.mjs";
import { BridgePeer } from "./bridge-peer.mjs";

async function main() {
  // Dedicated child-process IPC only. Never a renderer message or CLI secret.
  const settings = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Worker bootstrap timeout")), 5000);
    process.once("message", (message) => { clearTimeout(timer); resolve(message); });
  });
  if (Object.keys(settings).join(",") !== "token" || !/^[a-f0-9]{64}$/.test(settings.token)) throw new Error("Invalid bootstrap");
  process.disconnect();
  const fixture = await startFixture({ tokens: [settings.token] });
  const peer = new BridgePeer(process.stdin, process.stdout, {
    onRequest: forwardToService(fixture.endpoint),
    onDisconnect: async () => {
      await fixture.close();
      process.stderr.write(JSON.stringify({ fixtureAudit: fixture.audit }) + "\n");
    },
  });
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => peer.close());
}
main().catch(() => { process.stderr.write("Windows worker failed\n"); process.exitCode = 1; });
