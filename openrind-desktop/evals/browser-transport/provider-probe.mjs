// Experiment only: fixed fixture operations, never an arbitrary-code MCP tool.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const cloud = process.argv.includes('--browserbase');
const provider = cloud ? 'browserbase' : 'local-chromium';
const run = randomUUID();
const root = process.env.OPENRIND_PROBE_RESULTS || fileURLToPath(new URL('./results/', import.meta.url));
await mkdir(root, { recursive: true });
const output = await mkdtemp(join(root, `${provider}-`));
const receipt = { provider, run, status: 'started', artifacts: [] };
const persist = () => writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
const bytes = Buffer.from(`browser-artifact-${run}\n`);
const digest = data => createHash('sha256').update(data).digest('hex');
async function artifact(name, data) {
  assert(data.length > 0 && data.length <= 8 * 1024 * 1024);
  await writeFile(join(output, name), data, { flag: 'wx' });
  receipt.artifacts.push({ name, bytes: data.length, sha256: digest(data) });
}
async function api(path, body, binary = false) {
  const response = await fetch(`https://api.browserbase.com/v1/${path}`, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'X-BB-API-Key': process.env.BROWSERBASE_API_KEY,
      'Content-Type': 'application/json', Accept: binary ? 'application/octet-stream' : 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert(response.ok, `Browserbase HTTP ${response.status}`);
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length; assert(size <= 8 * 1024 * 1024, 'API body limit'); chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  return binary ? data : JSON.parse(data.toString());
}
let browser, sessionId;
await persist();
try {
  if (cloud) {
    assert(process.argv.includes('--allow-cloud-session'), 'Explicit cloud session opt-in required');
    assert(process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID, 'Browserbase credentials required');
    receipt.creation = 'requested'; await persist(); // No retry after an ambiguous create.
    const session = await api('sessions', { projectId: process.env.BROWSERBASE_PROJECT_ID,
      timeout: 180, keepAlive: false, userMetadata: { openrindProbe: run } });
    assert(typeof session.id === 'string' && /^[a-zA-Z0-9-]+$/.test(session.id));
    sessionId = session.id; receipt.sessionId = sessionId; receipt.creation = 'confirmed'; await persist();
    const endpoint = new URL(session.connectUrl);
    assert(endpoint.protocol === 'wss:' && (endpoint.hostname === 'connect.browserbase.com' || endpoint.hostname.endsWith('.browserbase.com')));
    browser = await chromium.connectOverCDP(endpoint.href, { timeout: 30_000 });
  } else {
    // Playwright's owned pipe and temporary profile; never a personal browser or listening CDP port.
    const dist = fileURLToPath(new URL('./dist/', import.meta.url));
    const target = JSON.parse(await readFile(join(dist, 'chromium-target.json'), 'utf8'));
    const child = relative(dist, target.executable);
    assert(!isAbsolute(child) && !child.startsWith('..') && child.startsWith('chromium-probe-'));
    assert.equal(digest(await readFile(target.executable)), target.sha256);
    browser = await chromium.launch({ executablePath: target.executable, headless: true, chromiumSandbox: true, timeout: 30_000 });
    receipt.executableSha256 = target.sha256;
    receipt.playwright = target.playwright;
  }
  receipt.browserVersion = browser.version();
  const context = cloud ? browser.contexts()[0] : await browser.newContext({ acceptDownloads: true });
  assert(context, 'Provider default context missing');
  context.setDefaultTimeout(20_000);
  const page = await context.newPage();
  const html = `<title>Openrind provider fixture</title><h1>Browser artifact fixture</h1>
    <label>Name<input id="name"></label><button id="submit" onclick="document.querySelector('output').textContent=document.querySelector('#name').value">Submit</button><output></output>
    <input id="upload" type="file" onchange="this.files[0].text().then(t=>document.querySelector('#uploaded').textContent=t)"><pre id="uploaded"></pre>
    <a id="download" download="fixture.txt" href="data:application/octet-stream;base64,${bytes.toString('base64')}">Download</a>`;
  await page.goto(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  assert.equal(await page.title(), 'Openrind provider fixture');
  await page.getByLabel('Name').fill(run);
  await page.locator('#submit').click();
  await page.waitForFunction(expected => document.querySelector('output').textContent === expected, run);
  const snapshot = await page.locator('body').ariaSnapshot();
  assert(snapshot.includes('Browser artifact fixture'));
  await artifact('snapshot.txt', Buffer.from(snapshot));
  await page.locator('#upload').setInputFiles({ name: 'upload.txt', mimeType: 'text/plain', buffer: bytes });
  await page.waitForFunction(expected => document.querySelector('#uploaded').textContent === expected, bytes.toString());
  await artifact('upload.txt', bytes);
  const screenshot = await page.screenshot();
  assert.equal(screenshot.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  await artifact('screenshot.png', screenshot);
  let downloaded;
  if (cloud) {
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: 'downloads', eventsEnabled: true });
    await page.locator('#download').click();
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await api(`downloads?sessionId=${sessionId}&filename=fixture.txt`);
      const file = result.downloads?.find(item => item.filename === 'fixture.txt');
      if (file) { downloaded = await api(`downloads/${encodeURIComponent(file.id)}`, undefined, true); break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert(downloaded, 'Cloud download sync timed out');
    await cdp.detach();
  } else {
    const pending = page.waitForEvent('download');
    await page.locator('#download').click();
    const download = await pending;
    assert.equal(await download.failure(), null);
    downloaded = await readFile(await download.path());
  }
  assert.deepEqual(downloaded, bytes);
  await artifact('download.txt', downloaded);
  receipt.status = 'passed';
} catch {
  // Playwright errors may contain credential-bearing connect URLs. Never log them.
  receipt.status = 'failed'; process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch { receipt.status = 'failed'; process.exitCode = 1; }
  if (sessionId) {
    try {
      await api(`sessions/${sessionId}`, { status: 'REQUEST_RELEASE' });
      for (let attempt = 0; attempt < 20; attempt++) {
        const state = await api(`sessions/${sessionId}`);
        if (['COMPLETED', 'TIMED_OUT', 'ERROR'].includes(state.status)) { receipt.cleanup = state.status; break; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      assert(receipt.cleanup, 'Cloud release unconfirmed');
    } catch { receipt.cleanup = 'unconfirmed'; receipt.status = 'failed'; process.exitCode = 1; }
  }
  await persist();
  process.stdout.write(`${receipt.status.toUpperCase()} ${provider}; receipt: ${output}\n`);
}
