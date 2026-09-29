import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BridgePeer } from "./bridge-peer.mjs";
import { CHUNK_LIMIT } from "./bridge-wire.mjs";
import { wslRun, wslSpawn, DISTRO_NAME } from "../../apps/desktop/electron/openshell/wsl.mjs";

let stage = "path";
async function main() {
  const name = `brp-wire-${randomBytes(6).toString("hex")}`;
  const file = fileURLToPath(new URL("./dist/bridge-echo.cjs", import.meta.url));
  const converted = await wslRun(["-d", DISTRO_NAME, "--", "wslpath", "-a", file.replaceAll("\\", "/")]);
  assert.equal(converted.exitCode, 0, "WSL path conversion failed");
  stage = "spawn";
  const child = wslSpawn(["-d", DISTRO_NAME, "--", "docker", "run", "--rm", "-i", "--name", name,
    "--network", "none", "--entrypoint", "/usr/bin/node",
    "--mount", `type=bind,src=${converted.stdout.trim()},dst=/opt/probe.cjs,readonly`,
    "openrind-shell-fuse:local", "/opt/probe.cjs"]);
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  exited.catch(() => {});
  // Drain diagnostics but keep raw process output (possibly host paths) out of results.
  child.stderr.resume();
  const peer = new BridgePeer(child.stdout, child.stdin, { initiator: true });
  try {
    stage = "handshake";
    const stream = await peer.open("POST", "/mcp", {});
    stage = "stream";
    const hash = createHash("sha256");
    for (let i = 0; i < 80; i++) {
      const bytes = randomBytes(CHUNK_LIMIT); hash.update(bytes); await stream.send(bytes);
    }
    await stream.end();
    assert.equal((await stream.response).status, 200);
    const chunks = [];
    for await (const bytes of stream.body()) chunks.push(bytes);
    assert.equal(Buffer.concat(chunks).toString(), hash.digest("hex"));
    process.stdout.write("PASS 5 MiB binary payload through actual wslSpawn pipes with matching SHA-256\n");
    const pending = await peer.open("GET", "/mcp", {});
    peer.close();
    stage = "EOF";
    assert.equal(pending.signal.aborted, true);
    let timer;
    try {
      const code = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("EOF cleanup timeout")), 5000); })]);
      assert.equal(code, 0);
    } finally { clearTimeout(timer); }
    process.stdout.write("PASS EOF aborts pending stream and exits the owned Linux process\n");
  } finally {
    peer.close();
    // Generated unique name only; never terminate the WSL distro or other browsers.
    const removed = await wslRun(["-d", DISTRO_NAME, "--", "docker", "rm", "-f", name], { timeout: 10_000 });
    if (removed.exitCode !== 0 && !removed.stderr.includes("No such container")) throw new Error("Probe cleanup pending");
  }
}
main().catch(() => { process.stderr.write(`FAIL WSL binary bridge probe at ${stage}\n`); process.exitCode = 1; });
