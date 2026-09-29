import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fetch, ProxyAgent } from 'undici';
import { startMcpAdapter } from '../../packages/browser-client/src/mcp-adapter.mjs';
import { readInstalledDescriptor } from '../../packages/browser-client/src/launch-config.mjs';

let stage = 'descriptor';
async function main() {
  if (process.argv.length !== 2) throw new Error('Arguments forbidden');
  const descriptor = await readInstalledDescriptor();
  stage = 'connection';
  const adapter = await startMcpAdapter({
    sdk: { Client, StreamableHTTPClientTransport, Server, StdioServerTransport,
      CallToolRequestSchema, ListToolsRequestSchema },
    networking: { fetch, ProxyAgent },
    descriptor, env: process.env,
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 5000);
    void adapter.close().then(() => { clearTimeout(deadline); process.exitCode = 0; },
      () => { clearTimeout(deadline); process.exitCode = 1; });
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, stop);
}
main().catch(() => {
  // Never emit credential-bearing HTTP errors or corrupt the MCP stdout stream.
  process.stderr.write(`openrind-browser: client startup failed (${stage})\n`);
  process.exitCode = 1;
});
