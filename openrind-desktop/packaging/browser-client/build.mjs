import { build } from 'esbuild';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const output = new URL('./dist/', import.meta.url);
const hashes = {};
await mkdir(output, { recursive: true });
const entries = [['entry.mjs', 'client'], ['preflight-entry.mjs', 'preflight'], ['provision-entry.mjs', 'provision'], ['edge-entry.mjs', 'edge'], ['worker-entry.mjs', 'worker'], ['cli-entry.mjs', 'cli']];
if (process.argv.includes('--checks')) entries.push(['native-check.mjs', 'native-check']);
for (const [entry, name] of entries) {
const built = await build({
  absWorkingDir: here, entryPoints: [entry], outfile: `dist/${name}.cjs`,
  bundle: true, platform: 'node', target: 'node22.19', format: 'cjs', write: false,
  external: ['playwright', 'playwright-core'],
  // Resolve the shared source against this isolated, locked build dependency set.
  alias: {
    '@openrind/browser-contract': fileURLToPath(new URL('../../packages/browser-contract/src/index.mjs', import.meta.url)),
    '@openrind/browser-core': fileURLToPath(new URL('../../packages/browser-core/src/index.mjs', import.meta.url)),
    '@openrind/browser-drivers': fileURLToPath(new URL('../../packages/browser-drivers/src/index.mjs', import.meta.url)),
    '@openrind/browser-providers': fileURLToPath(new URL('../../packages/browser-providers/src/index.mjs', import.meta.url)),
    zod: fileURLToPath(new URL('./node_modules/zod', import.meta.url)),
  },
});
const bytes = built.outputFiles[0].contents;
await writeFile(new URL(`${name}.cjs`, output), bytes);
hashes[name] = createHash('sha256').update(bytes).digest('hex');
}
await copyFile(new URL('./mcp.json', import.meta.url), new URL('mcp.json', output));
await writeFile(new URL('manifest.json', output), JSON.stringify({ protocol: 1,
  sdk: '1.30.0', undici: '7.29.1', zod: '4.3.6', cborg: '6.1.2',
  sha256: hashes,
}, null, 2) + '\n');

// On Windows, stage browser-runtime for Desktop automatically
if (process.platform === 'win32') {
  const runtimeDir = new URL('./browser-runtime/', import.meta.url);
  await mkdir(runtimeDir, { recursive: true });
  await copyFile(process.execPath, new URL('node.exe', runtimeDir)).catch(() => {});
  await copyFile(new URL('./dist/worker.cjs', import.meta.url), new URL('worker.cjs', runtimeDir));
  await copyFile(new URL('./dist/edge.cjs', import.meta.url), new URL('edge.cjs', runtimeDir));
  const runtimeHashes = {};
  for (const file of ['node.exe', 'worker.cjs', 'edge.cjs']) {
    try {
      const data = await readFile(new URL(file, runtimeDir));
      runtimeHashes[file] = createHash('sha256').update(data).digest('hex');
    } catch {}
  }
  const manifest = {
    protocol: 1,
    platform: 'win32',
    arch: process.arch,
    nodeVersion: process.versions.node,
    sha256: runtimeHashes,
  };
  await writeFile(new URL('runtime-manifest.json', runtimeDir), JSON.stringify(manifest, null, 2) + '\n');
  console.log('[build] Staged browser-runtime for Desktop with node ' + process.versions.node);
}
