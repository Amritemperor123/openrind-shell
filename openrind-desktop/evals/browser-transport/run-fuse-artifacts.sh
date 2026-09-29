#!/usr/bin/env bash
set -euo pipefail
umask 077
# Run inside the managed WSL distro. Input is a generated, verified staging
# directory containing flat provider artifacts and SHA256SUMS, never credentials.
: "${DATABASE_URL:?Disposable FUSE database configuration required}"
: "${OPENSHELL_GATEWAY_ENDPOINT:?Managed gateway required}"
source_dir="$(cd "$(dirname "$0")" && pwd)"
payload="${1:?Verified artifact staging directory required}"
test -s "$payload/SHA256SUMS"
# Default acceptance requires all three providers. A named partial rehearsal
# can validate available providers without claiming full Step 1 acceptance.
providers="${BROWSER_PROBE_PROVIDERS:-local-chromium browserbase desktop-webview}"
case "$providers" in 'local-chromium browserbase desktop-webview'|'local-chromium desktop-webview') ;; *) exit 2 ;; esac
expected=9
if [ "$providers" = 'local-chromium desktop-webview' ]; then expected=6; fi
test "$(wc -l < "$payload/SHA256SUMS")" -eq "$expected"
for provider in $providers; do
  for artifact in upload.txt download.txt screenshot.png; do
    test "$(grep -Ec "^[0-9a-f]{64}  $provider-$artifact$" "$payload/SHA256SUMS")" -eq 1
  done
done
(cd "$payload" && sha256sum -c SHA256SUMS >/dev/null)
bin="${OPENSHELL_BIN:-/opt/openrind-desktop/fuse-runtime/openshell}"
base="${OPENRIND_BROWSER_FUSE_IMAGE:-openrind-shell-fuse:local}"
run="bfa-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
image="$run:probe"
context="$(mktemp -d /tmp/browser-fuse-context-XXXXXX)"
db="$(mktemp /tmp/browser-fuse-db-XXXXXX)"
current=""
os() { "$bin" --gateway-endpoint "$OPENSHELL_GATEWAY_ENDPOINT" "$@"; }
cleanup() {
  code=$?
  set +e
  if [ -n "$current" ]; then os sandbox delete "$current" >/dev/null 2>&1 || code=1; fi
  docker image rm "$image" >/dev/null 2>&1 || code=1
  rm -f "$db"
  # context is a literal mktemp-created Linux directory owned by this run.
  rm -rf -- "$context"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
chmod 600 "$db"; printf '%s' "$DATABASE_URL" > "$db"
cp "$source_dir/fuse-artifact.c" "$context/"
cat > "$context/Dockerfile" <<'DOCKER'
ARG BASE=openrind-shell-fuse:local
FROM ${BASE}
USER root
COPY fuse-artifact.c /tmp/fuse-artifact.c
RUN cc -std=c11 -O2 -Wall -Wextra -Werror /tmp/fuse-artifact.c -o /usr/local/bin/browser-fuse-artifact && rm /tmp/fuse-artifact.c
DOCKER
docker build --build-arg "BASE=$base" -t "$image" "$context" >/dev/null
mkdir "$context/artifacts"
cp "$payload/"* "$context/artifacts/"
payload="$context/artifacts"
(cd "$payload" && sha256sum -c SHA256SUMS >/dev/null)
create() {
  current="$run-$1"
  os sandbox create --name "$current" --from "$image" --fuse \
    --env "OPENRIND_SHELL_WORKSPACE_ID=$run" --upload "$db:/sandbox/db-url" \
    --no-auto-providers --no-tty -- openrind-shell-init >/dev/null
}
create a
written=0
while read -r hash name <&3; do
  [[ "$hash" =~ ^[0-9a-f]{64}$ && "$name" =~ ^(local-chromium|browserbase|desktop-webview)-[a-z.]+$ ]] || exit 2
  os sandbox upload "$current" "$payload/$name" /tmp/browser-artifacts/ >/dev/null
  source_hash="$(os sandbox exec -n "$current" --no-tty -- sha256sum "/tmp/browser-artifacts/$name" </dev/null)"
  source_hash="$(printf '%s\n' "$source_hash" | tr -d '\r' | awk '{print $1}')"
  if [ "$source_hash" != "$hash" ]; then echo "FAIL uploaded source hash: $name ($source_hash)" >&2; exit 4; fi
  os sandbox exec -n "$current" --no-tty -- sh -c \
    'exec browser-fuse-artifact write "$1" "$2" < "/tmp/browser-artifacts/$2"' sh "$run" "$name" </dev/null >/dev/null
  saved_hash="$(os sandbox exec -n "$current" --no-tty -- sha256sum "/sandbox/work/$run/$name" </dev/null)"
  saved_hash="$(printf '%s\n' "$saved_hash" | tr -d '\r' | awk '{print $1}')"
  if [ "$saved_hash" != "$hash" ]; then echo "FAIL pre-replacement FUSE hash: $name ($saved_hash)" >&2; exit 4; fi
  written=$((written + 1))
done 3< "$payload/SHA256SUMS"
[ "$written" -eq "$expected" ]
# Negative confinement cases: never count denied writes as durability evidence.
if os sandbox exec -n "$current" --no-tty -- browser-fuse-artifact write "$run" ../escape </dev/null >/dev/null 2>&1; then exit 3; fi
os sandbox exec -n "$current" --no-tty -- ln -s /tmp "/sandbox/work/$run-link"
if os sandbox exec -n "$current" --no-tty -- browser-fuse-artifact write "$run-link" escape </dev/null >/dev/null 2>&1; then exit 3; fi
os sandbox delete "$current" >/dev/null; current=""
create b
verified=0
while read -r hash name <&3; do
  # Hash inside the replacement sandbox: SSH console output is not a binary
  # artifact channel and may translate newlines in PNG/text bytes.
  actual="$(os sandbox exec -n "$current" --no-tty -- bash -o pipefail -c \
    'browser-fuse-artifact read "$1" "$2" | sha256sum' bash "$run" "$name" </dev/null)"
  raw_hash="$actual"
  actual="$(printf '%s\n' "$actual" | tr -d '\r' | sed -n 's/^\([0-9a-f]\{64\}\)  -$/\1/p')"
  if [ "$actual" != "$hash" ]; then
    printf 'FAIL replacement hash: %s; expected=%s; actual=%q\n' "$name" "$hash" "$raw_hash" >&2
    exit 4
  fi
  verified=$((verified + 1))
done 3< "$payload/SHA256SUMS"
[ "$verified" -eq "$expected" ]
printf 'PASS artifact hashes survived FUSE sandbox replacement (%s); providers: %s\n' "$run" "$providers"
