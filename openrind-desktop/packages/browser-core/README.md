# Browser foundation (Step 2)

This package is the shared, Electron-free foundation. No production browser
provider is installed by default. The Step 1 experiments are separate code and
are not wired into Desktop or advertised as production capabilities.

Implemented here:

- Strict shared validation for all 19 specified names; only 17 remote tools are
  discoverable. The two workspace file tools remain client-local.
- Credential-derived tenant/workspace/sandbox/conversation principals, short-lived
  grants, controller revocation and dispatch-time checks.
- Private SQLite migrations, FULL synchronous journal writes before side effects,
  canonical-input deduplication, unknown-outcome preservation and restart fencing.
- One bounded queue per session, per-conversation/worker quotas, profile leases,
  capability gates, normalized HTTPS origin policy and public-address checks.
- Scoped, expiring snapshot references; bounded semantic normalization and
  sensitive-node redaction. Native actionability remains a driver's obligation.
- Single-use trusted approvals bound to grant, owner, epoch, page/origin, operation,
  argument hash, policy revision and expiry. Form values are excluded from audit.
- Human-control pause/release, late-result fencing, trusted reconciliation,
  conversation revocation, expiry sweeping and visible pending cleanup.

`BrowserCore.call` is the untrusted tool boundary. `grants.issue`, `approve`,
`releaseHuman`, `renewHuman`, `reconcile`, `sweep` and `deleteConversation` are
trusted host APIs. They must never be exposed directly through MCP or ordinary
renderer IPC. New grants require the existing trusted active-launch controller;
the browser credential is separate from mandatory Haloop inference credentials.

The provider and page-driver interfaces are declared in `browser-contract`.
Only a deterministic test fixture implements them in this step. Production
Playwright/Electron adapters, network event guards, SDK transports, artifact byte
routes and installed launcher wiring belong to the later vertical slices.
Screenshot/upload/download execution and secret-handle resolution deliberately
return `CAPABILITY_UNAVAILABLE` until those implementations exist. Do not advertise
them as usable merely because their schemas exist.

## Registry and runtime

Use Node >=22.19 with `node:sqlite`. The service bootstrap uses no Electron module
or native addon ABI. Shipping this runtime inside Desktop is still a packaging
gate; the existing Electron version is not silently changed.

The absolute registry path must be in a service-private directory (appropriate
Windows ACLs or POSIX permissions). A separate exclusive lock admits one worker.
After a crash the lock intentionally remains: an operator must establish that the
old process is stopped before removing that exact lock and restarting. There is
no multi-replica executor lease or claim of high availability. On restart grants
are inactive, epochs advance and dispatched journal records become unknown.
Profiles remain leased until cleanup is confirmed. Unknown records are retained
for review; completed outcomes expire after 24 hours when `sweep` runs.

A timed-out driver is fenced even if its underlying promise cannot be cancelled.
New work cannot run while it remains unsettled. Reconciliation is an explicit
trusted action; it does not erase or replay the unknown operation. Destination
checks are application guardrails, not DNS-rebinding-proof network containment.

## End-of-step validation

After normal workspace dependency installation:

```sh
pnpm --filter @openrind/browser-core test
```

The fixture suite covers schemas, cross-owner access, deduplication, approvals,
late actions, queued revocation, human release, leases, restart and package
boundaries. It opens only temporary local databases and uses no real browser,
cloud account, PostgreSQL, external website or Haloop request.
