import { preflightClaudeBrowser } from '../../packages/browser-client/src/claude-preflight.mjs';
if (process.argv.length !== 2) {
  process.stderr.write('openrind-browser: preflight arguments forbidden\n');
  process.exitCode = 1;
} else {
  preflightClaudeBrowser().catch(() => {
    process.stderr.write('openrind-browser: launch configuration is missing, unsafe, disabled or conflicting; repair provisioning and the openrind-browser MCP entry before reconnecting\n');
    process.exitCode = 1;
  });
}
