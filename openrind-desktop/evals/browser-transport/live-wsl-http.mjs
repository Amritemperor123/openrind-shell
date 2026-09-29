import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { wslRun, wslSpawn, DISTRO_NAME } from "../../apps/desktop/electron/openshell/wsl.mjs";

export async function runWindowsBridge(resourceRoot) {
  const token = randomBytes(32).toString("hex");
  const name = `brp-edge-${randomBytes(6).toString("hex")}`;
  const root = resourceRoot ?? fileURLToPath(new URL(".", import.meta.url));
  const pathResult = await wslRun(["-d", DISTRO_NAME, "--", "wslpath", "-a", root.replaceAll("\\", "/")]);
  assert.equal(pathResult.exitCode, 0);
  const linuxRoot = pathResult.stdout.trim().replace(/\/$/, "");
  const network = await wslRun(["-d", DISTRO_NAME, "--", "docker", "network", "inspect", "openshell-docker",
    "--format", "{{range .IPAM.Config}}{{.Gateway}}{{end}}"]);
  assert.equal(network.exitCode, 0);
  const address = network.stdout.trim();
  assert.match(address, /^\d+\.\d+\.\d+\.\d+$/);
  const worker = fork(join(root, "dist/windows-worker.cjs"), [], {
    execArgv: [], stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true,
    // Electron's executable must explicitly enter Node mode for this fixed worker.
    env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
  });
  worker.send({ token });
  const edge = wslSpawn(["-d", DISTRO_NAME, "--", "docker", "run", "--rm", "-i", "--name", name,
    "--network", "host", "--entrypoint", "/usr/bin/node", "-e", `PROBE_BIND_ADDRESS=${address}`,
    "--mount", `type=bind,src=${linuxRoot}/dist/bridge-edge.cjs,dst=/opt/bridge-edge.cjs,readonly`,
    "openrind-shell-fuse:local", "/opt/bridge-edge.cjs"]);
  const waitExit = (child) => new Promise((resolve) => { child.once("close", resolve); child.once("error", () => resolve(-1)); });
  const workerExit = waitExit(worker), edgeExit = waitExit(edge);
  // Model of Electron-main forwarding: opaque binary pipes, no page/body parsing.
  edge.stdout.pipe(worker.stdin); worker.stdout.pipe(edge.stdin);
  worker.stdin.on("error", () => {}); edge.stdin.on("error", () => {});
  let audit;
  let diagnostics = "";
  worker.stderr.on("data", (bytes) => {
    diagnostics += bytes.toString();
    if (diagnostics.length > 4096) diagnostics = diagnostics.slice(-4096);
    for (const line of diagnostics.split("\n")) {
      try { const value = JSON.parse(line); if (value.fixtureAudit) audit = value.fixtureAudit; } catch { /* Only structured fixture audit is retained. */ }
    }
  });
  let timer;
  const ready = new Promise((resolve, reject) => {
    let text = "";
    timer = setTimeout(() => reject(new Error("Edge startup timeout")), 15_000);
    edge.stderr.on("data", (bytes) => { text = (text + bytes.toString()).slice(-1024); if (text.includes("bridge edge ready")) resolve(); });
    edge.once("error", () => reject(new Error("Edge failed")));
  });
  try {
    await ready; clearTimeout(timer);
    const run = await wslRun(["-d", DISTRO_NAME, "--", "docker", "run", "--rm", "-i", "--network", "openshell-docker",
      "--add-host", `host.openshell.internal:${address}`, "--entrypoint", "/usr/bin/node",
      "--mount", `type=bind,src=${linuxRoot}/dist/remote-check.cjs,dst=/opt/remote-check.cjs,readonly`,
      "openrind-shell-fuse:local", "/opt/remote-check.cjs"], { stdin: token + "\n", timeout: 20_000 });
    assert.equal(run.exitCode, 0, "Linux-to-Windows MCP check failed");
    process.stdout.write(run.stdout);
    if (process.argv.includes("--crash-worker")) {
      worker.kill();
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Worker cleanup timeout")), 5000);
      });
      const [, edgeCode] = await Promise.race([Promise.all([workerExit, edgeExit]), deadline]);
      clearTimeout(timer);
      assert.equal(edgeCode, 0, "Edge did not stop on worker EOF");
      process.stdout.write("PASS forced worker exit closes the owned WSL edge without restart\n");
      return;
    }
    if (process.argv.includes("--openshell")) {
      const native = await wslRun(["-d", DISTRO_NAME, "--", "env", "PROBE_EXTERNAL_FIXTURE=1", "bash", `${linuxRoot}/run-live.sh`],
        { stdin: token + "\n", timeout: 180_000 });
      if (native.exitCode !== 0) throw new Error("OpenShell combined bridge check failed");
      process.stdout.write("PASS native OpenShell client and actual Claude discovery through Windows worker\n");
    }
    worker.stdin.end(); edge.stdin.end();
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Worker cleanup timeout")), 5000); });
    const codes = await Promise.race([Promise.all([workerExit, edgeExit]), deadline]);
    clearTimeout(timer);
    assert.deepEqual(codes, [0, 0]);
    assert.equal(audit?.calls, process.argv.includes("--openshell") ? 4 : 1);
    assert.equal(audit?.deleted, process.argv.includes("--openshell") ? 3 : 1);
    if (process.argv.includes("--openshell")) assert.equal(audit.cancelled, 1);
    process.stdout.write("PASS worker/edge EOF cleanup and authenticated fixture audit\n");
  } finally {
    clearTimeout(timer); worker.stdin.destroy(); edge.stdin.destroy();
    if (worker.exitCode === null) worker.kill();
    const removed = await wslRun(["-d", DISTRO_NAME, "--", "docker", "rm", "-f", name], { timeout: 10_000 });
    if (removed.exitCode !== 0 && !removed.stderr.includes("No such container")) throw new Error("Edge cleanup pending");
  }
}
if (!process.versions.electron) runWindowsBridge().catch((error) => {
  const safe = new Set(["Linux-to-Windows MCP check failed", "OpenShell combined bridge check failed", "Edge startup timeout", "Worker cleanup timeout", "Edge cleanup pending"]);
  process.stderr.write(`FAIL Windows worker bridge${safe.has(error.message) ? ": " + error.message : ""}\n`);
  process.exitCode = 1;
});
