// Main-process lifecycle helper. A detached UI does not end a live PTY lease.
// The caller must stop it on PTY exit, launch failure or sandbox deletion.
export async function createBrowserPtyLease(runtime, scope, policy, { onLost = () => {} } = {}) {
  const issued = await runtime.beginLaunch(scope, policy);
  let stopped = false;
  let active = false;
  let renewing = false;
  let timer;
  let cleanup;
  const stop = () => {
    if (cleanup) return cleanup;
    stopped = true; clearInterval(timer);
    cleanup = runtime.stopLaunch(issued.launchId).catch(error => { cleanup = undefined; throw error; });
    return cleanup;
  };
  // Startup also has a deadline; a caller cannot retain a grant indefinitely
  // without actually attaching it to a live terminal process.
  const startupTimer = setTimeout(() => { void stop().catch(() => {}); }, 20_000);
  startupTimer.unref();
  return Object.freeze({ token: issued.token,
    activate() {
      if (stopped) throw new Error('Browser launch lease expired before PTY startup');
      if (active) return;
      active = true; clearTimeout(startupTimer);
      timer = setInterval(() => {
        if (stopped || renewing) return;
        renewing = true;
        void runtime.heartbeat(issued.launchId).catch(async () => {
          await stop().catch(() => {});
          try { onLost(); } catch { /* The grant has already been revoked. */ }
        }).finally(() => { renewing = false; });
      }, 10_000);
      timer.unref();
    },
    stop() { clearTimeout(startupTimer); return stop(); },
  });
}
