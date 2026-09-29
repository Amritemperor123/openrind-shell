# Browser MCP client

Step 3 sources are connected to Desktop's Claude launch. The primary image and
Windows resource bundle include fixed build/install definitions. See
`prds/browser-integration-step3.md` for validation evidence and remaining gates.

- `native/launcher.c` accepts no arguments, keeps the native parent alive and
  executes only `/usr/bin/node /opt/openrind-browser/client.cjs`. Its environment
  allowlist carries proxy/CA settings and separate service/grant credentials;
  model/database credentials, Node flags and proxy bypass variables are omitted.
- `src/launch-config.mjs` validates the fixed endpoint descriptor and credentials,
  reads the installed descriptor without following a final symlink, and provides
  a pure MCP configuration merge preserving unrelated servers. Conflicting
  `openrind-browser` entries fail. The launch integration must supply every
  applicable configuration scope. The wrapper adds a fixed MCP file after
  read-only preflight without changing persisted user settings.
- `src/mcp-adapter.mjs` adapts the shared contract to MCP stdio and HTTP using SDK
  constructors supplied by the bundled entrypoint. It requires an explicit proxy,
  rejects redirects/endpoint changes, disables SSE reconnect retries, propagates
  cancellation/progress and attempts bounded session deletion on shutdown.
  Lost action responses are unknown outcomes. The two filesystem tools never go
  to the remote tool endpoint; without their future adapters they are unavailable.

The isolated build and lockfile live in `packaging/browser-client`. The primary
Dockerfiles build/install the fixed bundle and native launcher. The authenticated
HTTP handler lives in `browser-service/src/http.mjs`. The built primary image's
native client and descriptor provisioner passed live transport validation.

Descriptor provisioning, private bridge/worker supervision, separate OpenShell
provider binding, grant lifecycle and Claude configuration preflight are wired.
The descriptor parent directories must be root-owned and not writable by sandbox
users. Do not invoke the adapter from arbitrary model-selected scripts or URLs.

Production-source validation now covers SDK discovery, isolation, revocation,
the real WSL bridge, native OpenShell ancestry and actual Claude MCP discovery.
This does not claim a live browser provider or full installed Desktop acceptance.
