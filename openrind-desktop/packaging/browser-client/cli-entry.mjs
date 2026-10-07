import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { readInstalledDescriptor, browserCredentials, validateDescriptor } from '../../packages/browser-client/src/launch-config.mjs';

const STATE_FILE = '/tmp/browser-session.json';

function readSession() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveSession(data) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

async function getClient() {
  const descriptor = await readInstalledDescriptor();
  const fixed = validateDescriptor(descriptor);
  const headers = browserCredentials(process.env);
  const proxy = process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY || process.env.https_proxy || 'http://10.200.0.1:3128';
  const proxyUrl = new URL(proxy);
  const dispatcher = new ProxyAgent({ uri: proxyUrl.href, proxyTunnel: false });
  const client = new Client({ name: 'openrind-browser-cli', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(fixed.endpoint), {
    requestInit: { headers },
    fetch: (url, init) => undiciFetch(url, { ...init, dispatcher, redirect: 'error' }),
    reconnectionOptions: { maxRetries: 0 },
  });
  await client.connect(transport);
  return { client, transport, dispatcher };
}

function formatSnapshotNodes(nodes, indent = 0) {
  const lines = [];
  const pad = '  '.repeat(indent);
  for (const node of (nodes || [])) {
    if (node.kind === 'element') {
      const parts = [node.role || 'element'];
      if (node.name) parts.push(`"${node.name}"`);
      const ref = node.ref || node.handle;
      if (ref) parts.push(`[ref: ${ref}]`);
      if (node.bounds) parts.push(`(bounds: x=${node.bounds.x}, y=${node.bounds.y}, w=${node.bounds.width}, h=${node.bounds.height})`);
      if (node.center) parts.push(`[center: (${node.center[0]}, ${node.center[1]})]`);
      if (node.hitTestable) parts.push('[hit-testable]');
      if (node.inViewport) parts.push('[in-viewport]');
      if (node.checked) parts.push('(checked)');
      if (node.disabled) parts.push('(disabled)');
      lines.push(`${pad}- ${parts.join(' ')}`);
      if (node.children?.length) {
        lines.push(formatSnapshotNodes(node.children, indent + 1));
      }
    } else if (node.kind === 'text') {
      const text = (node.text || '').trim();
      if (text) lines.push(`${pad}"${text}"`);
    }
  }
  return lines.filter(Boolean).join('\n');
}

async function main() {
  const binName = path.basename(process.env.OPENRIND_BROWSER_BIN || process.argv[1] || 'browser');
  let cmd = process.argv[2];
  let shift = 3;

  if (binName === 'snapshot') {
    cmd = 'snapshot';
    shift = 2;
  } else if (binName === 'agent-browser' || binName === 'agent_browser') {
    cmd = process.argv[2];
    shift = 3;
  } else if (['start', 'navigate', 'click', 'fill', 'close', 'status', 'tabs', 'open', 'type', 'press', 'screenshot', 'scroll'].includes(binName)) {
    cmd = binName;
    shift = 2;
  } else if (binName.startsWith('browser_')) {
    cmd = binName.slice('browser_'.length);
    shift = 2;
  } else if (cmd && cmd.startsWith('browser_')) {
    cmd = cmd.slice('browser_'.length);
    shift = 3;
  }

  cmd = (cmd || 'help').toLowerCase();

  // If the first argument is a URL or domain, automatically treat it as start / open
  if (cmd.startsWith('http://') || cmd.startsWith('https://') || cmd.startsWith('www.') || (cmd.includes('.') && !cmd.startsWith('-'))) {
    const targetUrl = process.argv[2];
    cmd = 'start';
    shift = 2;
    process.argv[2] = targetUrl;
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`
Openrind Browser CLI

Usage:
  browser start [url] [provider]   Start browser (default provider: desktop-webview)
  browser navigate <url>           Navigate to URL
  browser snapshot                 Print semantic DOM tree with element refs
  browser click <ref>              Click an element (e.g. h_1)
  browser fill <ref> <text>        Type text into input
  browser close                    Close the browser session
  browser status                   Show current session status
    `);
    process.exit(0);
  }

  const { client, transport, dispatcher } = await getClient();

  try {
    if (cmd === 'start' || cmd === 'open') {
      let rawUrl = process.argv[shift];
      let url = undefined;
      if (rawUrl && rawUrl !== 'about:blank') {
        url = rawUrl.startsWith('http://') || rawUrl.startsWith('https://') ? rawUrl : `https://${rawUrl}`;
      }
      const provider = process.argv[shift + 1] || 'desktop-webview';
      const operationId = `op_${randomBytes(8).toString('hex')}`;
      const startArgs = { provider, operationId };
      if (url) startArgs.url = url;
      const res = await client.callTool({
        name: 'browser_start',
        arguments: startArgs,
      });
      const structured = res.structuredContent || JSON.parse(res.content?.[0]?.text || '{}');
      if (structured.ok === false) {
        console.error('Failed to start browser:', structured.message || structured.code);
        process.exit(1);
      }
      const data = structured.data || structured;
      const sessionId = data.sessionId;
      const sessionEpoch = data.sessionEpoch || 1;
      const pageId = data.pageId || data.pages?.[0]?.pageId;
      saveSession({
        sessionId,
        sessionEpoch,
        pageId,
        provider,
        url: url || 'about:blank',
      });
      console.log(`Browser started (${provider})${url ? ` at ${url}` : ''}`);
      console.log(`Session: ${sessionId}, Page: ${pageId}`);
    } else if (cmd === 'navigate') {
      let rawUrl = process.argv[shift];
      if (!rawUrl) { console.error('Usage: browser navigate <url>'); process.exit(1); }
      const url = rawUrl.startsWith('http://') || rawUrl.startsWith('https://') ? rawUrl : `https://${rawUrl}`;
      let session = readSession();
      if (!session) {
        // Auto start if no session exists!
        const operationId = `op_${randomBytes(8).toString('hex')}`;
        const res = await client.callTool({
          name: 'browser_start',
          arguments: { provider: 'desktop-webview', operationId, url },
        });
        const structured = res.structuredContent || JSON.parse(res.content?.[0]?.text || '{}');
        const data = structured.data || structured;
        saveSession({
          sessionId: data.sessionId,
          sessionEpoch: data.sessionEpoch || 1,
          pageId: data.pageId || data.pages?.[0]?.pageId,
          provider: 'desktop-webview',
          url,
        });
        console.log(`Browser started and navigated to ${url}`);
        process.exit(0);
      }
      const operationId = `op_${randomBytes(8).toString('hex')}`;
      const res = await client.callTool({
        name: 'browser_navigate',
        arguments: {
          sessionId: session.sessionId,
          sessionEpoch: session.sessionEpoch,
          pageId: session.pageId,
          operationId,
          url,
        },
      });
      const structured = res.structuredContent || JSON.parse(res.content?.[0]?.text || '{}');
      if (structured.ok === false) {
        // Auto recover on session expiration or loss
        const newOpId = `op_${randomBytes(8).toString('hex')}`;
        const startRes = await client.callTool({
          name: 'browser_start',
          arguments: { provider: session.provider || 'local-chromium', operationId: newOpId, url },
        });
        const startStruct = startRes.structuredContent || JSON.parse(startRes.content?.[0]?.text || '{}');
        const startData = startStruct.data || startStruct;
        if (startStruct.ok !== false) {
          saveSession({
            sessionId: startData.sessionId,
            sessionEpoch: startData.sessionEpoch || 1,
            pageId: startData.pageId || startData.pages?.[0]?.pageId,
            provider: session.provider || 'local-chromium',
            url,
          });
          console.log(`Recovered session and navigated to ${url}`);
          process.exit(0);
        }
      }
      if (structured.sessionEpoch) session.sessionEpoch = structured.sessionEpoch;
      session.url = url;
      saveSession(session);
      console.log(`Navigated to ${url}`);
    } else if (cmd === 'snapshot') {
      const session = readSession();
      if (!session) { console.error('No active browser session. Run "browser start <url>" first.'); process.exit(1); }
      const res = await client.callTool({
        name: 'browser_snapshot',
        arguments: {
          sessionId: session.sessionId,
          sessionEpoch: session.sessionEpoch,
          pageId: session.pageId,
        },
      });
      const structured = res.structuredContent || JSON.parse(res.content?.[0]?.text || '{}');
      if (structured.ok === false) {
        // Auto recover on session expiration or loss
        const newOpId = `op_${randomBytes(8).toString('hex')}`;
        const startRes = await client.callTool({
          name: 'browser_start',
          arguments: { provider: session.provider || 'local-chromium', operationId: newOpId, ...(session.url && session.url !== 'about:blank' ? { url: session.url } : {}) },
        });
        const startStruct = startRes.structuredContent || JSON.parse(startRes.content?.[0]?.text || '{}');
        const startData = startStruct.data || startStruct;
        if (startStruct.ok !== false) {
          const newSession = {
            sessionId: startData.sessionId,
            sessionEpoch: startData.sessionEpoch || 1,
            pageId: startData.pageId || startData.pages?.[0]?.pageId,
            provider: session.provider || 'local-chromium',
            url: session.url,
          };
          saveSession(newSession);
          const retryRes = await client.callTool({
            name: 'browser_snapshot',
            arguments: { sessionId: newSession.sessionId, sessionEpoch: newSession.sessionEpoch, pageId: newSession.pageId },
          });
          const retryStruct = retryRes.structuredContent || JSON.parse(retryRes.content?.[0]?.text || '{}');
          const retryData = retryStruct.data || retryStruct;
          if (retryData.summary) {
            console.log(retryData.summary);
          } else {
            const textOutput = formatSnapshotNodes(retryData.nodes || []);
            console.log(textOutput || 'Empty page snapshot');
          }
          process.exit(0);
        }
        console.error('Snapshot failed:', structured.message || structured.code);
        process.exit(1);
      }
      const data = structured.data || structured;
      if (data.summary) {
        console.log(data.summary);
      } else {
        const nodes = data.nodes || [];
        const textOutput = formatSnapshotNodes(nodes);
        console.log(textOutput || 'Empty page snapshot');
      }
    } else if (cmd === 'click') {
      const ref = process.argv[shift];
      if (!ref) { console.error('Usage: browser click <ref>'); process.exit(1); }
      const session = readSession();
      if (!session) { console.error('No active browser session. Run "browser start <url>" first.'); process.exit(1); }
      const operationId = `op_${randomBytes(8).toString('hex')}`;
      const res = await client.callTool({
        name: 'browser_click',
        arguments: {
          sessionId: session.sessionId,
          sessionEpoch: session.sessionEpoch,
          pageId: session.pageId,
          operationId,
          ref,
        },
      });
      console.log(`Clicked element [${ref}]`);
    } else if (cmd === 'fill' || cmd === 'type') {
      const ref = process.argv[shift];
      const text = process.argv.slice(shift + 1).join(' ');
      if (!ref || !text) { console.error('Usage: browser fill <ref> <text>'); process.exit(1); }
      const session = readSession();
      if (!session) { console.error('No active browser session. Run "browser start <url>" first.'); process.exit(1); }
      const operationId = `op_${randomBytes(8).toString('hex')}`;
      const res = await client.callTool({
        name: 'browser_fill',
        arguments: {
          sessionId: session.sessionId,
          sessionEpoch: session.sessionEpoch,
          pageId: session.pageId,
          operationId,
          ref,
          text,
        },
      });
      console.log(`Typed into [${ref}]: "${text}"`);
    } else if (cmd === 'press' || cmd === 'key' || cmd === 'submit') {
      let key = process.argv[shift] || 'Enter';
      let ref = undefined;
      if (process.argv[shift] && (process.argv[shift].startsWith('@') || process.argv[shift].startsWith('e') || process.argv[shift].startsWith('br_') || process.argv[shift].startsWith('h_'))) {
        ref = process.argv[shift];
        key = process.argv[shift + 1] || 'Enter';
      }
      const session = readSession();
      if (!session) { console.error('No active browser session.'); process.exit(1); }
      const operationId = `op_${randomBytes(8).toString('hex')}`;
      const args = {
        sessionId: session.sessionId,
        sessionEpoch: session.sessionEpoch,
        pageId: session.pageId,
        operationId,
        key,
      };
      if (ref) args.ref = ref;
      await client.callTool({
        name: 'browser_press',
        arguments: args,
      });
      console.log(`Pressed key: ${key}${ref ? ` on [${ref}]` : ''}`);
    } else if (cmd === 'scroll') {
      let direction = process.argv[shift] || 'down';
      let distance = parseInt(process.argv[shift + 1] || '800', 10);
      if (isNaN(distance)) distance = 800;
      const session = readSession();
      if (!session) { console.error('No active browser session.'); process.exit(1); }
      const operationId = `op_${randomBytes(8).toString('hex')}`;
      await client.callTool({
        name: 'browser_scroll',
        arguments: {
          sessionId: session.sessionId,
          sessionEpoch: session.sessionEpoch,
          pageId: session.pageId,
          operationId,
          direction,
          distance,
        },
      });
      console.log(`Scrolled ${direction} ${distance}px`);
    } else if (cmd === 'screenshot') {
      const session = readSession();
      if (!session) { console.error('No active browser session.'); process.exit(1); }
      const operationId = `op_${randomBytes(8).toString('hex')}`;
      const res = await client.callTool({
        name: 'browser_screenshot',
        arguments: {
          sessionId: session.sessionId,
          sessionEpoch: session.sessionEpoch,
          pageId: session.pageId,
          operationId,
        },
      });
      const structured = res.structuredContent || JSON.parse(res.content?.[0]?.text || '{}');
      console.log(`Screenshot captured: ${structured.artifactId || 'success'}`);
    } else if (cmd === 'close') {
      const session = readSession();
      if (session) {
        const operationId = `op_${randomBytes(8).toString('hex')}`;
        await client.callTool({
          name: 'browser_close',
          arguments: {
            sessionId: session.sessionId,
            operationId,
          },
        }).catch(() => {});
        try { fs.unlinkSync(STATE_FILE); } catch {}
      }
      console.log('Browser session closed.');
    } else if (cmd === 'status') {
      const session = readSession();
      if (!session) {
        console.log('No active browser session.');
      } else {
        console.log(`Session: ${session.sessionId}`);
        console.log(`URL: ${session.url}`);
        console.log(`Provider: ${session.provider}`);
      }
    } else {
      console.error(`Unknown command: ${cmd}. Run "browser help" for usage.`);
      process.exit(1);
    }
  } finally {
    try { await transport.terminateSession(); } catch {}
    try { await client.close(); } catch {}
    try { await dispatcher.destroy(); } catch {}
  }
}

main().catch(err => {
  console.error('Browser error:', err.message || err);
  process.exit(1);
});
