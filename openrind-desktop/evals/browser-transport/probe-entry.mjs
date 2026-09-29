import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOL } from "./contract.mjs";

async function probe(command, args = [], positive = false) {
  const transport = new StdioClientTransport({ command, args, env: process.env, stderr: "pipe" });
  transport.stderr?.on("data", (data) => {
    for (const line of data.toString().split("\n")) {
      if (/^(openrind-browser-spike: startup failed|diagnostic class: [A-Za-z0-9_]{1,60})$/.test(line)) {
        process.stderr.write(line + "\n");
      }
    }
  });
  const client = new Client({ name: "openrind-sandbox-transport-check", version: "0.0.1" });
  try {
    await client.connect(transport, { timeout: 8000 });
    assert.equal((await client.listTools()).tools[0].name, TOOL);
    const result = await client.callTool({ name: TOOL, arguments: { nonce: "sandbox-proof" } });
    assert.equal(result.structuredContent.nonce, "sandbox-proof");
    if (positive) {
      const controller = new AbortController();
      let notified;
      const started = new Promise((resolve) => { notified = resolve; });
      const pending = client.callTool({ name: TOOL, arguments: { nonce: "live-cancel", delayMs: 5000 } },
        undefined, { signal: controller.signal, onprogress: () => notified() });
      const rejected = assert.rejects(pending);
      const timer = setTimeout(() => notified(), 1500);
      await started;
      clearTimeout(timer);
      controller.abort();
      await rejected;
      // A subsequent request proves cancellation did not poison the MCP session.
      const after = await client.callTool({ name: TOOL, arguments: { nonce: "after-cancel" } });
      assert.equal(after.structuredContent.nonce, "after-cancel");
    }
  } finally { await client.close(); }
}

async function main() {
  process.stdout.write(JSON.stringify({ credentialPresent: !!process.env.OPENRIND_BROWSER_SERVICE_TOKEN,
    proxyPresent: !!(process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy) }) + "\n");
  if (process.argv.includes('--negative')) {
    if (process.argv.includes('--direct')) {
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[key];
    }
    await assert.rejects(probe('/usr/local/bin/openrind-browser-spike'));
    process.stdout.write('PASS fixed client rejected negative transport configuration\n');
    return;
  }
  await probe("/usr/local/bin/openrind-browser-spike", [], true);
  process.stdout.write("PASS fixed native client discovery and call through OpenShell\n");
  await assert.rejects(probe("/usr/bin/node", ["/opt/openrind-browser-spike/client.cjs"]));
  process.stdout.write("PASS shared Node executable cannot use the browser route\n");
  const output = execFileSync("/usr/local/bin/claude-real", ["mcp", "list"], {
    encoding: "utf8", timeout: 25_000,
    env: { ...process.env, HOME: "/sandbox/browser-probe-home", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!/openrind-browser.*Connected/is.test(output)) throw new Error("Claude MCP discovery failed");
  process.stdout.write("PASS actual claude-real reports managed MCP connected (no inference call)\n");
}
main().catch(() => {
  process.stderr.write("FAIL browser transport live probe; inspect redacted runtime diagnostics\n");
  process.exitCode = 1;
});
