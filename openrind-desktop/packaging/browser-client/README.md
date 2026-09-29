# Fixed browser client build

This isolated npm build context packages production sources from `packages/`.
It does not depend on the experiment harness or the Desktop workspace install.
The committed lockfile pins the complete build dependency graph.

From this directory, `npm ci --ignore-scripts --no-audit --no-fund` followed by
`npm run build` produces `dist/client.cjs` and its SHA-256 manifest. The primary
sandbox Dockerfiles perform these steps in a build stage. The resulting image
installs no client dependencies at runtime.

The native launcher accepts no arguments. Trusted provisioning must install
`/etc/openrind-browser/descriptor.json` owned by root, without group/world write
permissions, containing exactly `protocol: 1`, the approved `endpoint` ending
in `/mcp`, and `requireProxy: true`. Root-owned non-writable parent directories
are checked at startup. Credentials are inherited separately; do not put them in
the descriptor, bundle, MCP configuration, command arguments or manifest.

The image build and installed native client passed the Step 3 transport check.
Desktop launch integration is wired; fresh/resumed FUSE conversation acceptance
remains open. See `../../prds/browser-integration-step3.md`.

Windows Desktop resource staging: build the bundles, then run
`node stage-runtime.mjs ABSOLUTE_PATH_TO_VERIFIED_NODE_EXE` using an independently
verified official Windows Node 22 runtime (22.19 or later) or Node 24. The staging command
checks SQLite availability and records executable/bundle hashes and architecture
in `browser-runtime/runtime-manifest.json`. Electron Builder copies those fixed files
outside ASAR. Match the Node architecture to the target Desktop architecture.
This manifest checks resource integrity; it does not replace verification of the
official Node distribution or application signing. Missing resources cause the
installed runtime resolver to fail with a repair error. Local validation used
staged Node 24.16.0. Generated resources are ignored; stage each release build.
