import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
await mkdir("dist", { recursive: true });
let result;
for (const [entry, output] of [["fixed-entry", "client"], ["fixture-entry", "fixture"], ["probe-entry", "probe"],
  ["bridge-echo-entry", "bridge-echo"], ["bridge-edge-entry", "bridge-edge"],
  ["windows-worker-entry", "windows-worker"], ["remote-check-entry", "remote-check"]]) {
  const built = await build({ entryPoints: [fileURLToPath(new URL(`./${entry}.mjs`, import.meta.url))], bundle: true,
    platform: "node", target: "node22", format: "cjs", outfile: `dist/${output}.cjs`, write: false });
  await writeFile(`dist/${output}.cjs`, built.outputFiles[0].contents);
  if (output === "client") result = built;
}
await writeFile("dist/manifest.json", JSON.stringify({ experiment: true, protocol: 1,
  sdk: "1.30.0", undici: "7.29.1", sha256: createHash("sha256").update(result.outputFiles[0].contents).digest("hex") }, null, 2) + "\n");
