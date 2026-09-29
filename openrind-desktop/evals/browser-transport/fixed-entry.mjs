import { fixedMain } from "./client.mjs";
fixedMain().catch((error) => {
  process.stderr.write("openrind-browser-spike: startup failed\n");
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
    const code = String(current.code ?? current.name ?? "unknown");
    if (/^[A-Za-z0-9_]{1,60}$/.test(code)) process.stderr.write(`diagnostic class: ${code}\n`);
    const proxyStatus = /Proxy response \((\d{3})\)/.exec(String(current.message));
    if (proxyStatus) process.stderr.write(`diagnostic class: PROXY_${proxyStatus[1]}\n`);
    for (const [pattern, label] of [[/timeout|timed out/i, "TIMEOUT"],
      [/proxy is required/i, "PROXY_MISSING"], [/Missing browser service credential/, "CREDENTIAL_MISSING"],
      [/Connection closed/i, "CONNECTION_CLOSED"], [/aborted/i, "ABORTED"],
      [/fetch failed/i, "FETCH_FAILED"]]) {
      if (pattern.test(String(current.message))) process.stderr.write(`diagnostic class: ${label}\n`);
    }
  }
  process.exitCode = 1;
});
