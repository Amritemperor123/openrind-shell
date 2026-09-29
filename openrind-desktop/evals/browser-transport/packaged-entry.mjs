import { app } from "electron";

if (!app.isPackaged) throw new Error("Packaged probe requires packaged mode");
if (!process.env.OPENRIND_ELECTRON_PROBE_PROFILE) throw new Error("Disposable profile required");
app.setPath("userData", process.env.OPENRIND_ELECTRON_PROBE_PROFILE);
process.stdout.write(`Packaged probe: Electron ${process.versions.electron}; Node ${process.versions.node}; packaged=${app.isPackaged}\n`);
// Fixed entrypoints only. None of these test selectors ship in Desktop.
const entry = process.argv.includes("--artifacts") ? "./artifact-probe.mjs"
  : process.argv.includes("--native") ? "./native-input-probe.mjs"
  : process.argv.includes("--input") ? "./input-probe.mjs"
  : process.argv.includes("--embedded") ? "./embedded-probe.mjs" : "./electron-probe.mjs";
void import(entry).catch(() => {
  process.stderr.write("FAIL packaged probe initialization\n");
  app.exit(1);
});
