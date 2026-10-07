import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

// Trusted host provisioning only. Never accept endpoint, IP or identity choices
// from tool arguments or renderer-supplied browser requests.
export function browserBinding({ endpoint, bridgeAddress, bindingId }) {
  if (!/^[a-zA-Z0-9_-]{3,128}$/.test(bindingId)) throw new Error('Invalid browser binding identity');
  const url = new URL(endpoint);
  if (url.hostname !== 'host.openshell.internal' || !['http:', 'https:'].includes(url.protocol) ||
      url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash ||
      isIP(bridgeAddress) !== 4 || !/^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(bridgeAddress)) {
    throw new Error('Browser Desktop binding requires its private bridge endpoint');
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid browser endpoint port');
  const name = `browser-${createHash('sha256').update(JSON.stringify([bindingId, url.href, bridgeAddress])).digest('hex').slice(0, 24)}`;
  const rules = ['POST', 'GET', 'DELETE'].map(method => ({ allow: { method, path: '/mcp' } }));
  const route = { host: url.hostname, port, ports: [port], protocol: 'rest', tls: url.protocol === 'https:' ? 'terminate' : 'none',
    enforcement: 'enforce', rules };
  return Object.freeze({ name,
    descriptor: { protocol: 1, endpoint: url.href, requireProxy: true },
    profile: { id: name, display_name: 'Openrind browser service', category: 'other',
      credentials: [{ name: 'service_token', env_vars: ['OPENRIND_BROWSER_SERVICE_TOKEN'], required: true,
        auth_style: 'bearer', header_name: 'Authorization' }],
      discovery: { credentials: ['service_token'] }, endpoints: [route],
      binaries: [
        '/usr/local/bin/openrind-browser-client',
        '/usr/bin/node',
        '/usr/local/bin/browser',
        '/usr/local/bin/snapshot',
        '/usr/local/bin/click',
        '/usr/local/bin/fill',
        '/usr/local/bin/press',
        '/usr/local/bin/navigate',
        '/usr/local/bin/agent-browser'
      ] },
    networkPolicy: { name, endpoints: [route], binaries: [
      { path: '/usr/local/bin/openrind-browser-client' },
      { path: '/usr/bin/node' },
      { path: '/usr/local/bin/browser' },
      { path: '/usr/local/bin/snapshot' },
      { path: '/usr/local/bin/click' },
      { path: '/usr/local/bin/fill' },
      { path: '/usr/local/bin/press' },
      { path: '/usr/local/bin/navigate' },
      { path: '/usr/local/bin/agent-browser' }
    ] },
  });
}
