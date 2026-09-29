import { app, BaseWindow, WebContentsView } from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const profile = process.env.OPENRIND_ELECTRON_PROBE_PROFILE;
if (!profile) throw new Error("Disposable profile required");
app.setPath("userData", profile);
const oopif = process.argv.includes("--oopif");
const nested = process.argv.includes("--nested");
if (nested && !oopif) throw new Error("Nested test requires OOPIF mode");
const failChildGuard = process.argv.includes("--fail-child-guard");
if (failChildGuard && !oopif) throw new Error("Child guard failure test requires OOPIF mode");
if (oopif) {
  app.commandLine.appendSwitch("site-per-process");
  app.commandLine.appendSwitch("host-resolver-rules", "MAP child.browser.test 127.0.0.1, MAP nested.example.test 127.0.0.1");
  app.commandLine.appendSwitch("no-proxy-server");
}

async function main() {
  let result = 1, window, server, childServer;
  const views = [];
  let stage = "startup";
  try {
    await app.whenReady();
    childServer = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(req.url === "/nested"
        ? '<title>Nested child</title><input type="file">'
        : '<title>Cross-origin child</title><input type="file"><p>Child fixture</p>'
          + (nested ? `<iframe src="http://nested.example.test:${childServer.address().port}/nested"></iframe>` : ''));
    });
    await new Promise(resolve => childServer.listen(0, "127.0.0.1", resolve));
    const childUrl = `http://${oopif ? "child.browser.test" : "127.0.0.1"}:${childServer.address().port}/`;
    server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(req.url === "/child"
        ? '<title>Same-origin child</title><p>Child fixture</p>'
        : `<title>Owned fixture</title><input type="file"><iframe src="/child"></iframe><iframe src="${childUrl}"></iframe>`);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    window = new BaseWindow({ show: false, width: 800, height: 600 });
    const registry = new Map();
    const frameHandles = new Map();
    function issueFrameHandles(owner, id) {
      const record = registry.get(id);
      if (!record || record.owner !== owner || record.fenced) throw new Error("Denied");
      return record.view.webContents.mainFrame.frames.map(frame => {
        const handle = randomUUID();
        frameHandles.set(handle, { record, frame, epoch: record.epoch });
        return handle;
      });
    }
    async function frameTitle(owner, handle) {
      const grant = frameHandles.get(handle);
      const valid = () => grant && grant.record.owner === owner && !grant.record.fenced
        && grant.epoch === grant.record.epoch
        && !grant.record.view.webContents.isDestroyed()
        && grant.record.view.webContents.mainFrame.framesInSubtree.includes(grant.frame);
      if (!valid()) throw new Error("Denied");
      // Fixed internal inspection only; no caller-provided expressions or frame IDs.
      const value = await grant.frame.executeJavaScript("document.title");
      if (!valid()) throw new Error("Denied");
      return value;
    }
    function createOwned(owner) {
      const view = new WebContentsView({ webPreferences: {
        partition: `probe-${randomUUID()}`, sandbox: true, contextIsolation: true,
        nodeIntegration: false, webSecurity: true, webviewTag: false,
      } });
      views.push(view);
      window.contentView.addChildView(view);
      view.setBounds({ x: 0, y: 0, width: 400, height: 300 });
      const wc = view.webContents;
      wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      wc.session.setPermissionCheckHandler(() => false);
      wc.setWindowOpenHandler(() => ({ action: "deny" }));
      wc.on("will-navigate", (event, target) => { if (target !== url) event.preventDefault(); });
      const record = { owner, view, wc, fenced: false, epoch: 0, childSessions: new Map(), parents: new Map(), guarded: new Set() };
      wc.debugger.on("message", (_event, method, params) => {
        if (method === "Page.frameAttached") record.parents.set(params.frameId, params.parentFrameId);
        if (method === "Page.frameDetached" && params.reason !== "swap") record.parents.delete(params.frameId);
        if (method === "Target.attachedToTarget" && params.targetInfo.type === "iframe") {
          record.childSessions.set(params.sessionId, params.targetInfo.targetId);
          // The child remains paused until its own chooser guard is installed.
          void (async () => {
            await wc.debugger.sendCommand("Page.enable", {}, params.sessionId);
            if (failChildGuard) throw new Error("Injected guard installation failure");
            await wc.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true }, params.sessionId);
            // Autoattach is not recursive: guard descendants before this child runs.
            await wc.debugger.sendCommand("Target.setAutoAttach", {
              autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
            }, params.sessionId);
            if (record.fenced || !record.childSessions.has(params.sessionId)) return;
            record.guarded.add(params.sessionId);
            await wc.debugger.sendCommand("Runtime.runIfWaitingForDebugger", {}, params.sessionId);
          })().catch(() => {
            record.fenced = true; view.setVisible(false);
            if (!wc.isDestroyed()) wc.close();
          });
        }
        if (method === "Target.detachedFromTarget") {
          record.childSessions.delete(params.sessionId);
          record.guarded.delete(params.sessionId);
        }
      });
      // Conservative experiment policy: any frame navigation invalidates all refs.
      wc.on("did-start-navigation", () => {
        record.epoch++;
        for (const [handle, grant] of frameHandles) {
          if (grant.record === record) frameHandles.delete(handle);
        }
      });
      registry.set(wc.id, record);
      wc.debugger.on("detach", () => { record.fenced = true; view.setVisible(false); });
      return record;
    }
    // Private fixed operation: callers cannot supply CDP commands or expressions.
    async function title(owner, id) {
      const record = registry.get(id);
      if (!record || record.owner !== owner || record.fenced) throw new Error("Denied");
      const response = await record.view.webContents.debugger.sendCommand("Runtime.evaluate", {
        expression: "document.title", returnByValue: true,
      });
      if (record.fenced) throw new Error("Denied");
      return response.result.value;
    }
    const a = createOwned("a"), b = createOwned("b");
    stage = "navigation";
    // Establish interception on a blank owned page before untrusted navigation.
    for (const view of views) {
      await view.webContents.loadURL("about:blank");
      view.webContents.debugger.attach("1.3");
      await view.webContents.debugger.sendCommand("Page.enable");
      await view.webContents.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true });
      if (oopif) await view.webContents.debugger.sendCommand("Target.setAutoAttach", {
        autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      });
    }
    if (failChildGuard) {
      stage = "child guard failure fencing";
      await Promise.allSettled(views.map(view => view.webContents.loadURL(url)));
      for (const record of [a, b]) {
        assert.equal(record.fenced, true);
        assert.equal(record.guarded.size, 0);
        assert.equal(record.wc.isDestroyed(), true);
      }
      process.stdout.write("PASS child guard installation failure closes owned views before resume\n");
      result = 0;
      return;
    }
    await Promise.all(views.map(view => view.webContents.loadURL(url)));
    stage = "ownership";
    assert.equal(await title("a", a.view.webContents.id), "Owned fixture");
    await assert.rejects(title("b", a.view.webContents.id), /Denied/);
    await assert.rejects(title("a", -1), /Denied/);
    const staleChildChecks = [];
    if (oopif) {
      stage = "separate renderer and scoped CDP routing";
      const root = a.view.webContents.mainFrame;
      assert.notEqual(root.frames[1].processId, root.processId);
      stage = "OOPIF autoattach count";
      assert.equal(a.childSessions.size, nested ? 2 : 1);
      const [sessionId, targetId] = [...a.childSessions][0];
      const issuedEpoch = a.epoch;
      // Only descendant sessions emitted by this owned debugger are accepted.
      // Prove target membership in the current root tree before fixed inspection.
      async function childTitle(owner, record, session) {
        if (record.owner !== owner || record.fenced || record.epoch !== issuedEpoch
          || !record.childSessions.has(session) || !record.guarded.has(session)) throw new Error("Denied");
        const epoch = record.epoch;
        const { frameTree } = await record.view.webContents.debugger.sendCommand("Page.getFrameTree");
        const ids = new Set();
        const visit = tree => { ids.add(tree.frame.id); for (const child of tree.childFrames ?? []) visit(child); };
        visit(frameTree);
        const belongs = id => {
          const seen = new Set();
          while (!ids.has(id)) {
            if (seen.has(id) || !record.parents.has(id)) return false;
            seen.add(id); id = record.parents.get(id);
          }
          return true;
        };
        stage = "OOPIF current tree membership";
        if (!belongs(record.childSessions.get(session))) throw new Error("Denied");
        stage = "OOPIF CDP evaluate";
        const response = await record.view.webContents.debugger.sendCommand("Runtime.evaluate", {
          expression: "document.title", returnByValue: true,
        }, session);
        stage = "OOPIF post-inspection fencing";
        if (record.fenced || epoch !== record.epoch || !record.childSessions.has(session)) throw new Error("Denied");
        return response.result.value;
      }
      assert.ok(targetId);
      stage = "OOPIF owned inspection";
      assert.equal(await childTitle("a", a, sessionId), "Cross-origin child");
      stage = "OOPIF cross-owner negatives";
      await assert.rejects(childTitle("b", a, sessionId), /Denied/);
      await assert.rejects(childTitle("b", b, sessionId), /Denied/);
      await assert.rejects(childTitle("a", a, randomUUID()), /Denied/);
      let chooserSession = sessionId;
      if (nested) {
        stage = "nested ownership and renderer isolation";
        const child = root.frames[1], grandchild = child.frames[0];
        assert.notEqual(grandchild.processId, child.processId);
        assert.notEqual(grandchild.processId, root.processId);
        chooserSession = [...a.childSessions.keys()].find(id => id !== sessionId);
        assert.equal(await childTitle("a", a, chooserSession), "Nested child");
        await assert.rejects(childTitle("b", a, chooserSession), /Denied/);
        await assert.rejects(childTitle("b", b, chooserSession), /Denied/);
        process.stdout.write("PASS nested separate renderer and owner-scoped descendant routing\n");
      }
      staleChildChecks.push(() => childTitle("a", a, sessionId));
      if (nested) staleChildChecks.push(() => childTitle("a", a, chooserSession));
      stage = "OOPIF chooser guard";
      assert.ok(a.guarded.has(chooserSession));
      let chooserTimer;
      const childChooser = new Promise((resolve, reject) => {
        const listener = (_event, method, params, sourceSession) => {
          if (method !== "Page.fileChooserOpened" || sourceSession !== chooserSession) return;
          clearTimeout(chooserTimer);
          a.view.webContents.debugger.removeListener("message", listener);
          resolve(params);
        };
        a.view.webContents.debugger.on("message", listener);
        chooserTimer = setTimeout(() => {
          a.view.webContents.debugger.removeListener("message", listener);
          reject(new Error("Child chooser timeout"));
        }, 3000);
      });
      await Promise.all([childChooser, a.view.webContents.debugger.sendCommand("Runtime.evaluate", {
        expression: 'document.querySelector("input").click()', userGesture: true,
      }, chooserSession)]);
      const selected = await a.view.webContents.debugger.sendCommand("Runtime.evaluate", {
        expression: 'document.querySelector("input").files.length', returnByValue: true,
      }, chooserSession);
      assert.equal(selected.result.value, 0);
      process.stdout.write("PASS child-session chooser interception installed before debugger resume\n");
      process.stdout.write("PASS separate-process child and owner-scoped CDP descendant routing\n");
    }
    stage = "child frame ownership";
    const handles = issueFrameHandles("a", a.view.webContents.id);
    assert.equal(handles.length, 2);
    assert.deepEqual(await Promise.all(handles.map(handle => frameTitle("a", handle))),
      ["Same-origin child", "Cross-origin child"]);
    for (const handle of handles) await assert.rejects(frameTitle("b", handle), /Denied/);
    await assert.rejects(frameTitle("a", randomUUID()), /Denied/);
    assert.equal(await a.view.webContents.executeJavaScript(`(() => {
      try { return document.querySelectorAll('iframe')[1].contentWindow.document.title; }
      catch (error) { return error.name; }
    })()`), "SecurityError");
    stage = "removed frame fencing";
    await a.view.webContents.executeJavaScript("document.querySelector('iframe').remove()");
    await assert.rejects(frameTitle("a", handles[0]), /Denied/);
    stage = "navigated frame fencing";
    await a.view.webContents.executeJavaScript(`new Promise(resolve => {
      const frame = document.querySelector('iframe');
      frame.onload = () => resolve(true);
      frame.src = '/child';
    })`);
    await assert.rejects(frameTitle("a", handles[1]), /Denied/);
    for (const check of staleChildChecks) await assert.rejects(check(), /Denied/);
    const refreshed = issueFrameHandles("a", a.view.webContents.id);
    assert.equal(await frameTitle("a", refreshed[0]), "Same-origin child");
    stage = "renderer isolation";
    const capabilities = await a.view.webContents.executeJavaScript('({ require: typeof require, process: typeof process, bridge: typeof window.electron })');
    assert.deepEqual(capabilities, { require: "undefined", process: "undefined", bridge: "undefined" });
    await a.view.webContents.session.cookies.set({ url, name: "owned", value: "a" });
    assert.equal((await b.view.webContents.session.cookies.get({ url })).length, 0);
    stage = "popup denial";
    assert.equal(await a.view.webContents.executeJavaScript(`window.open(${JSON.stringify(url)}) === null`), true);
    stage = "file chooser interception";
    let timer;
    const chooser = new Promise((resolve, reject) => {
      const listener = (_event, method, params) => {
        if (method !== "Page.fileChooserOpened") return;
        clearTimeout(timer);
        a.view.webContents.debugger.removeListener("message", listener);
        resolve(params);
      };
      a.view.webContents.debugger.on("message", listener);
      timer = setTimeout(() => {
        a.view.webContents.debugger.removeListener("message", listener);
        reject(new Error("Chooser timeout"));
      }, 3000);
    });
    await Promise.all([chooser, a.view.webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: 'document.querySelector("input").click()', userGesture: true,
    })]);
    assert.equal(await a.view.webContents.executeJavaScript('document.querySelector("input").files.length'), 0);
    stage = "detach fencing";
    a.view.webContents.debugger.detach();
    await assert.rejects(title("a", a.view.webContents.id), /Denied/);
    await assert.rejects(frameTitle("a", handles[1]), /Denied/);
    await assert.rejects(frameTitle("a", refreshed[0]), /Denied/);
    assert.equal(a.view.getVisible(), false);
    assert.equal(await title("b", b.view.webContents.id), "Owned fixture");
    process.stdout.write(`PASS embedded ownership, same/cross-origin frame ownership, removed-frame fencing, cookie/renderer isolation, popup denial, file chooser interception and debugger-loss fencing; Electron ${process.versions.electron}\n`);
    result = 0;
  } catch {
    process.stderr.write(`FAIL embedded probe: ${stage}\n`);
  } finally {
    for (const view of views) if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close();
    window?.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    if (childServer) await new Promise(resolve => childServer.close(resolve));
    app.exit(result);
  }
}
void main();
