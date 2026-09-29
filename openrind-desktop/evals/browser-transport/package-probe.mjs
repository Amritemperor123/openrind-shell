import { cp, mkdir, mkdtemp, readdir, writeFile, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { createPackage } from "@electron/asar";

const root = fileURLToPath(new URL(".", import.meta.url));
const dist = join(root, "dist");
await mkdir(dist, { recursive: true });
// Fresh output only: never replace or recursively delete an existing package.
const output = await mkdtemp(join(dist, "packaged-probe-"));
await cp(join(root, "node_modules/electron/dist"), output, { recursive: true });
await rename(join(output, "electron.exe"), join(output, "OpenrindBrowserProbe.exe"));
const staging = await mkdtemp(join(dist, "archive-source-"));
for (const entry of ["packaged-entry", "electron-probe", "embedded-probe", "input-probe", "native-input-probe", "artifact-probe"]) {
  await build({ entryPoints: [join(root, `${entry}.mjs`)], bundle: true,
    platform: "node", target: "node24", format: "esm", external: ["electron"],
    outfile: join(staging, `${entry}.mjs`) });
}
await writeFile(join(staging, "package.json"), JSON.stringify({ name: "openrind-browser-packaging-probe",
  version: "0.0.0", private: true, type: "module", main: "packaged-entry.mjs" }));
const resources = join(output, "resources");
await createPackage(staging, join(resources, "app.asar"));
const payload = join(resources, "browser-probe");
await mkdir(join(payload, "dist"), { recursive: true });
for (const name of ["run-live.sh", "Dockerfile", "launcher.c", "descriptor.json", "policy.yaml", "generate-test-ca.sh"]) {
  await cp(join(root, name), join(payload, name));
}
const hashes = {};
for (const name of (await readdir(dist)).filter(name => name.endsWith(".cjs"))) {
  await cp(join(dist, name), join(payload, "dist", name));
  hashes[name] = createHash("sha256").update(await readFile(join(payload, "dist", name))).digest("hex");
}
await writeFile(join(output, "probe-manifest.json"), JSON.stringify({ experiment: true,
  electron: JSON.parse(await readFile(join(root, "node_modules/electron/package.json"), "utf8")).version,
  archive: createHash("sha256").update(await readFile(join(resources, "app.asar"))).digest("hex"), hashes }, null, 2));
await writeFile(join(dist, "packaged-target.json"), JSON.stringify({ output }));
process.stdout.write("PASS built isolated ASAR probe with external worker resources\n");
