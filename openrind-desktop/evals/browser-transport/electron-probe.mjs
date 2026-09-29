import { app } from "electron";
import { runWindowsBridge } from "./live-wsl-http.mjs";
import { join } from "node:path";

// No windows, personal profile, production IPC or application startup hooks.
const profile = process.env.OPENRIND_ELECTRON_PROBE_PROFILE;
if (!profile) throw new Error("Probe profile required");
app.setPath("userData", profile);
async function main() {
let result = 1;
try {
  await app.whenReady();
  process.stdout.write(`Electron ${process.versions.electron}; Node ${process.versions.node}; packaged=${app.isPackaged}\n`);
  if (process.argv.includes("--packaged") && !app.isPackaged) throw new Error("Packaged runtime required");
  await runWindowsBridge(app.isPackaged ? join(process.resourcesPath, "browser-probe") : undefined);
  result = 0;
} catch {
  process.stderr.write("FAIL Electron worker lifecycle probe\n");
} finally {
  app.exit(result);
}
}
void main();
