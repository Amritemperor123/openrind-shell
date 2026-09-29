import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// Explicit receipts only. Never discover or silently reuse unrelated runs.
const inputs = process.argv.slice(2);
assert(inputs.length === 2 || inputs.length === 3, 'Supply two local receipts or all three provider receipts');
const root = fileURLToPath(new URL('./results/', import.meta.url));
await mkdir(root, { recursive: true });
const output = await mkdtemp(join(root, 'fuse-staging-'));
const seen = new Set(), lines = [], sources = [];
for (const input of inputs) {
  const receipt = JSON.parse(await readFile(join(input, 'receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'passed');
  assert(['local-chromium', 'desktop-webview', 'browserbase'].includes(receipt.provider));
  assert(!seen.has(receipt.provider)); seen.add(receipt.provider);
  for (const name of ['upload.txt', 'download.txt', 'screenshot.png']) {
    const entry = receipt.artifacts.find(item => item.name === name);
    assert(entry && entry.bytes > 0 && entry.bytes <= 8 * 1024 * 1024);
    const bytes = await readFile(join(input, name));
    assert.equal(bytes.length, entry.bytes);
    const hash = createHash('sha256').update(bytes).digest('hex');
    assert.equal(hash, entry.sha256);
    const target = `${receipt.provider}-${name}`;
    await writeFile(join(output, target), bytes, { flag: 'wx' });
    lines.push(`${hash}  ${target}`);
  }
  sources.push({ provider: receipt.provider, receipt: input });
}
assert(seen.has('local-chromium') && seen.has('desktop-webview'));
await writeFile(join(output, 'SHA256SUMS'), lines.join('\n') + '\n');
await writeFile(join(output, 'sources.json'), JSON.stringify({ partial: seen.size !== 3, sources }, null, 2));
process.stdout.write(`${output}\n`);
