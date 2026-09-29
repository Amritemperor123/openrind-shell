import { app, BrowserWindow, WebContentsView, screen } from "electron";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (!process.env.OPENRIND_ELECTRON_PROBE_PROFILE) throw new Error("Disposable profile required");
app.setPath("userData", process.env.OPENRIND_ELECTRON_PROBE_PROFILE);
const html = source => "data:text/html," + encodeURIComponent(source);
const instrument = `<script>window.counts={click:0,wheel:0,key:0,drag:0,dragstart:0,drop:0,touch:0,composition:0,filedrop:0,childkey:0};
addEventListener('click',()=>counts.click++);addEventListener('wheel',()=>counts.wheel++);
addEventListener('keydown',()=>counts.key++);
addEventListener('pointermove',event=>{if(event.buttons&1)counts.drag++});
addEventListener('touchstart',()=>counts.touch++);addEventListener('compositionend',()=>counts.composition++);
addEventListener('dragover',e=>e.preventDefault());
addEventListener('dragstart',()=>counts.dragstart++);addEventListener('drop',e=>{e.preventDefault();counts.drop++;if(e.dataTransfer.files.length)counts.filedrop++});
addEventListener('message',e=>{if(e.source===document.querySelector('iframe')?.contentWindow&&e.data==='fixture-child-key')counts.childkey++});</script>`;
async function main() {
  await app.whenReady();
  const prefs = () => ({ sandbox: true, contextIsolation: true, nodeIntegration: false,
    partition: `native-probe-${randomUUID()}` });
  const win = new BrowserWindow({ width: 820, height: 620, show: false,
    title: "Openrind native shield fixture", webPreferences: prefs() });
  const page = new WebContentsView({ webPreferences: prefs() });
  const shield = new WebContentsView({ webPreferences: prefs() });
  let mode = "automating", phase = 0, beforeRestore, done = false;
  const matrix = process.argv.includes('--matrix');
  const extended = process.argv.includes('--extended-input');
  const requireDpi = process.argv.includes('--dpi');
  const geometry = new Set();
  const scales = new Set([screen.getDisplayMatching(win.getBounds()).scaleFactor]);
  win.on('move', () => scales.add(screen.getDisplayMatching(win.getBounds()).scaleFactor));
  screen.on('display-metrics-changed', () => scales.add(screen.getDisplayMatching(win.getBounds()).scaleFactor));
  let collapsed = false, modal;
  win.contentView.addChildView(page); win.contentView.addChildView(shield);
  shield.setBackgroundColor("#01ffffff");
  const layout = () => {
    const [width, height] = win.getContentSize();
    const top = matrix ? 220 : 120;
    const bounds = { x: 0, y: top, width, height: Math.max(0, height - top) };
    page.setBounds(bounds); shield.setBounds(bounds);
    assert.deepEqual(page.getBounds(), shield.getBounds());
  };
  layout(); win.on("resize", layout);
  for (const wc of [win.webContents, page.webContents, shield.webContents]) {
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    wc.session.setPermissionCheckHandler(() => false);
    wc.on("will-navigate", event => event.preventDefault());
  }
  page.webContents.on("before-input-event", event => { if (mode !== "human") event.preventDefault(); });
  const close = code => {
    if (done) return;
    done = true; clearInterval(poll);
    for (const view of [page, shield]) if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close();
    win.destroy(); app.exit(code);
  };
  const counts = view => view.webContents.executeJavaScript("({...window.counts})");
  // Test-only host telemetry counts events; it never reads entered text.
  let polling = false;
  const poll = setInterval(async () => {
    if (done || polling) return;
    polling = true;
    try {
      const [p, s] = await Promise.all([counts(page), counts(shield)]);
      if (!done) await win.webContents.executeJavaScript(`document.querySelector('#status').textContent=${JSON.stringify(`Mode: ${mode}\npage ${JSON.stringify(p)}\nshield ${JSON.stringify(s)}`)}`);
    } catch { /* A closing renderer is not a test action. */ }
    finally { polling = false; }
  }, 200);
  win.on("closed", () => { if (!done) { clearInterval(poll); app.exit(1); } });
  // Fixed controls live in the trusted fixture chrome, never in the tested page.
  win.webContents.on("console-message", async (_event, ...args) => {
    const command = typeof args[0] === "object" ? args[0].message : args[1];
    if (!['probe:human','probe:automate','probe:finish','probe:resize','probe:zoom','probe:collapse','probe:minimize','probe:modal'].includes(command) || done) return;
    try {
      if (command === 'probe:resize') {
        assert.equal(mode, 'automating'); win.setSize(1000, 740); layout(); geometry.add('resize'); return;
      }
      if (command === 'probe:zoom') {
        assert.equal(mode, 'automating'); page.webContents.setZoomFactor(1.5); layout(); geometry.add('zoom'); return;
      }
      if (command === 'probe:collapse') {
        assert.equal(mode, 'automating'); collapsed = !collapsed;
        page.setVisible(!collapsed); shield.setVisible(!collapsed);
        if (!collapsed) { layout(); geometry.add('collapse'); } return;
      }
      if (command === 'probe:minimize') {
        assert.equal(mode, 'automating'); win.minimize();
        win.once('restore', () => { layout(); geometry.add('minimize'); }); return;
      }
      if (command === 'probe:modal') {
        assert.equal(mode, 'automating'); assert(!modal);
        page.setVisible(false); shield.setVisible(false);
        modal = new BrowserWindow({ parent: win, modal: true, width: 380, height: 200, webPreferences: prefs() });
        modal.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        modal.on('closed', () => { modal = undefined; if (!done) { layout(); shield.setVisible(true); page.setVisible(true); geometry.add('modal'); } });
        await modal.loadURL(html('<h2>Trusted fixture modal</h2><p>Close this window, then repeat protected input.</p>')); return;
      }
      assert(!collapsed && !modal, 'Restore the page before handoff');
      const p = await counts(page), s = await counts(shield);
      if (command === "probe:human") {
        assert.equal(phase, 0); assert.equal(p.click, 0); assert.equal(p.wheel, 0);
        assert.equal(p.drag, 0); assert.equal(p.dragstart, 0); assert.equal(p.drop, 0);
        for (const field of ['key', 'touch', 'composition', 'filedrop', 'childkey']) assert.equal(p[field], 0);
        assert.ok(s.click > 0 && s.wheel > 0 && s.drag > 0);
        if (extended) assert(s.touch > 0 && s.filedrop > 0, 'Touch and harmless file drop must reach shield');
        phase = 1; mode = "human"; shield.setVisible(false);
      } else if (command === "probe:automate") {
        assert.equal(phase, 1); assert.ok(p.click > 0 && p.wheel > 0 && p.key > 0);
        assert.ok(p.drag > 0 && p.dragstart > 0);
        if (extended) assert(p.touch > 0 && p.composition > 0 && p.drop > 0 && p.filedrop > 0 && p.childkey > 0,
          'Human touch, IME, completed drop, harmless file drop and child-frame typing required');
        beforeRestore = { p, s }; shield.setVisible(true); mode = "automating"; phase = 2;
      } else {
        assert.equal(phase, 2); assert.deepEqual(p, beforeRestore.p);
        if (matrix) for (const required of ['resize', 'zoom', 'collapse', 'minimize', 'modal']) assert(geometry.has(required), `Missing ${required}`);
        if (requireDpi) assert(scales.size > 1, 'Move between displays with different scale factors or change display scaling');
        if (extended) assert(s.touch > beforeRestore.s.touch && s.filedrop > beforeRestore.s.filedrop);
        assert.ok(s.click > beforeRestore.s.click && s.wheel > beforeRestore.s.wheel);
        assert.ok(s.drag > beforeRestore.s.drag);
        process.stdout.write(`PASS native click/wheel/drag-gesture exclusion, human click/wheel/key/drag-start positive controls and protection after release; Electron ${process.versions.electron}; packaged=${app.isPackaged}\n`);
        process.stdout.write(`INFO human HTML drop events observed: ${p.drop}; completed drop delivery is a separate gate\n`);
        process.stdout.write(`INFO extended-input=${extended}; dpi-change=${requireDpi && scales.size > 1}; geometry=${[...geometry].join(',')}\n`);
        close(0);
      }
    } catch {
      process.stderr.write(`FAIL native shield phase ${phase}\n`); close(1);
    }
  });
  await win.webContents.loadURL(html(`<style>body{font:15px sans-serif;background:#e7edf5}button{padding:10px;margin:4px}#status{white-space:pre;font:12px monospace;margin:2px 0}</style>
    <button onclick="console.log('probe:human')">Human mode</button><button onclick="console.log('probe:automate')">Automation mode</button><button onclick="console.log('probe:finish')">Finish check</button>
    ${matrix ? '<button onclick="console.log(\'probe:resize\')">Resize</button><button onclick="console.log(\'probe:zoom\')">Zoom</button><button onclick="console.log(\'probe:collapse\')">Collapse/restore</button><button onclick="console.log(\'probe:minimize\')">Minimize</button><button onclick="console.log(\'probe:modal\')">Modal</button>' : ''}<p id="status">Loading</p>`));
  await page.webContents.loadURL(html(`<style>body{font:22px sans-serif;background:#d3f4dd;height:1400px;margin:24px}input{font:22px sans-serif;padding:12px}</style>
    <h2>Visible page under transparent shield</h2><p>Click, type and scroll in this green area.</p><input placeholder="Harmless test text">
    <div style="display:flex;gap:30px;margin-top:20px"><div draggable="true" ondragstart="event.dataTransfer.setData('text/plain','fixture')" style="background:#87bfff;padding:20px">Drag this box</div>
    <div ondragover="event.preventDefault()" ondrop="event.preventDefault()" style="background:#ffdb83;padding:20px">Drop here</div></div>
    <iframe title="Child input fixture" srcdoc="<input placeholder='Child-frame text' onkeydown=&quot;parent.postMessage('fixture-child-key','*')&quot;>"></iframe><p>Scroll target below</p>${instrument}`));
  await shield.webContents.loadURL(html(`<style>html,body{margin:0;width:100%;height:100%;background:rgba(255,255,255,0.01);overflow:hidden}</style>${instrument}`));
  win.show(); win.focus();
  process.stdout.write("READY native shield fixture; no automatic PASS without native event evidence\n");
}
void main().catch(() => { process.stderr.write("FAIL native fixture startup\n"); app.exit(1); });
