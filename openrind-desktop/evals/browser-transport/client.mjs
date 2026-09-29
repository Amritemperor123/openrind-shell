import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ProxyAgent, fetch as proxyFetch } from "undici";
import { descriptor, inputSchema, TOOL, toolDefinition } from "./contract.mjs";

export async function connectRemote(config, token, { env = process.env, fetch: fetchOverride } = {}) {
  config = descriptor(config);
  if (!token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error("Missing browser service credential");
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (config.requireProxy && !proxy) throw new Error("OpenShell proxy is required");
  // Explicit ProxyAgent ignores NO_PROXY: the experiment must not bypass OpenShell.
  const dispatcher = config.requireProxy ? new ProxyAgent(proxy) : undefined;
  const fetcher = fetchOverride ?? (dispatcher
    ? (url, init) => proxyFetch(url, { ...init, dispatcher }) : globalThis.fetch);
  const transport = new StreamableHTTPClientTransport(new URL(config.endpoint), {
    requestInit: { headers: { authorization: `Bearer ${token}` }, redirect: "error" },
    fetch: fetcher,
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 100,
      maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
  });
  const client = new Client({ name: "openrind-fixed-transport-probe", version: "0.0.1" });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // Teardown is bounded even if the service disappeared.
    const timer = setTimeout(() => { void client.close(); }, 1500);
    try { await transport.terminateSession(); } catch { /* No raw auth/endpoint diagnostics. */ }
    finally { clearTimeout(timer); await client.close(); await dispatcher?.destroy(); }
  };
  try { await client.connect(transport, { timeout: 5000 }); }
  catch (cause) { await client.close(); await dispatcher?.destroy(); throw new Error("Browser fixture connection failed", { cause }); }
  return { client, transport, close };
}

export async function startAdapter(config, token, options = {}) {
  const remote = await connectRemote(config, token, options);
  const local = new Server({ name: "openrind-browser-transport-spike", version: "0.0.1" },
    { capabilities: { tools: {} } });
  local.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [toolDefinition] }));
  local.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const parsed = inputSchema.safeParse(request.params.arguments ?? {});
    if (request.params.name !== TOOL || !parsed.success) {
      return { isError: true, content: [{ type: "text", text: "Invalid fixture tool request" }] };
    }
    try {
      return await remote.client.callTool({ name: TOOL, arguments: parsed.data }, undefined, {
        signal: extra.signal, timeout: 10_000,
        onprogress: request.params._meta?.progressToken === undefined ? undefined : (progress) => {
          void extra.sendNotification({ method: "notifications/progress", params: {
            ...progress, progressToken: request.params._meta.progressToken,
          } }).catch(() => {});
        },
      });
    } catch {
      return { isError: true, content: [{ type: "text", text:
        "Transport interrupted; outcome unknown. The request was not replayed." }] };
    }
  });
  let closing;
  const close = () => closing ??= (async () => { await remote.close(); await local.close(); })();
  local.onclose = () => { void close(); };
  await local.connect(new StdioServerTransport());
  return { close };
}

export async function fixedMain() {
  // Native launcher supplies no path/URL arguments. Root-owned image descriptor.
  const config = JSON.parse(await readFile("/etc/openrind-browser-spike.json", "utf8"));
  const adapter = await startAdapter(config, process.env.OPENRIND_BROWSER_SERVICE_TOKEN);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.once(signal, () => { void adapter.close(); });
  }
  process.stdin.once("end", () => { void adapter.close(); });
}
