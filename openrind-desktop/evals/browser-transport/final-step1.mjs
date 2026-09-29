// One explicit final validation run. Missing prerequisites never become PASS.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('.', import.meta.url));
const results = join(root, 'results');
await mkdir(results, { recursive: true });
const run = await mkdtemp(join(results, 'final-step1-'));
const report = { started: new Date().toISOString(), scope: 'risk harnesses, not production acceptance', checks: [] };
const persist = () => writeFile(join(run, 'summary.json'), JSON.stringify(report, null, 2));
const args = new Set(process.argv.slice(2));
const evidence = join(run, 'providers');
await mkdir(evidence);
const env = { ...process.env, OPENRIND_PROBE_RESULTS: evidence };
async function check(name, command, argv, enabled = true, missing = '', timeout = 300_000) {
  const item = { name, status: enabled ? 'running' : 'blocked', ...(enabled ? {} : { reason: missing }) };
  report.checks.push(item); await persist();
  if (!enabled) return false;
  item.status = await new Promise(resolve => {
    const child = spawn(command, argv, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
    }, timeout);
    child.once('error', () => { clearTimeout(timer); resolve('failed'); });
    child.once('close', code => { clearTimeout(timer); resolve(code === 0 && !timedOut ? 'passed' : 'failed'); });
  });
  await persist(); return item.status === 'passed';
}
const node = process.execPath;
const unitFiles = (await readdir(join(root, 'test'))).filter(n => n.endsWith('.test.mjs')).map(n => join('test', n));
await check('protocol contracts', node, ['--test', '--test-concurrency=1', ...unitFiles]);
const built = await check('transport bundle', node, ['build.mjs']);
const packaged = await check('portable Electron package', node, ['package-probe.mjs'], built, 'Transport build failed');
await check('binary WSL bridge', node, ['live-wsl.mjs'], built, 'Transport build failed');
for (const [name, flags] of [
  ['packaged native MCP bridge', ['--openshell']], ['worker EOF', ['--crash-worker']],
  ['nested owned frames', ['--embedded', '--oopif', '--nested']],
  ['child guard failure', ['--embedded', '--oopif', '--fail-child-guard']],
  ['input ownership', ['--input']], ['embedded artifacts', ['--artifacts']],
]) await check(name, node, ['live-electron.mjs', '--packaged', ...flags], packaged, 'Package unavailable');
const nativePassed = await check('native input matrix', node, ['live-electron.mjs', '--packaged', '--native', '--matrix',
  ...(args.has('--extended-input') ? ['--extended-input'] : []), ...(args.has('--dpi') ? ['--dpi'] : [])],
  packaged && args.has('--interactive'), 'Requires --interactive and physical input', 660_000);
const chromiumStaged = await check('stage pinned Chromium assets', node, ['stage-chromium.mjs']);
await check('local Chromium artifacts', node, ['provider-probe.mjs'], chromiumStaged, 'Install pinned Playwright Chromium before final validation');
await check('Browserbase artifacts and release', node, ['provider-probe.mjs', '--browserbase', '--allow-cloud-session'],
  args.has('--allow-cloud-session') && !!env.BROWSERBASE_API_KEY && !!env.BROWSERBASE_PROJECT_ID,
  'Requires --allow-cloud-session and Browserbase key/project');
// Only this invocation's successful provider receipts are eligible for FUSE.
const staging = join(run, 'artifacts'); await mkdir(staging);
const providers = new Set(); const sums = [];
for (const name of await readdir(evidence)) {
  if (!/^(local-chromium|browserbase|desktop-webview)-/.test(name)) continue;
  const directory = join(evidence, name);
  let receipt; try { receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8')); } catch { continue; }
  if (receipt.status !== 'passed' || providers.has(receipt.provider) || !['local-chromium', 'browserbase', 'desktop-webview'].includes(receipt.provider)) continue;
  for (const required of ['upload.txt', 'download.txt', 'screenshot.png']) {
    const entry = receipt.artifacts.find(a => a.name === required);
    if (!entry) throw new Error('Incomplete provider receipt');
    const bytes = await readFile(join(directory, required));
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== entry.sha256 || bytes.length !== entry.bytes) throw new Error('Artifact receipt mismatch');
    const target = `${receipt.provider}-${required}`;
    await copyFile(join(directory, required), join(staging, target));
    sums.push(`${sha}  ${target}`);
  }
  providers.add(receipt.provider);
}
await writeFile(join(staging, 'SHA256SUMS'), sums.join('\n') + '\n');
// WSLENV forwards only the named prerequisites; values never enter command lines.
env.WSLENV = [...(env.WSLENV || '').split(':').filter(Boolean), 'DATABASE_URL', 'OPENSHELL_GATEWAY_ENDPOINT', 'OPENRIND_BROWSER_FUSE_IMAGE'].join(':');
const wslPath = path => { if (!/^[A-Za-z]:[\\/]/.test(path)) throw new Error('Windows drive path required'); return `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll('\\', '/')}`; };
const distro = env.OPENRIND_WSL_DISTRO || 'openrind-desktop-openshell';
for (const [name, settings] of [['HTTP SSE', []], ['HTTP JSON', ['PROBE_JSON=1']], ['TLS SSE', ['PROBE_TLS=1']],
  ['denied reachable port', ['PROBE_NEGATIVE=wrong-port']], ['untrusted TLS CA', ['PROBE_NEGATIVE=untrusted-ca']], ['direct socket denial', ['PROBE_NEGATIVE=direct']]]) {
  await check(name, 'wsl.exe', ['-d', distro, '--', 'env', ...settings, 'bash', wslPath(join(root, 'run-live.sh'))], built, 'Transport build failed');
}
await check('all provider artifacts survive FUSE replacement', 'wsl.exe', ['-d', distro, '--', 'bash', wslPath(join(root, 'run-fuse-artifacts.sh')), wslPath(staging)],
  args.has('--fuse') && providers.size === 3 && !!env.DATABASE_URL && !!env.OPENSHELL_GATEWAY_ENDPOINT,
  'Requires --fuse, disposable database/gateway and all three fresh provider receipts', 600_000);
report.checks.push({ name: 'native touch, IME, external drop and DPI evidence',
  status: nativePassed && args.has('--extended-input') && args.has('--dpi') ? 'passed' : 'blocked',
  reason: 'Requires successful --interactive --extended-input --dpi physical fixture; base gesture counters are insufficient' });
for (const [name, reason] of [
  ['runtime go/no-go', 'Review final results, shipping Chromium assets/Electron fuses and remaining platform limitations'],
]) report.checks.push({ name, status: 'blocked', reason });
report.finished = new Date().toISOString();
report.status = report.checks.every(item => item.status === 'passed') ? 'passed' : 'incomplete';
await persist();
process.stdout.write(`Step 1 ${report.status}; summary: ${join(run, 'summary.json')}\n`);
process.exitCode = report.status === 'passed' ? 0 : 1;
