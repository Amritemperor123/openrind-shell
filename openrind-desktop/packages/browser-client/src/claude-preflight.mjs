import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { browserCredentials, mergeManagedServer, readInstalledDescriptor } from './launch-config.mjs';

async function readConfig(path) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Unsafe Claude configuration');
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1024 * 1024) throw new Error('Claude configuration is too large');
    const config = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid Claude configuration');
    return config;
  } finally { await file.close(); }
}

// Read-only preflight: Claude merges the fixed --mcp-config entry itself. User
// JSON is never rewritten, so concurrent Claude preference writes are preserved.
export async function preflightClaudeBrowser({ env = process.env, cwd = process.cwd() } = {}) {
  await readInstalledDescriptor();
  browserCredentials(env);
  if (env.CLAUDE_CONFIG_DIR && resolve(env.CLAUDE_CONFIG_DIR) !== join(env.HOME, '.claude')) {
    throw new Error('Custom Claude configuration requires explicit browser integration');
  }
  const global = await readConfig(join(env.HOME, '.claude.json')) ?? {};
  const scopes = [global];
  const project = global.projects?.[resolve(cwd)];
  if (project) {
    scopes.push(project);
    if (project.disabledMcpServers?.includes('openrind-browser')) throw new Error('The browser MCP server is disabled');
  }
  let directory = resolve(cwd);
  for (;;) {
    const config = await readConfig(join(directory, '.mcp.json'));
    if (config) scopes.push(config);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  // Enterprise-managed MCP replaces ordinary sources. Do not silently launch
  // without the browser server or alter administrator-owned configuration.
  const managed = await readConfig('/etc/claude-code/managed-mcp.json');
  if (managed) {
    if (!Object.hasOwn(managed.mcpServers ?? {}, 'openrind-browser')) {
      throw new Error('Managed Claude MCP configuration must include openrind-browser');
    }
    scopes.push(managed);
  }
  mergeManagedServer({}, scopes);
}
