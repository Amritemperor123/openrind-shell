import { randomUUID } from 'node:crypto';

// Private worker control API only: never expose these methods as MCP tools or
// renderer IPC. Heartbeats must come from the owner supervising the actual PTY.
export function createLaunchLeases(core, { clock = Date.now, heartbeatMs = 30_000 } = {}) {
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1000 || heartbeatMs > 60_000) throw new Error('Invalid controller deadline');
  const launches = new Map();
  const owners = new Map();
  let closed = false;
  const stop = id => {
    const launch = launches.get(id);
    if (!launch) return;
    launches.delete(id); owners.delete(launch.owner);
    // Synchronous revocation/epoch fencing occurs before any asynchronous cleanup.
    core.disconnectOwner(launch.owner);
  };
  const expire = () => {
    for (const [id, launch] of launches) if (launch.deadline <= clock()) stop(id);
  };
  const timer = setInterval(expire, Math.min(heartbeatMs, 1000));
  timer.unref();
  return Object.freeze({
    begin(scope, policy) {
      if (closed) throw new Error('Browser controller is disconnected');
      expire();
      const issued = core.grants.issue(scope, policy);
      const auth = core.grants.authenticate(issued.token);
      const previous = owners.get(auth.owner);
      if (previous) {
        // Revoke only the newly issued grant, preserving the active controller.
        core.grants.revoke(issued.principal.grantId);
        throw new Error('A browser launch already owns this conversation and sandbox');
      }
      const id = `launch_${randomUUID()}`;
      launches.set(id, { token: issued.token, owner: auth.owner, deadline: clock() + heartbeatMs });
      owners.set(auth.owner, id);
      return { launchId: id, token: issued.token, principal: issued.principal };
    },
    heartbeat(id) {
      expire();
      const launch = launches.get(id);
      if (closed || !launch) throw new Error('Browser launch is no longer active');
      try {
        const principal = core.grants.renew(launch.token);
        launch.deadline = clock() + heartbeatMs;
        return { expiresAt: principal.expiresAt };
      } catch { stop(id); throw new Error('Browser launch renewal failed'); }
    },
    stop,
    close() {
      closed = true; clearInterval(timer);
      for (const id of [...launches.keys()]) stop(id);
    },
  });
}
