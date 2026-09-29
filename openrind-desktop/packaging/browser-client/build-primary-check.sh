#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
staging="$(mktemp -d /tmp/openrind-browser-build-XXXXXX)"
case "$(realpath "$staging")" in /tmp/openrind-browser-build-*) ;; *) exit 2 ;; esac
trap 'rm -rf -- "$staging"' EXIT
# Stage named build inputs onto Linux storage to avoid Windows xattr failures.
tar --exclude=node_modules --exclude=dist --exclude=target --exclude=__pycache__ \
  --exclude=.pytest_cache --exclude='.env*' --exclude=browser-runtime --exclude=runtime \
  -cf - Dockerfile.openrind-shell .dockerignore Cargo.toml Cargo.lock crates openeral-js \
  sandboxes/openeral .claude/skills openrind-desktop/packaging/browser-client \
  openrind-desktop/packages/browser-client openrind-desktop/packages/browser-contract \
  openrind-desktop/packages/browser-core openrind-desktop/packages/browser-providers \
  openrind-desktop/packages/browser-service | tar -xf - -C "$staging"
docker build --pull=false -f "$staging/Dockerfile.openrind-shell" -t openrind-shell-fuse:browser-step3 "$staging"
