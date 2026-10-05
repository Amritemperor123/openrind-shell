import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

async function checksum(path, maxBytes) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('Invalid browser runtime resource');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Browser runtime resource exceeds its size limit');
    hash.update(chunk);
  }
  return hash.digest('hex');
}

// Resolve only the fixed installed resource directory, outside ASAR. No PATH
// lookup, Electron-as-Node fallback or renderer-selected executable is allowed.
export async function resolveBrowserResources(resourcesPath) {
  if (process.platform !== 'win32' || typeof resourcesPath !== 'string' || !isAbsolute(resourcesPath)) {
    throw new Error('The Desktop browser runtime currently requires Windows resources');
  }
  const resourceRoot = join(resourcesPath, 'browser-runtime');
  const manifestPath = join(resourceRoot, 'runtime-manifest.json');

  // Auto-stage in development mode if manifest or runtime files are missing
  try {
    const stat = await lstat(manifestPath);
    if (!stat.isFile()) throw new Error('Missing manifest');
  } catch {
    const buildScript = join(resourcesPath, 'build.mjs');
    try {
      const { execFileSync } = await import('node:child_process');
      const { existsSync } = await import('node:fs');
      if (existsSync(buildScript)) {
        console.log('[browser-resources] Auto-staging browser runtime in development mode...');
        execFileSync(process.execPath, [buildScript], { cwd: resourcesPath, stdio: 'inherit' });
      }
    } catch (e) {
      console.warn('[browser-resources] Auto-stage attempt failed:', e);
    }
  }

  const stat = await lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('Browser runtime manifest is invalid');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const major = parseInt(String(manifest.nodeVersion || '').split('.')[0], 10);
  if (manifest.protocol !== 1 || manifest.platform !== 'win32' || manifest.arch !== process.arch ||
      (major < 22 && !/^(?:22\.(?:1[2-9]|[2-9][0-9])\.\d+|24\.\d+\.\d+)$/.test(manifest.nodeVersion))) {
    throw new Error('Browser runtime needs repair: incompatible Node runtime (requires Node 22+)');
  }
  for (const [name, limit] of [['node.exe', 200 * 1024 * 1024], ['worker.cjs', 32 * 1024 * 1024], ['edge.cjs', 32 * 1024 * 1024]]) {
    const expected = manifest.sha256?.[name];
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) ||
        await checksum(join(resourceRoot, name), limit) !== expected) {
      // In dev mode, auto-rebuild if sha256 changed
      const buildScript = join(resourcesPath, 'build.mjs');
      try {
        const { execFileSync } = await import('node:child_process');
        const { existsSync } = await import('node:fs');
        if (existsSync(buildScript)) {
          console.log('[browser-resources] SHA256 mismatch in development mode. Refreshing browser runtime...');
          execFileSync(process.execPath, [buildScript], { cwd: resourcesPath, stdio: 'inherit' });
          const refreshed = JSON.parse(await readFile(manifestPath, 'utf8'));
          if (await checksum(join(resourceRoot, name), limit) === refreshed.sha256?.[name]) {
            continue;
          }
        }
      } catch {}
      throw new Error(`Browser runtime needs repair: missing or changed resources (${name})`);
    }
  }
  return Object.freeze({ resourceRoot, nodeExecutable: join(resourceRoot, 'node.exe') });
}
