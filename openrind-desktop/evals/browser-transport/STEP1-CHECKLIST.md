# Step 1: implementation and final validation

Updated 2026-09-25 after the consolidated validation. Protocol, packaged bridge,
owned-view, synthetic input, local Chromium and transport checks passed. The
embedded artifact failure was repaired and its focused packaged recheck passed.
Browserbase, FUSE replacement, extended physical input and runtime sign-off remain
open. Local Chromium and embedded-view artifacts additionally passed a real
two-provider FUSE replacement rehearsal. Browserbase remains blocked by user
choice. See RESULTS.md for exact evidence and the preserved initial failures.

| Experiment | Harness implemented | Final evidence |
| --- | --- | --- |
| Native MCP / real Claude discovery; JSON, SSE, cancellation and teardown | Yes | Rerun in consolidated validation; discovery is not a model-selected tool call |
| Private binary Windows/WSL bridge, bounds, credit, EOF and worker loss | Yes | Rerun against packaged candidate |
| Owned embedded views, nested frames, chooser interception and guard failure | Yes | Rerun against packaged candidate |
| Native handoff, mouse, keyboard, wheel and drag gesture | Yes | Physical input required |
| Resize, zoom, collapse, minimize and modal layout | Yes, interactive controls | Exercise each control and repeat protected input; review visual placement |
| Touch, IME, completed/external file drop, child-frame typing and DPI | Yes, optional strict counters and scale tracking | Suitable physical devices, IME and display configuration required |
| Shared Playwright navigation, accessibility snapshot and form | Yes, pinned Playwright 1.63.0 | Local staged Chromium and a real Browserbase session required |
| Upload, download and screenshot for all three providers | Yes, hash/size receipts | Fresh successful receipts required for all providers |
| Confined FUSE save and replacement-sandbox durability | Yes, openat2 helper and two-sandbox orchestration | Disposable database/gateway required; checks all nine artifact hashes |
| Denied reachable port, untrusted CA and direct socket | Yes, negative configurations and fixture audits | Live negative results pending; do not infer policy correctness merely from a timeout |
| Runtime and packaging go/no-go | Decision pending | Review final evidence; portable experiment is not a signed Desktop installer |

## One final validation command

From this directory, after provisioning the prerequisites:

```powershell
npm run validate:step1 -- --interactive --extended-input --dpi --allow-cloud-session --fuse
```

The full command above has not been executed with all optional gates. The default
command has run, followed by a focused embedded artifact repair/recheck. It runs the
protocol checks, rebuilds the experiment package, exercises the live probes and
writes `results/final-step1-*/summary.json`. Provider receipts and FUSE staging are
isolated beneath that run. Missing prerequisites are blocked, never skipped as a
success. Failures/incomplete gates produce a nonzero exit status. Final runtime
sign-off remains a reviewed decision, so a successful automated run alone does
not report full Step 1 acceptance.

Prerequisites:

- Candidate Electron binary installed using the existing bounded installer.
- Pinned Chromium installed using `npx playwright install chromium`. The final
  runner copies those assets into a fresh experiment directory, verifies the
  executable hash and launches with Chromium sandbox enabled and a private pipe.
  It never uses personal Chrome or silently downloads a browser.
- Browserbase key/project in `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`.
  `--allow-cloud-session` explicitly allows one disposable, billable session with
  a 180-second timeout. Creation is never retried. Its receipt records an intent
  before creation and a session ID after confirmation; an ambiguous create must
  be reconciled using the recorded run ID in Browserbase metadata. Connection
  URLs, keys and provider error bodies are not logged. Release is explicitly
  requested and its terminal status polled.
- Managed OpenShell WSL runtime and FUSE image. Set `DATABASE_URL` to a disposable
  database accepted by the image policy, plus `OPENSHELL_GATEWAY_ENDPOINT`.
  Optionally set `OPENRIND_BROWSER_FUSE_IMAGE` for a configured fixture image.
  Database values travel in environment/private files, never command arguments.
  The rehearsal creates a unique workspace and two owned sandboxes. It removes
  the sandboxes/image but retains that isolated workspace's database records as
  evidence; it does not issue direct SQL cleanup.
- Touch input, a configured IME, a harmless local file for drag/drop, and displays
  with different scaling (or a deliberate scale change) for strict native input.

The interactive sequence is protected input, human takeover with positive
controls, then restored protection. Exercise all five geometry buttons while
automating; use Collapse twice and restore the minimized window from Windows.
Close the fixture modal. Repeat click/wheel/drag after each change. For extended
input, touch and drop a harmless file on the shield before and after takeover;
in human mode also commit IME text, complete a drop and type inside the child
frame. Only event counts are collected; dropped file contents are not read.

## Boundaries

For a cloud-free partial rehearsal, `stage-fuse-receipts.mjs` takes explicit
successful provider-result directories and verifies their bytes against receipts.
Run `run-local-fuse.sh <staging-directory>` inside managed WSL with
`BROWSER_PROBE_PROVIDERS='local-chromium desktop-webview'`. It provisions a private
temporary TLS PostgreSQL fixture, checks all six files before/after sandbox
replacement and removes its owned database/container/image resources. The
default three-provider gate is unchanged. Inputs are copied into Linux storage
before CLI upload to avoid the observed Windows-mount transfer failure.

These are experiments, not the 19 production browser tools. The shared service,
grant/journal model, production Claude launch binding, sidebar integration,
installer and shipping Electron fuse decisions belong to later plan steps.
The FUSE helper intentionally supports exclusive flat destinations only; it does
not substitute for the later production artifact/approval/atomic-save contract.
Shipping sandbox enforcement, display behavior and cloud account compatibility
must be assessed from the final run before a go/no-go decision.

Provider API references used for the experiment:
[session release](https://docs.browserbase.com/reference/api/update-a-session)
and [download retrieval](https://docs.browserbase.com/platform/browser/files/downloads).
