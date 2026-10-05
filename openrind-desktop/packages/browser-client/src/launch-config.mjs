import { constants, existsSync, readFileSync } from 'node:fs';
import { open, lstat } from 'node:fs/promises';

export const CLIENT_COMMAND = '/usr/local/bin/openrind-browser-client';
export const DESCRIPTOR_PATH = '/etc/openrind-browser/descriptor.json';
const MAX_CONFIG_BYTES = 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// These inputs come from trusted provisioning, never MCP arguments or renderer IPC.
export function validateDescriptor(value) {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'endpoint,protocol,requireProxy' ||
      value.protocol !== 1 || value.requireProxy !== true || typeof value.endpoint !== 'string' ||
      value.endpoint.length > 2048) throw new Error('Invalid browser endpoint descriptor');
  let url;
  try { url = new URL(value.endpoint); } catch { throw new Error('Invalid browser endpoint descriptor'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/mcp' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'host.openshell.internal'))) {
    throw new Error('Invalid browser endpoint descriptor');
  }
  return Object.freeze({ protocol: 1, endpoint: url.href, requireProxy: true });
}

export async function readInstalledDescriptor() {
  // Root-owned, non-writable ancestors prevent sandbox users replacing the
  // descriptor path between these checks and the final O_NOFOLLOW open.
  for (const directory of ['/', '/etc', '/etc/openrind-browser']) {
    // Metadata checks do not request directory-listing access to '/', which
    // the sandbox correctly denies. Each ancestor is non-writable by the agent.
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) {
      throw new Error('Unsafe browser descriptor directory');
    }
  }
  // O_NOFOLLOW and fstat bind checks to the opened inode.
  const file = await open(DESCRIPTOR_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) || stat.size > 8192) {
      throw new Error('Unsafe browser endpoint descriptor');
    }
    const bytes = Buffer.alloc(8193);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 8192) throw new Error('Invalid browser endpoint descriptor');
    return validateDescriptor(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
  } finally { await file.close(); }
}

export function browserCredentials(env) {
  let serviceToken = env.OPENRIND_BROWSER_SERVICE_TOKEN;
  if (!serviceToken && existsSync('/etc/openrind-browser/service-token')) {
    try { serviceToken = readFileSync('/etc/openrind-browser/service-token', 'utf8').trim(); } catch {}
  }
  if (!serviceToken && existsSync('/var/lib/openrind-shell/runtime/browser.env')) {
    try {
      const content = readFileSync('/var/lib/openrind-shell/runtime/browser.env', 'utf8');
      for (const line of content.split('\n')) {
        if (line.includes('OPENRIND_BROWSER_SERVICE_TOKEN=')) {
          serviceToken = line.split('=')[1].replace(/['"\r\n]/g, '').trim();
        }
      }
    } catch {}
  }
  let grant = env.OPENRIND_BROWSER_GRANT;
  if (!grant && existsSync('/var/lib/openrind-shell/runtime/browser-grant')) {
    try { grant = readFileSync('/var/lib/openrind-shell/runtime/browser-grant', 'utf8').trim(); } catch {}
  }
  if (!grant && existsSync('/var/lib/openrind-shell/runtime/browser.env')) {
    try {
      const content = readFileSync('/var/lib/openrind-shell/runtime/browser.env', 'utf8');
      for (const line of content.split('\n')) {
        if (line.includes('OPENRIND_BROWSER_GRANT=')) {
          grant = line.split('=')[1].replace(/['"\r\n]/g, '').trim();
        }
      }
    } catch {}
  }
  // Reject whitespace/control characters before credentials can become headers.
  if (typeof serviceToken !== 'string' || !/^[\x21-\x7e]{16,8192}$/.test(serviceToken) ||
      typeof grant !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(grant)) {
    throw new Error('Browser credentials are missing or invalid');
  }
  return Object.freeze({ authorization: `Bearer ${serviceToken}`, 'x-openrind-browser-grant': grant });
}

export const managedServer = () => ({ type: 'stdio', command: CLIENT_COMMAND, args: [] });

// Pure merge: the caller owns reading all applicable scopes and atomic persistence.
// Never embed credentials, endpoint URLs, Node flags or an editable script path.
export function mergeManagedServer(config, additionalScopes = []) {
  if (!object(config) || !Array.isArray(additionalScopes)) throw new Error('Invalid Claude MCP configuration');
  const scopes = [config, ...additionalScopes];
  for (const scope of scopes) {
    if (!object(scope) || (scope.mcpServers !== undefined && !object(scope.mcpServers))) {
      throw new Error('Invalid Claude MCP configuration');
    }
    const existing = scope.mcpServers?.['openrind-browser'];
    if (existing !== undefined && (!object(existing) ||
        Object.keys(existing).sort().join(',') !== 'args,command,type' ||
        existing.type !== 'stdio' || existing.command !== CLIENT_COMMAND ||
        !Array.isArray(existing.args) || existing.args.length !== 0)) {
      throw new Error('Conflicting openrind-browser MCP configuration');
    }
  }
  const merged = { ...config, mcpServers: { ...config.mcpServers, 'openrind-browser': managedServer() } };
  if (Buffer.byteLength(JSON.stringify(merged)) > MAX_CONFIG_BYTES) throw new Error('Claude MCP configuration is too large');
  return merged;
}
