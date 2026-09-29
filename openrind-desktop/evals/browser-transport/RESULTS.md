# Transport experiment results

## 2026-09-25 local FUSE replacement — PASS

Run `bfa-a639db146154` verified all six artifacts from `local-chromium` and
`desktop-webview`: upload, download and PNG screenshot for each. Source hashes,
pre-replacement FUSE hashes and replacement-sandbox hashes matched. Exclusive
descriptor-relative writes, file/directory fsync and traversal/symlink rejection
ran against the real FUSE mount. The disposable TLS PostgreSQL, sandbox images
and both sandboxes were cleaned up; no user database was used.

Inputs: `results/fuse-staging-mD0TQr/sources.json` and `SHA256SUMS`.
This is a two-provider partial gate, not all-provider acceptance. Browserbase is
explicitly blocked at the user's request. Extended physical input/DPI and runtime
sign-off remain open.

The rehearsal exposed harness setup issues (certificate ownership, sandbox name
length, upload destination semantics, and SSH consuming loop input). After those
fixes, hashes isolated zero-filled bytes to CLI uploads directly from `/mnt/c`,
before FUSE writes. Copying verified inputs into Linux temporary storage resolved
the failure. Source and pre-replacement hash checks remain in the harness to
prevent a future transfer fault from being misreported as persistence loss.

## 2026-09-25 consolidated validation and focused repair

Run: `results/final-step1-Sln0jZ/summary.json` (09:29–09:34 UTC).

- All 16 protocol tests passed.
- Portable Electron packaging, 5 MiB binary WSL transport, real Claude MCP
  discovery through the Windows worker, worker EOF, nested frame ownership,
  child guard failure and synthetic input ownership passed.
- Staged Chromium 153.0.8010.12 / Playwright 1.63.0 passed the shared form,
  snapshot, upload, download and screenshot probe with sandbox enabled.
- HTTP JSON, HTTP SSE and TLS SSE passed, including cancellation and teardown.
  The reachable wrong-port and untrusted-CA negative probes passed with zero
  fixture calls. The direct socket attempt failed with ECONNREFUSED and zero
  fixture calls: this establishes failure to connect in this topology, not an
  independently attributed network-policy denial.
- The first packaged artifact probe timed out. Fixed renderer initialization,
  bounded debugger operations, and explicit exit after receipt persistence.
  A never-shown native view could not supply a screenshot surface. The corrected
  fixture briefly shows without requesting focus and captures through its owned
  debugger. Focused packaged recheck passed all three artifacts; receipt:
  `results/desktop-webview-RKlT6O/receipt.json` (PNG: 12,627 bytes; upload/download:
  55 matching bytes). The original run report is preserved, including its failure.
- Browserbase, all-provider FUSE replacement, extended physical-input/DPI checks
  and runtime sign-off were blocked/not run. No cloud session was created.

The first restricted-shell attempt passed the protocol tests but could not build
because of parent-directory access restrictions. The successful build/live run
used approved elevated execution. Pinned Chromium was installed before its
provider probe. No production Desktop runtime version was changed.

## 2026-09-25 additions — implemented, not run

Historical pre-validation status; superseded by the results above.

The restored `feat/browser-agent` work includes pinned Playwright local/cloud
fixtures, all-provider artifact receipts, staged Chromium assets, the embedded
artifact probe, confined FUSE replacement rehearsal, native geometry/extended
input controls, three transport-negative scenarios, and a consolidated final
runner. No tests or builds were run for these additions, at the user's request.
Prior PASS observations below apply to the versions exercised then, not to these
changes. See [STEP1-CHECKLIST.md](./STEP1-CHECKLIST.md); full Step 1 acceptance and
the runtime go/no-go decision remain pending.

Date: 2026-09-21. Source baseline: `feat/browser-agent` at `ba173f7`, plus this experiment. These are observed results, not acceptance of the full browser feature.

## Environment

| Component | Observed / pinned value |
|---|---|
| Host | Windows with dedicated `openrind-desktop-openshell` WSL distro |
| Host Node | 24.16.0 |
| Sandbox Node | 22.23.2 |
| Sandbox Claude Code | 2.1.276 |
| MCP SDK | 1.30.0 |
| Undici | 7.29.1 |
| Zod / esbuild | 4.3.6 / 0.27.2 |
| OpenShell managed control endpoint | `http://127.0.0.1:18770` |
| Managed network / tested bridge | `openshell-docker` / `172.18.0.1` (discover each run) |
| Fixture endpoint | `host.openshell.internal:18789/mcp`, HTTP or HTTPS according to the test |
| OpenShell CLI SHA-256 | `e61ed12578e126f351ce3fef511e4889deb73d86618c4933d117a6eb7c3fd72b` |
| Supervisor SHA-256 | `a02c20773ca061ad3099aac87839aad56f383fd41a1ba9bb25a63b2db8a0f3b4` |

Runtime versions above were read from the actual image, not inferred from its Dockerfile. The build writes the fixed-client hash to ignored `dist/manifest.json`; dependencies are locked in `package-lock.json`.

## Results

| Check | Result | Evidence / limit |
|---|---|---|
| Local SDK/stdio protocol suite | PASS, 8 tests | JSON/SSE, progress, cancellation, DELETE, ownership, revocation, input/body/route guards and no replay |
| Fixed bundle build | PASS | Three self-contained Node 22 CJS bundles; no runtime npm install |
| Native launcher compile | PASS | `cc -std=c11 -O2 -Wall -Wextra -Werror` inside real image overlay |
| Real OpenShell HTTP + SSE | PASS | Run `brp-5820d67b5663`; SDK tool discovery/calls; cancellation; Claude MCP connected |
| Real OpenShell HTTP + JSON | PASS | Run `brp-a8e8fbf520dc`; same assertions and audit |
| Real OpenShell HTTPS + SSE | PASS | Run `brp-3b44f0631c95`; ephemeral upstream CA plus OpenShell client CA trust, verification enabled |
| Service credential injection | PASS | Service accepted generated token, sandbox client received provider placeholder; no account/provider key used |
| Native executable identity | PASS | Fixed native-parent child allowed; same client directly through `/usr/bin/node` denied by policy |
| Live cancellation and subsequent reuse | PASS | Each live variant: `calls=3`, `cancelled=1`, `deleted=2`, `denied=0`, `notifications=1` |
| Actual Claude integration probe | PASS, limited | Real `claude-real mcp list` reports `openrind-browser` connected in test HOME; no inference/tool selection by model |
| Experiment resource cleanup | PASS for completed runs | Disposable sandbox/provider/profile/service/image removed; no `brp-*` containers remained in final inspection |

Progress callbacks were verified locally and over live SSE. JSON mode produced a server progress notification but did not establish incremental progress delivery to the consumer; its cancellation test waits a bounded interval instead. Do not claim JSON responses alone provide streaming progress.

## Findings incorporated into the harness

1. Attaching a credential profile did not itself permit the connection in this setup. The sandbox's explicit endpoint/native-binary network policy is necessary too.
2. Docker's default bridge was the wrong address. The actual injected OpenShell host alias resolved to `172.18.0.1`, the managed network gateway. The script now discovers that network and binds the fixture there.
3. This private address requires an explicit narrow `allowed_ips` rule. The supervisor correctly rejected a mismatched `/32`; no blanket private-network exception was added.
4. A root-owned descriptor still needs read permission for the sandbox user. Only non-secret metadata is made readable.
5. The minimal WSL environment has no Python, and the image lacks the `update-ca-certificates` helper. Diagnostics use installed shell tools; the TLS overlay appends only its generated public test CA to the existing CA bundle.
6. An early diagnostic failure interrupted cleanup once; final verification also found one provider left after asynchronous sandbox deletion. Their exact leftover resources were subsequently removed. Cleanup now disables shell fail-fast inside the trap, retries provider/profile cleanup with bounded waits and reports resource failures.

## Windows/WSL bridge results (2026-09-24)

The bridge uses pinned `cborg` 6.1.2 with length-prefixed CBOR frames, strict envelopes, a 256 KiB frame limit, 64 KiB chunks, per-stream credit, bounded queues and handshake/request fencing. EOF aborts pending work; no action replay is implemented.

| Check | Result | Evidence / limit |
|---|---|---|
| Combined local protocol suite | PASS, 16 tests | Includes malformed framing, byte splits, credit backpressure, sequence fencing, EOF and HTTP JSON/SSE through the bridge |
| Updated bundle build | PASS | Seven self-contained Node 22 CJS bundles |
| Actual `wslSpawn` binary pipes | PASS | 5 MiB random payload with matching SHA-256; EOF aborts a pending stream and the owned Linux process exits |
| Linux HTTP edge to Windows child worker | PASS | Authenticated MCP discovery/call and explicit session teardown across opaque binary pipes |
| OpenShell native client through Windows worker | PASS | `npm run test:wsl-http -- --openshell`: native call, cancellation, generic Node denial and actual Claude MCP discovery; worker audit confirms four calls, one cancellation and three deletions |
| Worker and edge cleanup | PASS | Both processes exit zero after EOF; disposable combined sandbox cleanup succeeds |
| Earlier leftover provider | Resolved | Deleted exact `brp-a8e8fbf520dc` provider; subsequent provider list contains no experiment providers; matching profile is absent |

The controller uses the application's real `wslSpawn` helper, but runs under Node and models Electron-main forwarding. It does not prove packaged Electron spawning, browser isolation, model-selected browser actions or production launch configuration.

## Pending gates

### Packaged native gesture evidence (2026-09-25)

`--packaged --native` now loads the native fixture from ASAR and asserts packaged mode. Real Windows input via Computer Use verified click, wheel and drag-gesture exclusion before and after human control on Electron 44.4.5. Human-mode positive controls registered one click, one wheel, one key and one HTML drag-start (with pointer motion while pressed). After release, page counters remained unchanged while shield click/wheel/drag-motion counters increased. The final fixture exited zero and no test window remained.

Completed HTML drop delivery did not occur: the native drags produced drag-start but zero drop events. An initial run with a completed-drop requirement did not complete its positive controls and was closed with a failing phase result. The revised test explicitly scopes PASS to gesture exclusion and reports the zero drop count separately; it does not claim completed drag-and-drop or external file-drop validation. Touch, IME, child focus, DPI/modal behavior and the production installer remain open gates.

### Native Windows pointer evidence (2026-09-24)

The candidate `--native` fixture was operated through Computer Use with real Windows click, wheel and key input. A fully transparent sibling WebContentsView failed: the underlying page recorded a click while the shield recorded none. The revised faintly painted shield (`#01ffffff` view background plus 1% white page paint) passed. Screenshots confirmed readable page content under the shield. Automation counters were page click/wheel/key 0/0/0, shield click/wheel 1/1; human mode then delivered page click/wheel/key 1/1/1. After release, another native click/wheel changed only shield counters to 2/2. Finish assertions passed and the fixture exited zero.

The initial runner's `windowsHide` setting prevented native discovery of the fixture; native mode now explicitly launches visibly. This also means previous synthetic input results must not be interpreted as visual composition evidence. The fully transparent failure is a design finding, not a passed check. This successful native run is unpackaged at the current desktop scale and does not cover touch, drag/drop, IME, child-frame focus, modal layering, resizing/DPI, minimized/collapsed state or simultaneous agent/native input. No user browser profile or external page was involved.

### Packaged browser/input evidence (2026-09-24)

The portable ASAR package now contains separate bundled transport, embedded and input entrypoints selected by a fixed dispatcher. The dispatcher asserts `app.isPackaged=true` and requires the disposable profile before loading a probe. Packaged Electron 44.4.5 / Node 24.21.0 passes nested OOPIF isolation and chooser interception, injected child-guard failure, and synthetic input/handoff. The combined native OpenShell/Claude transport also passes after this entrypoint change.

The packaged input run repeats the GPU command-buffer teardown diagnostics observed unpackaged, while assertions and process exit remain successful. Rendering stability is still open. This extends the earlier transport-only portable package evidence; it does not validate a signed installer, production fuse configuration, clean-machine runtime provisioning, transparent native shielding or the real Desktop sidebar.

### Portable packaged transport evidence (2026-09-24)

The ASAR fixture built with pinned `@electron/asar` 4.3.0 and Electron 44.4.5 passes `--packaged --openshell`: runtime reports `app.isPackaged=true`, Node 24.21.0; Linux MCP calls, native OpenShell/Claude discovery, cancellation, authenticated audit and worker/edge cleanup pass. `--packaged --crash-worker` also passes: worker termination closes the owned WSL edge without restart. All 16 local tests and runner syntax checks pass after the resource-root refactor.

Main code is bundled into `resources/app.asar`; immutable worker bundles and Linux fixture files are copied into `resources/browser-probe`. Paths resolve from `process.resourcesPath`, with artifact hashes recorded in the generated manifest. Fresh output directories avoid replacing existing packages. The first layout still used `electron.exe`, which reported unpackaged mode; naming the fixture executable `OpenrindBrowserProbe.exe` made the packaged-mode assertion pass. No production dependency or packaging configuration changed.

This is an unsigned portable experiment using Electron's default binary fuse settings, not an installed Desktop release. It relies on Electron Node mode for the child worker and the existing managed WSL image. Shipping fuse policy, clean-machine installation, signed updates, packaged input/browser views and production startup remain unproven.

### Supported runtime candidate (2026-09-24)

The separate `--candidate --crash-worker` run also passed: forced worker exit closed the owned WSL edge without automatic restart.

The registry's current stable Electron version was 44.4.5. It is now pinned only in this experiment's dev dependencies and npm lockfile. Electron supports its latest three stable majors ([support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)); the observed stable release line is 44 ([release listing](https://releases.electronjs.org/release?channel=stable)). Desktop remains on its existing dependency pending full application regression and packaged tests.

Observed runtime: Electron 44.4.5, Node 24.21.0, unpackaged. The official Windows x64 archive passed the npm package's SHA-256 check: `11c395820a5aaa8ebcc0686b476d0ac98a730274ebfbdc8cf5538a7c2815cb5d`. Nested OOPIF isolation/chooser checks, injected child-guard failure, synthetic input/handoff and the combined native OpenShell/Claude discovery/Windows-worker bridge checks all pass. Sixteen local protocol tests pass with the updated dependency lock. The input run emitted GPU command-buffer diagnostics during teardown despite passing and exiting zero; installed rendering stability remains to investigate.

The npm package installed but its synchronous first-import binary downloader stalled. Only the two owned download process trees were stopped. `install-candidate.ps1` now provides bounded official-URL download, checksum verification and local extraction; the runner verifies binary presence before launching and does not import Electron's downloader. No certificate verification was disabled. Native input, production launch and packaged lifecycle gates remain open.

### Input ownership evidence (2026-09-24)

`npm run test:electron -- --input` passes on the checkout Electron runtime with a briefly visible disposable window. Synthetic `sendInputEvent` keyboard input is blocked by `before-input-event` during automation; the human-mode positive control confirms renderer key delivery. Fixed CDP `Input.insertText` succeeds while the sibling shield remains visible with bounds equal to the page. Takeover enters draining mode immediately, discards an in-flight observation, waits for it to settle and only then removes the shield. Agent read/type/capture operations are denied during human control. Release restores the shield and keyboard block; debugger detach hides the page and fences agent access.

The first positive-control assertion raced renderer key delivery. The corrected test awaits an explicit renderer acknowledgement with a two-second bound; it then passes. This fixture uses an opaque shield and synthetic keyboard input, not native Windows pointer hit testing. It does not validate transparent page presentation, mouse/wheel/touch/drag exclusion, child-frame keyboard paths, IME, modals, DPI, minimize/collapse, trusted UI takeover or production queue semantics. API basis: [webContents input events](https://www.electronjs.org/docs/latest/api/web-contents).

### Nested target evidence (2026-09-24)

`npm run test:electron -- --embedded --oopif --nested` passes with the parent, child and cross-site grandchild in distinct renderer processes. Each paused iframe target installs its chooser interception and recursive autoattachment before resume. Nested fixed inspection succeeds for its owner and rejects the other owner/session registry. A chooser event is verified on the grandchild session, with zero files selected. Ancestor navigation invalidates both direct and nested session access.

The stricter stale-session assertions exposed delayed CDP detach delivery: a removed nested session could remain in the map briefly. Issued test access now captures the view's navigation epoch and checks it before dispatch, in addition to post-inspection checks. The corrected nested run and injected child-guard failure run pass. This is a two-level fixture, not exhaustive navigation-race coverage or production broker code. Native input shielding and installed runtime validation remain pending.

### Child file-chooser guard evidence (2026-09-24)

The OOPIF probe now uses autoattach with `waitForDebuggerOnStart=true`. Each direct iframe session receives `Page.enable` and `Page.setInterceptFileChooserDialog` before `Runtime.runIfWaitingForDebugger`. Tool inspection also requires guarded-session membership. A child file-input click emits `Page.fileChooserOpened` on the expected child session and leaves its selected-file count at zero. The successful OOPIF/embedded suite passes with this ordering.

The `--fail-child-guard` variant injects failure before guard installation. It passes assertions that both affected owned views are fenced and destroyed with no guarded sessions. The first negative run exposed a cleanup bug: Electron removes the view's `webContents` property after destruction. The probe now retains the contents reference for assertions and tolerates an already-disposed view during cleanup; the corrected negative run exits successfully. Nested descendants and native chooser variants remain open gates.

### Separate-process child evidence (2026-09-24)

`npm run test:electron -- --embedded --oopif` passes on Electron 35.7.5. The fixture uses process-local host mapping and `site-per-process`; the test asserts that the cross-site child's renderer process ID differs from its parent's. Fixed CDP title inspection succeeds only through the owning debugger's autoattached iframe session, with parent-chain membership checked against its current root tree. Unknown sessions, another owner's session and the old child session after cross-site-to-same-site navigation are denied. The earlier embedded assertions also pass in this mode.

An initial strict check failed because the root `Page.getFrameTree` omitted the out-of-process child. The experiment now supplements that tree with `Page.frameAttached` parent relationships and removes detached relationships except process swaps. It retains owner, epoch and active-session checks. This proves the tested direct-child case only; nested descendants, rapid detach/navigation races, child file-chooser guards and production broker hardening remain pending. Forced site isolation is an experiment setting, not a production upgrade decision.

### Child-frame evidence (2026-09-24)

The extended embedded probe passes same-origin and cross-origin (different loopback ports) child-frame inspection with opaque owner-scoped handles. Cross-owner and unknown handles are rejected. The page itself receives `SecurityError` when attempting cross-origin DOM access. Removed frames and handles issued before a child navigation are rejected; fresh handles work after navigation. Debugger detach also rejects fresh child handles. Any frame navigation conservatively invalidates all references in that owned view.

This fixed inspection experiment uses Electron's [owned frame tree](https://www.electronjs.org/docs/latest/api/web-frame-main), with ownership and epoch checks before and after inspection. It does not prove out-of-process iframe CDP routing: different ports establish different origins but do not necessarily create separate renderer processes. Cross-site/OOPIF, nested-frame navigation races, CDP descendant session authorization and native input exclusion remain pending. Both local fixture servers and all disposable views exit cleanly.

### Embedded view evidence (2026-09-24)

`npm run test:electron -- --embedded` passed on Electron 35.7.5 with two actual hidden `WebContentsView` instances and a loopback fixture. Verified: owner-scoped fixed inspection; cross-owner and unknown-ID denial; separate cookie stores; no page `require`, `process` or app bridge; popup denial; a CDP file-chooser event with zero selected files after interception established before fixture navigation; debugger detach hides and fences the affected view while the other owner remains usable. Contents, server and disposable profile were cleaned up successfully.

The fixture broker exposes no generic command/expression API, installs no app preload and opens no global CDP port. This demonstrates a narrow implementation pattern, not complete target isolation: app-target attacks, same/cross-origin child frames, native file-dialog variants and human-input shielding still require evidence. The views were hidden, so no visible sidebar or manual interaction claim is made. API references: [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [Debugger](https://www.electronjs.org/docs/latest/api/debugger), [webContents](https://www.electronjs.org/docs/latest/api/web-contents).

### Additional Electron runtime evidence (2026-09-24)

`npm run test:electron -- --openshell` passed under the checkout's Electron 35.7.5 / Node 22.16.0 (`app.isPackaged=false`). Linux MCP calls, native OpenShell calls, actual Claude discovery, cancellation, audit and clean worker/edge exits passed. `npm run test:electron -- --crash-worker` also passed: forced worker exit closed the WSL edge within five seconds without restart. The 16 local tests passed after the runner refactor; final runner syntax checks passed.

The probe initially stalled during top-level asynchronous startup. Startup now invokes an asynchronous lifecycle function without blocking module evaluation, and the outer runner enforces a timeout. Disposable Electron profiles are removed by the outer runner after process exit. No production startup hooks or settings changed. This evidence does not establish a supported shipping Electron version or packaged Node-mode availability; the current bundled Node is also older than this harness's declared minimum.

- Actual Haloop-backed production Claude launch selecting a tool through its merged managed configuration, including resume and signed conversation-bound grants. The current check uses the real Claude binary but an isolated transport-only sandbox without FUSE or model inference.
- Additional live negatives: wrong target/port with native identity, direct socket bypass, invalid upstream CA and expired launch assertion. Local auth/Origin/Host/input rejection tests are not substitutes for these OpenShell checks.
- Packaged Windows Electron worker lifecycle and restart behavior. Raw `wslSpawn`, bounded CBOR streaming, backpressure and EOF fencing now have experiment evidence; packaged Electron and worker-crash recovery remain unproven.
- Embedded target isolation, native input ownership, supported Electron upgrade, real local/cloud browser behavior and FUSE artifact durability.

Step 1 is still in progress. The first transport foundation is working; no provider/browser parity or customer-release claim is made.
