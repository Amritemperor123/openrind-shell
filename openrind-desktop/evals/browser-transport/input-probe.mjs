import { app, BrowserWindow, WebContentsView } from "electron";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const profile = process.env.OPENRIND_ELECTRON_PROBE_PROFILE;
if (!profile) throw new Error("Disposable profile required");
app.setPath("userData", profile);

async function main() {
  let window, page, shield, result = 1, stage = "startup";
  let mode = "automating", epoch = 0, blockedKeys = 0;
  const active = new Set();
  try {
    await app.whenReady();
    const preferences = () => ({ sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, partition: `input-probe-${randomUUID()}` });
    window = new BrowserWindow({ width: 680, height: 380, show: false,
      title: "Openrind input ownership test", webPreferences: preferences() });
    page = new WebContentsView({ webPreferences: preferences() });
    shield = new WebContentsView({ webPreferences: preferences() });
    window.contentView.addChildView(page);
    window.contentView.addChildView(shield);
    const bounds = { x: 0, y: 0, width: 650, height: 320 };
    page.setBounds(bounds); shield.setBounds(bounds);
    for (const wc of [window.webContents, page.webContents, shield.webContents]) {
      wc.setWindowOpenHandler(() => ({ action: "deny" }));
      wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      wc.session.setPermissionCheckHandler(() => false);
      wc.on("will-navigate", event => event.preventDefault());
    }
    page.webContents.on("before-input-event", event => {
      if (mode !== "human") { blockedKeys++; event.preventDefault(); }
    });
    page.webContents.debugger.on("detach", () => {
      mode = "fenced"; epoch++; page.setVisible(false); shield.setVisible(true);
    });
    await page.webContents.loadURL("data:text/html," + encodeURIComponent(
      '<title>Input fixture</title><input autofocus><script>window.keys=0;addEventListener("keydown",()=>window.keys++)</script>'));
    await shield.webContents.loadURL("data:text/html," + encodeURIComponent(
      '<style>body{font:20px sans-serif;background:#eef2f8}</style><p>Input ownership test running</p>'));
    page.webContents.debugger.attach("1.3");
    async function agent(operation) {
      if (mode !== "automating") throw new Error("Denied");
      const issuedEpoch = epoch;
      const pending = (async () => {
        // Only fixed test operations, never a caller-controlled CDP expression.
        let value;
        if (operation === "read") value = await page.webContents.debugger.sendCommand("Runtime.evaluate", {
          expression: 'document.querySelector("input").value', returnByValue: true,
        });
        else if (operation === "type") value = await page.webContents.debugger.sendCommand("Input.insertText", { text: "agent" });
        else if (operation === "capture") value = await page.webContents.capturePage();
        else throw new Error("Denied");
        if (mode !== "automating" || epoch !== issuedEpoch) throw new Error("Denied");
        return value;
      })();
      active.add(pending);
      try { return await pending; } finally { active.delete(pending); }
    }
    async function takeControl() {
      if (mode !== "automating") throw new Error("Denied");
      mode = "draining"; epoch++;
      await Promise.allSettled([...active]);
      if (mode !== "draining") throw new Error("Denied");
      mode = "human"; shield.setVisible(false);
    }
    function releaseControl() {
      if (mode !== "human") throw new Error("Denied");
      shield.setVisible(true); epoch++; mode = "automating";
    }
    // sendInputEvent needs a focused window. This is synthetic input, not OS hit testing.
    window.show(); window.focus(); page.webContents.focus();
    await page.webContents.executeJavaScript('document.querySelector("input").focus()');
    const key = () => {
      page.webContents.sendInputEvent({ type: "keyDown", keyCode: "A" });
      page.webContents.sendInputEvent({ type: "keyUp", keyCode: "A" });
    };
    stage = "automation keyboard block";
    key();
    assert.equal(await page.webContents.executeJavaScript("window.keys"), 0);
    assert.ok(blockedKeys > 0);
    stage = "agent action with shield retained";
    assert.equal(shield.getVisible(), true);
    await agent("type");
    assert.equal((await agent("read")).result.value, "agent");
    assert.equal(shield.getVisible(), true);
    assert.deepEqual(shield.getBounds(), page.getBounds());
    stage = "takeover drainage and observation denial";
    const pending = agent("read");
    const denied = assert.rejects(pending, /Denied/);
    const handoff = takeControl();
    assert.equal(mode, "draining");
    assert.equal(shield.getVisible(), true);
    await assert.rejects(agent("read"), /Denied/);
    await Promise.all([denied, handoff]);
    for (const operation of ["read", "type", "capture"]) await assert.rejects(agent(operation), /Denied/);
    stage = "human keyboard positive control";
    page.webContents.focus();
    await page.webContents.executeJavaScript(`window.keyArrived = new Promise(resolve => {
      addEventListener('keydown', () => resolve(true), { once: true });
      setTimeout(() => resolve(false), 2000);
    }); true`);
    key();
    assert.equal(await page.webContents.executeJavaScript("window.keyArrived"), true);
    assert.equal(await page.webContents.executeJavaScript("window.keys"), 1);
    stage = "release restores protection";
    releaseControl(); key();
    assert.equal(await page.webContents.executeJavaScript("window.keys"), 1);
    assert.equal(shield.getVisible(), true);
    await agent("read");
    stage = "debugger loss fencing";
    page.webContents.debugger.detach();
    await assert.rejects(agent("read"), /Denied/);
    assert.equal(page.getVisible(), false);
    assert.equal(shield.getVisible(), true);
    process.stdout.write("PASS synthetic keyboard exclusion, shield-retained agent input, draining takeover, human observation denial, release and debugger-loss fencing\n");
    result = 0;
  } catch {
    process.stderr.write(`FAIL input probe: ${stage}\n`);
  } finally {
    for (const view of [page, shield]) if (view?.webContents && !view.webContents.isDestroyed()) view.webContents.close();
    window?.destroy(); app.exit(result);
  }
}
void main();
