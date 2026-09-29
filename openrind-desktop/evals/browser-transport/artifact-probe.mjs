import { app, BrowserWindow, WebContentsView } from 'electron';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

if (!process.env.OPENRIND_ELECTRON_PROBE_PROFILE) throw new Error('Disposable profile required');
app.setPath('userData', process.env.OPENRIND_ELECTRON_PROBE_PROFILE);
// Write the receipt before explicitly exiting; closing the fixture must not
// turn an asynchronous failure into Electron's default successful quit.
app.on('window-all-closed', () => {});
void (async () => {
  await app.whenReady();
  const base = resolve(process.env.OPENRIND_PROBE_RESULTS || 'results');
  await mkdir(base, { recursive: true });
  const output = await mkdtemp(join(base, 'desktop-webview-'));
  const receipt = { provider: 'desktop-webview', status: 'started', artifacts: [] };
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const view = new WebContentsView({ webPreferences: { partition: `artifact-${randomUUID()}`, sandbox: true,
    contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  window.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  const wc = view.webContents;
  let stage = 'initialization';
  async function bounded(label, operation) {
    stage = label;
    let timer;
    try { return await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Operation deadline')), 20_000);
    })]); } finally { clearTimeout(timer); }
  }
  const command = (method, params) => bounded(method, () => wc.debugger.sendCommand(method, params));
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.session.setPermissionRequestHandler((_w, _p, reply) => reply(false));
  wc.session.setPermissionCheckHandler(() => false);
  wc.on('will-navigate', event => event.preventDefault());
  const payload = Buffer.from(`embedded-artifact-${randomUUID()}\n`);
  async function record(name, bytes) {
    assert(bytes.length > 0 && bytes.length <= 8 * 1024 * 1024);
    await writeFile(join(output, name), bytes, { flag: 'wx' });
    receipt.artifacts.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  try {
    await record('upload.txt', payload);
    // Initialize the renderer before attaching, as in the owned-view probe.
    await bounded('initial document', () => wc.loadURL('about:blank'));
    wc.debugger.attach('1.3');
    await command('Page.enable');
    await command('Page.setInterceptFileChooserDialog', { enabled: true });
    await wc.loadURL(`data:text/html;base64,${Buffer.from(`<h1>Embedded artifact fixture</h1><input id="upload" type="file" onchange="this.files[0].text().then(t=>document.querySelector('pre').textContent=t)"><pre></pre><a id="download" download="fixture.txt" href="data:application/octet-stream;base64,${payload.toString('base64')}">Download</a>`).toString('base64')}`);
    const { root } = await command('DOM.getDocument');
    const { nodeId } = await command('DOM.querySelector', { nodeId: root.nodeId, selector: '#upload' });
    await command('DOM.setFileInputFiles', { nodeId, files: [join(output, 'upload.txt')] });
    // Fixed fixture expressions only; no untrusted expressions or caller-selected paths.
    let uploaded;
    for (let i = 0; i < 40; i++) {
      uploaded = (await command('Runtime.evaluate', { expression: "document.querySelector('pre').textContent", returnByValue: true })).result.value;
      if (uploaded === payload.toString()) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(uploaded, payload.toString());
    const download = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Download timeout')), 20_000);
      wc.session.once('will-download', (event, item, source) => {
        if (source !== wc) { event.preventDefault(); clearTimeout(timer); reject(new Error('Wrong owner')); return; }
        item.setSavePath(join(output, 'download.pending'));
        item.once('done', (_event, state) => { clearTimeout(timer); state === 'completed' ? resolve() : reject(new Error('Download failed')); });
      });
    });
    // Observe rejection immediately if the triggering CDP call itself fails.
    void download.catch(() => {});
    await command('Runtime.evaluate', { expression: "document.querySelector('#download').click()" });
    await download;
    const downloaded = await readFile(join(output, 'download.pending'));
    assert.deepEqual(downloaded, payload);
    await record('download.txt', downloaded);
    // A never-shown native view has no compositor surface on Windows.
    // Display only this disposable fixture without stealing keyboard focus.
    window.showInactive();
    const capture = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const png = Buffer.from(capture.data, 'base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    await record('screenshot.png', png);
    receipt.status = 'passed';
  } catch { receipt.status = 'failed'; receipt.failedStage = stage; }
  finally {
    if (!wc.isDestroyed()) wc.close();
    window.destroy();
    await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
    process.stdout.write(`${receipt.status.toUpperCase()} embedded artifacts; receipt: ${output}\n`);
    app.exit(receipt.status === 'passed' ? 0 : 1);
  }
})().catch(() => { process.stderr.write('FAIL artifact fixture initialization\n'); app.exit(1); });
