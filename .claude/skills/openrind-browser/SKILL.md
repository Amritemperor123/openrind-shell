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
- `browser_snapshot`: Capture interactive controls list with element coordinates (bounds, center) and refs (`@e1`, `@e2`).
  - Arguments: `{ "sessionId": "<sessionId>" }`
- `browser_click`: Click an element identified by its ref from snapshot (e.g. `@e1` or `e1`).
  - Arguments: `{ "sessionId": "<sessionId>", "ref": "@e1" }`
- `browser_fill`: Enter text into an input or textarea field identified by its ref (e.g. `@e1` or `e1`).
  - Arguments: `{ "sessionId": "<sessionId>", "ref": "@e1", "text": "<text>" }`
- `browser_press`: Press a key (e.g. `Enter`, `Tab`, `Escape`).
  - Arguments: `{ "sessionId": "<sessionId>", "key": "Enter" }`
- `browser_scroll`: Scroll the page in a direction (`down`, `up`).
  - Arguments: `{ "sessionId": "<sessionId>", "direction": "down", "distance": 800 }`
- `browser_screenshot`: Take a visual screenshot of the current page.
- `browser_close`: Close the browser session.

## Using CLI Commands (Fallback)

You can also use bash commands directly from terminal:

```bash
# Start browsing a URL (opens tab in Desktop sidebar)
browser start "https://www.amazon.com"
# or simply:
navigate "https://www.amazon.com"

# Capture interactive controls and coordinates (snapshot -i)
snapshot -i
# or:
browser snapshot -i

# Fill search bar or input with text (using element ref from snapshot)
fill @e1 "Nothing Phone"
# or:
browser fill @e1 "Nothing Phone"

# Submit form or press Enter
press Enter
# or click the submit/search button
click @e2

# Inspect the results
snapshot -i

# Scroll down to see more results
browser scroll down 800
```
