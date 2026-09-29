import { BrowserFault, failure } from '@openrind/browser-contract';
import { clientToolDefinitions, routeClientRequest } from './index.mjs';
import { browserCredentials, validateDescriptor } from './launch-config.mjs';

const READ_TOOLS = new Set(['browser_capabilities', 'browser_status', 'browser_tabs', 'browser_snapshot', 'browser_downloads']);
const errorResult = error => {
  const result = failure(error);
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
};

// The bundled entrypoint supplies the pinned MCP SDK and Undici constructors.
// Dependency injection also lets transport fixtures exercise this production code.
// No caller-supplied fetch or endpoint is accepted through the MCP tool surface.
export async function startMcpAdapter({ sdk, networking, descriptor, env, localTransfers }) {
  const fixed = validateDescriptor(descriptor);
  const headers = browserCredentials(env);
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!proxy) throw new Error('The browser client requires the OpenShell proxy');
  let proxyUrl;
  try { proxyUrl = new URL(proxy); } catch { throw new Error('Invalid OpenShell proxy'); }
  if (!['http:', 'https:'].includes(proxyUrl.protocol) || proxyUrl.username || proxyUrl.password ||
      proxyUrl.search || proxyUrl.hash || proxyUrl.pathname !== '/') throw new Error('Invalid OpenShell proxy');
  const dispatcher = new networking.ProxyAgent(proxyUrl.href);
  const remote = new sdk.Client({ name: 'openrind-browser-client', version: '0.0.0' });
  const server = new sdk.Server({ name: 'openrind-browser', version: '0.0.0' }, { capabilities: { tools: {} } });
  const transport = new sdk.StreamableHTTPClientTransport(new URL(fixed.endpoint), {
    requestInit: { headers },
    fetch: (url, init) => {
      // SDK requests must remain on the provisioned endpoint, including DELETE.
      if (new URL(url).href !== fixed.endpoint) throw new Error('Browser endpoint mismatch');
      return networking.fetch(url, { ...init, dispatcher, redirect: 'error' });
    },
    reconnectionOptions: { maxRetries: 0 },
  });
  let closed = false;
  let closing;
  const close = () => closing ??= (async () => {
    closed = true;
    // The HTTP dispatcher is destroyed even when session deletion fails.
    // Grant revocation and expiry remain service-side cleanup authorities.
    let timer;
    try {
      await Promise.race([transport.terminateSession(), new Promise(resolve => {
        timer = setTimeout(resolve, 2000);
      })]);
    } catch { /* no action replay */ }
    finally { clearTimeout(timer); await dispatcher.destroy(); }
    try { await remote.close(); } catch { /* continue cleanup */ }
    try { await server.close(); } catch { /* continue cleanup */ }
  })();
  server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({ tools: clientToolDefinitions() }));
  server.setRequestHandler(sdk.CallToolRequestSchema, async (request, extra) => {
    if (closed) return errorResult(new BrowserFault('BACKEND_UNAVAILABLE'));
    try {
      return await routeClientRequest(request.params.name, request.params.arguments, {
        localTransfers,
        remote: async (name, args) => {
          if (extra.signal.aborted) throw new BrowserFault('CANCELLED');
          try {
            return await remote.callTool({ name, arguments: args }, undefined, {
              signal: extra.signal,
              timeout: name === 'browser_start' ? 60_000 : 30_000,
              resetTimeoutOnProgress: false,
              onprogress: progress => {
                const token = request.params._meta?.progressToken;
                if (token !== undefined) void server.notification({ method: 'notifications/progress',
                  params: { ...progress, progressToken: token } }).catch(() => {});
              },
            });
          } catch {
            // A lost response or cancellation after dispatch cannot establish
            // whether an effect occurred. Never classify it as safe to replay.
            const readOnly = READ_TOOLS.has(name) && (name !== 'browser_tabs' || args.action === 'list');
            throw new BrowserFault(readOnly ? 'BACKEND_UNAVAILABLE' : 'OUTCOME_UNKNOWN',
              readOnly ? 'not-started' : 'unknown');
          }
        },
      });
    } catch (error) { return errorResult(error); }
  });
  server.onclose = () => { void close(); };
  try {
    await remote.connect(transport);
    await server.connect(new sdk.StdioServerTransport());
    return { close };
  } catch {
    await close();
    throw new Error('Browser MCP connection failed');
  }
}
