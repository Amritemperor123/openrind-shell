import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { connectRemote } from "./client.mjs";
import { TOOL } from "./contract.mjs";
async function main() {
  const token = readFileSync(0, "utf8").trim();
  const remote = await connectRemote({ protocol: 1,
    endpoint: "http://host.openshell.internal:18789/mcp", requireProxy: false }, token);
  try {
    assert.equal((await remote.client.listTools()).tools[0].name, TOOL);
    const result = await remote.client.callTool({ name: TOOL, arguments: { nonce: "windows-worker" } });
    assert.equal(result.structuredContent.nonce, "windows-worker");
  } finally { await remote.close(); }
  process.stdout.write("PASS Linux MCP client to Windows worker over the WSL binary bridge\n");
}
main().catch(() => { process.stderr.write("Remote bridge check failed\n"); process.exitCode = 1; });
