import { readFile } from "node:fs/promises";
import { startFixture } from "./fixture.mjs";
async function main() {
const fixture = await startFixture({
  tokens: [(await readFile("/run/browser-probe/token", "utf8")).trim()],
  host: process.env.PROBE_BIND_ADDRESS,
  port: 18789, publicHost: "host.openshell.internal",
  json: process.env.PROBE_JSON === "1",
  tls: process.env.PROBE_TLS === "1" ? {
    key: await readFile("/run/browser-probe/server.key"),
    cert: await readFile("/run/browser-probe/server.crt"),
  } : undefined,
});
// A reachable second listener distinguishes denied port from a missing service.
const other = process.env.PROBE_NEGATIVE === 'wrong-port' ? await startFixture({
  tokens: [(await readFile('/run/browser-probe/token', 'utf8')).trim()],
  host: process.env.PROBE_BIND_ADDRESS, port: 18790, publicHost: 'host.openshell.internal',
}) : undefined;
process.stdout.write("fixture ready\n");
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => {
  if (closing) return;
  closing = true;
  await fixture.close();
  if (other) {
    await other.close();
    if (other.audit.calls || other.audit.denied) process.exitCode = 1;
    process.stdout.write(JSON.stringify({ otherFixtureAudit: other.audit }) + '\n');
  }
  process.stdout.write(JSON.stringify({ fixtureAudit: fixture.audit }) + "\n");
});
}
main().catch(() => { process.stderr.write("fixture startup failed\n"); process.exitCode = 1; });
