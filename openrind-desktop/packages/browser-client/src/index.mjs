import { LOCAL_TOOLS, parseTool, toolDefinitions, BrowserFault } from '@openrind/browser-contract';
import { createLocalTransfers, assertPathBeneath, verifyNoSymlinkEscape } from './transfers.mjs';

export { createLocalTransfers, assertPathBeneath, verifyNoSymlinkEscape };
export const clientToolDefinitions = () => toolDefinitions({ local: true });
export function validateClientRequest(name, input) { return parseTool(name, input, { local: true }); }
export async function routeClientRequest(name, input, { remote, localTransfers }) {
  const cleanName = String(name ?? '').replace(/^mcp__openrind_browser__/, '');
  const args = validateClientRequest(cleanName, input);
  if (LOCAL_TOOLS.includes(cleanName)) {
    if (!localTransfers) throw new BrowserFault('CAPABILITY_UNAVAILABLE');
    return localTransfers(cleanName, args);
  }
  return remote(cleanName, args);
}
// Approved filesystem transfer adapters remain a later step; no host path is
// forwarded as a remote tool request. The stdio adapter lives in mcp-adapter.mjs.
