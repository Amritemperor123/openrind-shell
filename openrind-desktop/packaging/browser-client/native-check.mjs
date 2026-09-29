import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let phase = 'starting';
async function check(command, args, deny = false) {
  const transport = new StdioClientTransport({ command, args, env: process.env, stderr: 'pipe' });
  const client = new Client({ name: 'native-step3-check', version: '1' });
  try {
    phase = deny ? 'negative-connect' : 'native-connect';
    const connected = client.connect(transport, { timeout: 8000 });
    transport.stderr?.on('data', bytes => {
      if (bytes.toString().includes('client startup failed (descriptor)')) process.stderr.write('Client descriptor check failed\n');
      if (bytes.toString().includes('client startup failed (connection)')) process.stderr.write('Client connection failed\n');
    });
    if (deny) { await assert.rejects(connected); return; }
    await connected;
    phase = 'tool-discovery';
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 19);
    phase = 'capabilities';
    const capabilities = await client.callTool({ name: 'browser_capabilities', arguments: {} });
    assert.equal(capabilities.structuredContent.ok, true);
    assert.deepEqual(capabilities.structuredContent.data.providers, []);
  } finally { await client.close(); }
}
async function main() {
  await check('/usr/local/bin/openrind-browser-client', []);
  await check('/usr/bin/node', ['/opt/openrind-browser/client.cjs'], true);
  process.stdout.write('PASS native client discovers 19 tools; shared Node ancestry denied\n');
}
main().catch(() => { process.stderr.write(`Native browser validation failed at ${phase}\n`); process.exitCode = 1; });
