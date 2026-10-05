---
name: openrind-browser
description: Automate, navigate, and interact with web pages using openrind-browser tools or CLI.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Grep, Glob
---

# Openrind Browser Agent

Use this skill to browse the web, visit pages, interact with elements, fill forms, and inspect webpage contents.

## Using MCP Tools (Primary)

When the openrind-browser MCP server is available, invoke its tools directly:

- `browser_start`: Start a browser session.
  - Arguments: `{ "url": "https://example.com" }`
- `browser_navigate`: Navigate to a URL.
  - Arguments: `{ "sessionId": "<sessionId>", "url": "https://example.com" }`
- `browser_snapshot`: Capture a semantic text snapshot / accessibility tree of the current page.
  - Arguments: `{ "sessionId": "<sessionId>" }`
- `browser_click`: Click an element identified by its selector or element ID from the snapshot.
  - Arguments: `{ "sessionId": "<sessionId>", "selector": "<selector>" }`
- `browser_fill`: Enter text into an input or textarea field.
  - Arguments: `{ "sessionId": "<sessionId>", "selector": "<selector>", "value": "<text>" }`
- `browser_screenshot`: Take a visual screenshot of the current page.
- `browser_close`: Close the browser session.

## Using CLI Commands (Fallback)

If MCP tools are not directly exposed in the model tool set, execute the browser CLI from bash:

```bash
# Start browsing a URL (opens tab in Desktop)
browser start "https://www.amazon.com"

# Or navigate an existing session
browser navigate "https://www.amazon.com"

# Capture the text and structure of the page
browser snapshot

# Click an element (e.g. search submit button)
browser click "#nav-search-submit-button"

# Fill a search bar or text input
browser fill "#twotabsearchtextbox" "Nothing Phone"
browser press "Enter"

# View status or active tabs
browser status
browser tabs
```
