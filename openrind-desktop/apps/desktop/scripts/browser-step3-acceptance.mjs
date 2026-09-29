// Run with the Desktop Electron binary. Uses the saved encrypted credentials;
// never prints secrets or substitutes an inference/FUSE fixture.
import { app } from 'electron';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appendFile, mkdir } from 'node:fs/promises';

const output = new URL('../../../packaging/browser-client/dist/desktop-acceptance.log', import.meta.url);
await mkdir(new URL('.', output), { recursive: true });
const report = async text => { console.log(text); await appendFile(output, `${text}\n`); };
process.env.OPENSHELL_BIN ||= '/opt/openrind-desktop/fuse-runtime/openshell';
process.env.OPENSHELL_GATEWAY_ENDPOINT ||= 'http://127.0.0.1:18770';
process.env.OPENRIND_DESKTOP_SANDBOX_IMAGE ||= 'openrind-shell-fuse:browser-step3';
await app.whenReady();
const shell = await import('../electron/openshell/openrind-shell.mjs');
const { createDesktopBrowserController } = await import('../electron/openshell/browser-desktop.mjs');
const name = `bs3-${randomBytes(5).toString('hex')}`;
let controller;
let phase = 'provision';
let code = 1;
try {
  await report(`START ${name}`);
  await shell.createOpenrindShellSandbox({ name, workspaceId: name, profile: 'openrind-shell-claude',
    onProgress: event => { console.log(`PROVISION ${event.phase}`); } });
  await report('PASS managed FUSE sandbox provisioning');
  phase = 'browser-prepare';
  controller = createDesktopBrowserController({
    resourcesPath: fileURLToPath(new URL('../../../packaging/browser-client/', import.meta.url)),
    userDataPath: fileURLToPath(new URL(`../../../packaging/browser-client/dist/${name}/`, import.meta.url)),
  });
  const lease = await controller.prepare({ sandboxName: name, conversationId: randomBytes(16).toString('hex') });
  lease.activate();
  await report('PASS trusted browser provider, effective policy and descriptor provisioning');
  await lease.stop();
  code = 0;
} catch (error) {
  // Error strings can include subprocess stderr or service responses. Emit only
  // a redacted classification; inspect the failing stage separately if needed.
  const text = String(error?.message ?? '');
  const category = /credential|key|decrypt|encryption/i.test(text) ? 'credential-unavailable'
    : /haloop/i.test(text) ? 'haloop-unavailable'
    : /policy/i.test(text) ? 'policy-rejected'
    : /image/i.test(text) ? 'image-unavailable'
    : /database|postgres/i.test(text) ? 'database-unavailable' : 'runtime-failed';
  await report(`FAIL ${phase}: ${category}`);
} finally {
  await controller?.close().catch(() => report('FAIL browser cleanup'));
  await shell.deleteOpenrindShellSandbox(name).catch(() => {});
  app.exit(code);
}
