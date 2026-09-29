# Browser MCP transport experiment

Implements the Step 1 risk harnesses from [issue #51's plan](../../prds/browser-agents-plan.md). The MCP fixture exposes only `openrind_transport_probe` (bounded nonce and delay); separate provider probes exercise controlled browser pages. None of these are a production service.

See [STEP1-CHECKLIST.md](./STEP1-CHECKLIST.md) for the implementation checklist and consolidated validation command. The default final run completed; an embedded artifact failure was repaired and passed a focused recheck. Cloud, FUSE and physical-input gates remain open. The artifact fixture briefly shows without requesting focus so Windows creates its screenshot surface. Historical commands below are individual probe references, not instructions to rerun each increment.

## Run locally

### Portable packaged transport fixture

After installing the candidate binary:

```powershell
npm run build:packaged-probe
npm run test:electron -- --packaged --openshell
npm run test:electron -- --packaged --crash-worker
npm run test:electron -- --packaged --embedded --oopif --nested
npm run test:electron -- --packaged --embedded --oopif --fail-child-guard
npm run test:electron -- --packaged --input
```

Builds a fresh ignored `dist/packaged-probe-*` directory containing the candidate runtime, a bundled main process in `resources/app.asar`, and fixed worker/WSL resources outside the archive. A manifest records bundle/archive hashes. The runner uses a disposable profile and asserts packaged mode. There is no runtime npm install or dependency on source modules in the archive. The package still requires the existing managed WSL runtime/image for these probes.

This unsigned portable fixture bundles fixed transport, embedded-browser and input entrypoints into the archive and asserts packaged mode before dispatch. It does not change Desktop's installer, signing, update feed, fuse settings or production resource list. Generated package outputs remain under ignored `dist/` for inspection. The input variant briefly shows its disposable test window and tests synthetic keyboard input, not native Windows pointer routing.

### Supported Electron candidate

The isolated harness pins Electron **44.4.5** independently of Desktop's current dependency. Install with `npm ci --ignore-scripts`, then run `./install-candidate.ps1` on Windows to download the official binary with a bounded timeout and verify it against the checksum published in the installed npm package. Archives remain in ignored `dist/`. The probe runner fails promptly if the selected runtime binary is missing; it does not trigger Electron's synchronous download-on-import behavior.

Add `--candidate` to select this runtime, for example:

```powershell
npm run test:electron -- --candidate --embedded --oopif --nested
npm run test:electron -- --candidate --embedded --oopif --fail-child-guard
npm run test:electron -- --candidate --input
npm run test:electron -- --candidate --openshell
npm run test:electron -- --candidate --crash-worker
```

Without `--candidate`, probes still select the Desktop checkout's installed runtime. This comparison does not upgrade or validate the complete Desktop application.

Node 22.19+ is required. This experiment intentionally owns an npm lockfile outside the pnpm application packages so dependency selection does not change Desktop's production dependency graph.

```sh
cd openrind-desktop/evals/browser-transport
npm ci --ignore-scripts
npm test
npm run build
```

Tests cover JSON and SSE, tool discovery, progress, cancellation across stdio/HTTP, session teardown, credential revocation, cross-principal session rejection, Origin/Host/route validation, bounded request bodies, unsupported encoding, strict tool inputs, required proxy, and lost-response non-replay. All test credentials are generated per run.

## Run against real OpenShell

The script needs the dedicated WSL distro's Docker daemon, the managed gateway, and an existing `openrind-shell-fuse:local` image containing Node, Claude and `cc`. It builds a disposable overlay image and registers a uniquely named provider/profile/sandbox. It never edits an existing sandbox, the normal image tag, the normal Claude config, or Haloop credentials. No provider-backed model call is made.

After building the bundles on Windows, run:

```powershell
wsl -d openrind-desktop-openshell -- bash /mnt/c/Users/ANKUR/Projects/openeral/openrind-desktop/evals/browser-transport/run-live.sh
wsl -d openrind-desktop-openshell -- env PROBE_JSON=1 bash /mnt/c/Users/ANKUR/Projects/openeral/openrind-desktop/evals/browser-transport/run-live.sh
wsl -d openrind-desktop-openshell -- env PROBE_TLS=1 bash /mnt/c/Users/ANKUR/Projects/openeral/openrind-desktop/evals/browser-transport/run-live.sh
```

Adjust the checkout path for another machine. From inside that distro, `bash run-live.sh` works directly. Optional operator settings: `OPENSHELL_BIN`, `OPENSHELL_GATEWAY_ENDPOINT`, `OPENSHELL_DOCKER_NETWORK`. The default managed network is `openshell-docker`; do not substitute the unrelated default Docker bridge. Port 18789 is fixed for the experiment, and concurrent runs on this host are not supported.

The service binds only the verified managed bridge address. Both sandbox policy and provider profile restrict the exact endpoint, HTTP methods, native executable ancestry and bridge `/32`. A generated credential reaches the service through OpenShell placeholder injection; it is never baked into the image or passed as a command-line value. The native parent keeps its identity alive and starts one immutable Node bundle with an allowlisted environment. Direct invocation of that bundle through generic Node must fail.

TLS mode creates an ephemeral CA and server certificate. Only the public CA is added to the disposable image's existing trust bundle; private keys stay in the temporary run directory. The sandbox client retains OpenShell's CA environment. No TLS verification is disabled.

The live probe checks an actual SDK call and cancellation through the native launcher, rejects direct Node access, and runs the real `claude-real mcp list` against an isolated test HOME. The service audit must report three calls, one cancelled request and two explicit MCP session deletions. The last check proves Claude's connection setup, not a model-selected tool call or the production Haloop/FUSE launch.

Cleanup runs on exit, terminates only experiment resources, removes temporary credentials/certificates, and reports failed provider/profile/image/container cleanup. A forced host/process kill can still interrupt shell cleanup; use the printed `brp-*` identifier to reconcile that exact run. Do not delete other Desktop resources.

## Windows worker and WSL bridge

After building on Windows with the managed WSL Docker runtime available:

```powershell
npm run test:wsl
npm run test:wsl-http
npm run test:wsl-http -- --openshell
```

The first check sends 5 MiB of random binary data through the actual application `wslSpawn` helper and verifies its hash and EOF cleanup. The second connects a Linux HTTP edge to a Windows child-process fixture through opaque pipes. The final variant also runs the native OpenShell/Claude discovery probe through that Windows worker. Tokens use private IPC/stdin, never command-line values. Runs use disposable containers and must not overlap other probes on port 18789.

The bridge pins `cborg` and validates bounded length-prefixed CBOR frames before dispatch. It enforces 64 KiB chunks, 256 KiB flow-control windows, request sequencing, a startup handshake, deadlines and EOF cancellation. These are experiment limits, not final artifact-transfer capabilities. The controller models Electron-main forwarding under Node; packaged Electron still needs its own validation.

## Boundaries still to prove

### Native pointer fixture

Run `npm run test:electron -- --candidate --native`, or build the portable package and use `--packaged --native`, for an interactive disposable window (ten-minute timeout). Click, scroll and drag across the blue/yellow boxes while automating; the shield counters must increase and page counters remain zero. Select **Human mode**, drag the blue box, click/type in the harmless input and scroll the page. Select **Automation mode**, then click, scroll and drag again. **Finish check** asserts the counters and closes the fixture. Native evidence requires actual Windows input; synthetic renderer events are not a substitute. The test never reads the entered text, only event counts. Completed HTML drops are reported separately and are not covered by the gesture-exclusion PASS.

The tested overlay uses a faint painted background. A completely transparent overlay failed native click exclusion in this runtime. The successful packaged fixture preserves visible page content and rejects page click/wheel/drag-gesture input before and after human takeover. Touch, completed HTML/external file drops, IME, modal/DPI and child-frame focus remain unproven. Its fixed console controls exist only in trusted local test chrome and are not a proposed production IPC contract.

### Input ownership probe

`npm run test:electron -- --input` briefly shows a disposable focused test window. It verifies synthetic Electron keyboard exclusion during automation with a human-mode positive control, fixed CDP text insertion while a sibling shield view stays visible, draining takeover, rejection of agent read/type/capture during human control, release restoring protection and debugger-loss fencing. All views and the temporary profile close at exit.

This is not a Windows native hit-test result. The shield is opaque in this experiment; transparent presentation, native mouse/wheel/touch/drag routing, focus transfer across child frames, modal layering, DPI/zoom and actual trusted UI takeover still require validation. No production input flow is installed by this test.

### Embedded view probe

Use `npm run test:electron -- --embedded --oopif --nested` for a cross-site grandchild. Recursive autoattachment is installed in each paused target before resume. The fixture verifies three distinct renderer processes, nested owner denial, nested chooser interception and rejection of both child sessions after ancestor navigation. Issued access is bound to the view's navigation epoch so delayed detach events cannot keep old access valid.

The OOPIF probe pauses newly attached child targets, installs their own file-chooser interception and resumes only after successful setup. `npm run test:electron -- --embedded --oopif --fail-child-guard` injects setup failure and verifies closure of the affected owned views before resume. No host files are selected. This test covers the direct-child fixture; nested target setup remains pending.

Add `--oopif` (`npm run test:electron -- --embedded --oopif`) to force site isolation and map the reserved fixture hostname `child.browser.test` to loopback inside this test process. This mode asserts different renderer process IDs and tests fixed CDP child inspection through owner-scoped autoattached sessions. Root frame-tree data is supplemented by owned debugger parent-frame events. Unknown, cross-owner and stale child sessions are denied. No system DNS configuration changes.

Run `npm run test:electron -- --embedded` to create two hidden, disposable `WebContentsView` instances against a local fixture. The probe tests owner-scoped fixed title inspection, unknown target denial, cookie separation, absence of page Node/app bindings, popup denial, file-chooser interception installed before fixture navigation, and hiding/fencing on debugger detach. No host file is selected. All contents and the local server are closed at exit.

This is an experimental broker inside the test, not the production browser manager. Hidden views do not establish native human-input exclusion, sidebar geometry or manual takeover. Cross-site/OOPIF routing, file-chooser variants and supported/packaged Electron remain pending.

The probe additionally inspects same-origin and cross-origin child frames using fixed internal code and opaque session-owned handles. It rejects other owners, unknown handles, removed frames and stale references after navigation or debugger loss. This uses the owned Electron frame tree; cross-site/OOPIF CDP routing remains a separate gate. The cross-origin fixture uses another loopback port and is not proof of a separate renderer process.

### Electron lifecycle probe

```powershell
npm run test:electron -- --openshell
npm run test:electron -- --crash-worker
```

Uses the Desktop checkout's installed Electron executable with a disposable user-data directory and no application windows. The fixed child worker explicitly enters Electron's Node mode. The parent deletes its temporary profile only after Electron exits. A bounded timeout terminates only the probe process tree. The crash variant verifies that worker EOF closes the owned WSL edge without automatic restart. This is an unpackaged runtime check; installer resources, ASAR layout and shipping fuse settings remain separate gates.

See [RESULTS.md](./RESULTS.md) for historical evidence and [STEP1-CHECKLIST.md](./STEP1-CHECKLIST.md) for current gaps. The fixture has bounded in-memory sessions, not production grants or a session journal. Browser engines, FUSE and portable Electron packaging are exercised only by isolated experiments. The bundled client must not be installed in customer images as-is.
