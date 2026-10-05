// Shared command construction for the primary Openrind Shell FUSE runtime.
//
// The README deliberately requires a vendored OpenShell CLI and its paired
// gateway. Do not fall back to `openshell` on PATH: that can silently select a
// stock CLI which neither understands `--fuse` nor enforces the primary
// runtime's mount lifecycle.

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { ensureManagedFuseGateway } from "./fuse-gateway.mjs";
import { DISTRO_NAME, wslRun } from "./wsl.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIR, "../../../../../");
const SOURCE_CHECKOUT = existsSync(path.join(REPOSITORY_ROOT, "Dockerfile.openrind-shell"));

export const FUSE_IMAGE =
  process.env.OPENRIND_DESKTOP_SANDBOX_IMAGE?.trim() ||
  (SOURCE_CHECKOUT
    ? "openrind-shell-fuse:local"
    : "ghcr.io/openrind/openrind-shell/sandbox:fuse");

export const FUSE_IMAGE_PULL_POLICY =
  process.env.OPENRIND_DESKTOP_SANDBOX_PULL_POLICY?.trim() ||
  (FUSE_IMAGE === "openrind-shell-fuse:local" ? "Never" : "IfNotPresent");

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Resolve the exact control-plane variables documented for the primary FUSE
 * runtime. Both values must be available to the WSL process, not merely to
 * Electron on Windows, so callers must use buildFuseWslEnv when spawning it.
 */
export function resolveFuseRuntimeConfig(env = process.env) {
  const bin =
    env.OPENSHELL_BIN?.trim() ||
    "/opt/openrind-desktop/fuse-runtime/openshell";
  const gatewayEndpoint =
    env.OPENSHELL_GATEWAY_ENDPOINT?.trim() ||
    "http://127.0.0.1:18770";
  return { bin, gatewayEndpoint };
}

/**
 * Preserve the caller's WSLENV entries while forwarding the two primary FUSE
 * control-plane variables into the Linux process. Values are never embedded
 * in a command string.
 */
export function buildFuseWslEnv(extra = {}, env = process.env) {
  const { bin, gatewayEndpoint } = resolveFuseRuntimeConfig(env);
  const existing = String(env.WSLENV ?? "")
    .split(":")
    .filter(Boolean);
  const names = new Set([
    ...existing,
    "OPENSHELL_BIN",
    "OPENSHELL_GATEWAY_ENDPOINT",
    ...Object.keys(extra),
  ]);
  return {
    ...env,
    ...extra,
    OPENSHELL_BIN: bin,
    OPENSHELL_GATEWAY_ENDPOINT: gatewayEndpoint,
    WSLENV: [...names].join(":"),
  };
}

/**
 * Produce a shell-safe patched OpenShell CLI invocation. The caller is
 * responsible for adding `exec` only when it owns the complete shell process.
 */
export function buildFuseCliCommand(args, env = process.env) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("buildFuseCliCommand requires a string argument array");
  }
  const { bin, gatewayEndpoint } = resolveFuseRuntimeConfig(env);
  return [
    shellQuote(bin),
    "--gateway-endpoint",
    shellQuote(gatewayEndpoint),
    ...args.map(shellQuote),
  ].join(" ");
}

export async function ensureFuseRuntime(options = {}) {
  return ensureManagedFuseGateway(options);
}

export async function runFuseOpenShell(args, options = {}) {
  if (options.ensure !== false) {
    await ensureFuseRuntime({ onProgress: options.onProgress });
  }
  const { bin, gatewayEndpoint } = resolveFuseRuntimeConfig();
  return wslRun(
    ["-d", DISTRO_NAME, "--", bin, "--gateway-endpoint", gatewayEndpoint, ...args],
    options,
  );
}

export const __testing = {
  buildFuseCliCommand,
  buildFuseWslEnv,
  resolveFuseRuntimeConfig,
};
