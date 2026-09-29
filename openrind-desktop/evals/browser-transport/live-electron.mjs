import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";

const requireDesktop = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const requireProbe = createRequire(import.meta.url);
const runtime = process.argv.includes("--candidate") ? requireProbe : requireDesktop;
const packaged = process.argv.includes("--packaged");
// Electron 44 downloads synchronously on require when dist is absent. Keep
// installation separate so a missing binary cannot bypass the probe timeout.
const runtimeRoot = dirname(runtime.resolve("electron/package.json"));
let executable;
try {
  if (packaged) {
    const dist = fileURLToPath(new URL("./dist/", import.meta.url));
    const { output } = JSON.parse(await readFile(join(dist, "packaged-target.json"), "utf8"));
    const childPath = relative(dist, resolve(output));
    if (isAbsolute(childPath) || childPath.startsWith("..") || !childPath.startsWith("packaged-probe-")) throw new Error("Invalid package path");
    executable = join(output, "OpenrindBrowserProbe.exe");
  } else {
    const relative = (await readFile(join(runtimeRoot, "path.txt"), "utf8")).trim();
    if (relative !== "electron.exe") throw new Error("Unexpected Windows executable");
    executable = join(runtimeRoot, "dist", relative);
  }
  await access(executable);
} catch {
  process.stderr.write("FAIL Electron binary unavailable; install the selected runtime before running probes\n");
  process.exit(1);
}
process.stdout.write(packaged ? "Probe runtime: packaged ASAR fixture\n" : `Probe runtime: Electron ${runtime("electron/package.json").version}\n`);
const env = { ...process.env };
const profile = await mkdtemp(join(tmpdir(), "openrind-browser-electron-probe-"));
env.OPENRIND_ELECTRON_PROBE_PROFILE = profile;
delete env.ELECTRON_RUN_AS_NODE;
const entry = process.argv.includes("--artifacts") ? "./artifact-probe.mjs"
  : process.argv.includes("--native") ? "./native-input-probe.mjs"
  : process.argv.includes("--input") ? "./input-probe.mjs"
  : process.argv.includes("--embedded") ? "./embedded-probe.mjs" : "./electron-probe.mjs";
const child = spawn(executable, [...(packaged ? [] : [fileURLToPath(new URL(entry, import.meta.url))]), ...process.argv.slice(2)], {
  env, stdio: "inherit", windowsHide: !process.argv.includes("--native") && !process.argv.includes("--artifacts"),
});
child.once("error", () => { process.stderr.write("FAIL Electron startup\n"); process.exitCode = 1; });
const timer = setTimeout(() => {
  process.stderr.write("FAIL Electron probe timeout\n");
  spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
}, process.argv.includes("--native") ? 600_000 : 240_000);
child.once("close", async (code) => {
  clearTimeout(timer);
  process.exitCode = code ?? 1;
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {
    process.stderr.write("FAIL disposable Electron profile cleanup\n"); process.exitCode = 1;
  });
});
