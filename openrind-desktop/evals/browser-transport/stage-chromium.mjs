import { chromium } from 'playwright';
import { cp, mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const dist = fileURLToPath(new URL('./dist/', import.meta.url));
const executable = chromium.executablePath();
// Install the pinned browser explicitly before final validation; no network or
// silent runtime download and no personal Chrome executable fallback.
await stat(executable);
await mkdir(dist, { recursive: true });
const directory = await mkdtemp(join(dist, 'chromium-probe-'));
await cp(dirname(executable), join(directory, 'runtime'), { recursive: true });
const staged = join(directory, 'runtime', basename(executable));
await writeFile(join(dist, 'chromium-target.json'), JSON.stringify({ executable: staged,
  sha256: createHash('sha256').update(await readFile(staged)).digest('hex'),
  playwright: JSON.parse(await readFile(new URL('./node_modules/playwright/package.json', import.meta.url))).version }, null, 2));
process.stdout.write('Staged pinned Chromium experiment assets\n');
