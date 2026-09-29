#!/usr/bin/env bash
# Run inside the dedicated WSL distro. Uses ONLY uniquely named experiment resources.
set -euo pipefail
umask 077
cd "$(dirname "$0")"
OS_BIN="${OPENSHELL_BIN:-/opt/openrind-desktop/fuse-runtime/openshell}"
GATEWAY="${OPENSHELL_GATEWAY_ENDPOINT:-http://127.0.0.1:18770}"
os() { "$OS_BIN" --gateway-endpoint "$GATEWAY" "$@"; }
retry_cleanup() {
  # Sandbox deletion and provider detachment can settle asynchronously.
  for attempt in 1 2 3 4 5; do
    if timeout 5 "$OS_BIN" --gateway-endpoint "$GATEWAY" "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
test -f dist/client.cjs && test -f dist/probe.cjs && test -f dist/fixture.cjs
os sandbox list -o json >/dev/null
run_id="brp-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
image="openrind-browser-probe:$run_id"
fixture="$run_id-fixture"
profile_created=0
provider_created=0
external="${PROBE_EXTERNAL_FIXTURE:-0}"
negative="${PROBE_NEGATIVE:-}"
case "$negative" in ''|wrong-port|untrusted-ca|direct) ;; *) exit 2 ;; esac
if [ -n "$negative" ] && [ "$external" = 1 ]; then exit 2; fi
if [ "$negative" = untrusted-ca ]; then export PROBE_TLS=1; fi
if [ "$external" = 1 ] && [ "${PROBE_TLS:-0}" = 1 ]; then
  echo 'External Windows fixture test uses the private HTTP edge, not the TLS fixture mode' >&2
  exit 2
fi
scratch="$(mktemp -d /tmp/openrind-browser-probe-XXXXXX)"
# Guard cleanup targets before any recursive filesystem operation.
case "$(realpath "$scratch")" in /tmp/openrind-browser-probe-*) ;; *) exit 2 ;; esac
cleanup() {
  result=$?
  set +e
  container="$(docker ps -a --format '{{.Names}}' | grep -- "--$run_id-" | head -n 1 || true)"
  if [ -n "$container" ]; then
    # Emit only known diagnostic categories, never raw supervisor logs/credentials.
    docker logs "$container" > "$scratch/supervisor.log" 2>&1 || true
    awk 'NR==FNR { secret=$0; next } /18789|DENIED|denied|denying|rejected|forbidden|ERROR|WARN/ {
      gsub(secret, "[redacted]"); print substr($0, 1, 1000)
    }' "$scratch/token" "$scratch/supervisor.log" || true
  fi
  os sandbox delete "$run_id" >/dev/null 2>&1 || true
  if [ "$provider_created" = 1 ] && ! retry_cleanup provider delete "$run_id"; then
    echo "FAIL provider cleanup pending: $run_id" >&2
    result=1
  fi
  if [ "$profile_created" = 1 ] && ! retry_cleanup provider profile delete "$run_id"; then
    echo "FAIL provider profile cleanup pending: $run_id" >&2
    result=1
  fi
  if [ "$external" != 1 ]; then
    docker stop -t 5 "$fixture" >/dev/null 2>&1 || true
    docker logs "$fixture" > "$scratch/fixture.log" 2>/dev/null || true
    cat "$scratch/fixture.log"
    if [ "$negative" = wrong-port ] && ! grep -q '"otherFixtureAudit":{"calls":0,"cancelled":0,"deleted":0,"denied":0' "$scratch/fixture.log"; then
      echo 'FAIL denied-port listener audit missing or nonzero' >&2
      result=1
    fi
    expected='"calls":3,"cancelled":1,"deleted":2,"denied":0'
    if [ -n "$negative" ]; then expected='"calls":0,"cancelled":0,"deleted":0,"denied":0'; fi
    if [ "$result" = 0 ] && ! grep -q "$expected" "$scratch/fixture.log"; then
      echo 'FAIL fixture audit did not confirm calls, cancellation and both MCP teardowns' >&2
      result=1
    fi
    docker rm "$fixture" >/dev/null 2>&1 || true
  fi
  docker image rm "$image" >/dev/null 2>&1 || true
  if docker image inspect "$image" >/dev/null 2>&1; then
    echo "FAIL experiment image cleanup pending: $image" >&2
    result=1
  fi
  if docker ps -a --format '{{.Names}}' | grep -Eq "^$fixture$|--$run_id-"; then
    echo 'FAIL experiment container cleanup pending' >&2
    result=1
  fi
  rm -rf -- "$scratch"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
bridge="$(docker network inspect "${OPENSHELL_DOCKER_NETWORK:-openshell-docker}" --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')"
[[ "$bridge" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 2
if [ "$external" = 1 ]; then
  IFS= read -r test_token
  [[ "$test_token" =~ ^[a-f0-9]{64}$ ]] || exit 2
  printf '%s' "$test_token" > "$scratch/token"
  unset test_token
else
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$scratch/token"
fi
export OPENRIND_BROWSER_SERVICE_TOKEN="$(cat "$scratch/token")"
cat > "$scratch/profile.yaml" <<EOF
id: $run_id
display_name: Isolated browser transport probe
category: other
credentials:
  - name: service_token
    env_vars: [OPENRIND_BROWSER_SERVICE_TOKEN]
    required: true
    auth_style: bearer
    header_name: Authorization
discovery:
  credentials: [service_token]
endpoints:
  - host: host.openshell.internal
    port: 18789
    protocol: rest
    tls: none
    allowed_ips: ["$bridge/32"]
    enforcement: enforce
    rules:
      - allow: { method: POST, path: /mcp }
      - allow: { method: GET, path: /mcp }
      - allow: { method: DELETE, path: /mcp }
binaries: [/usr/local/bin/openrind-browser-spike]
EOF
# Clean Linux context avoids Windows metadata and never includes node_modules/secrets.
mkdir "$scratch/context" "$scratch/context/dist" "$scratch/context/tls"
cp Dockerfile launcher.c descriptor.json policy.yaml "$scratch/context/"
sed "s/BRIDGE_ADDRESS/$bridge/g" policy.yaml > "$scratch/context/policy.yaml"
cp dist/*.cjs "$scratch/context/dist/"
if [ "${PROBE_TLS:-0}" = 1 ]; then
  cp generate-test-ca.sh "$scratch/generate-test-ca.sh"
  docker run --rm --network none --entrypoint /bin/sh \
    --mount "type=bind,src=$scratch,dst=/run/browser-probe" \
    openrind-shell-fuse:local /run/browser-probe/generate-test-ca.sh
  if [ "$negative" != untrusted-ca ]; then cp "$scratch/ca.crt" "$scratch/context/tls/probe-ca.crt"; fi
  sed -i 's@http://@https://@' "$scratch/context/descriptor.json"
  sed -i 's/tls: none/tls: terminate/' "$scratch/context/policy.yaml" "$scratch/profile.yaml"
fi
if [ "$negative" = wrong-port ]; then sed -i 's/:18789/:18790/' "$scratch/context/descriptor.json"; fi
if [ "$negative" = direct ]; then sed -i 's/"requireProxy":true/"requireProxy":false/' "$scratch/context/descriptor.json"; fi
docker build --pull=false -q -t "$image" "$scratch/context"
os provider profile import --file "$scratch/profile.yaml" >/dev/null
profile_created=1
os provider create --name "$run_id" --type "$run_id" --credential OPENRIND_BROWSER_SERVICE_TOKEN >/dev/null
provider_created=1
unset OPENRIND_BROWSER_SERVICE_TOKEN
# Only the Docker bridge IP is bound, never 0.0.0.0 or the Windows LAN address.
if [ "$external" != 1 ]; then
 docker run -d --name "$fixture" --network host --entrypoint /usr/bin/node \
  --mount "type=bind,src=$scratch,dst=/run/browser-probe,readonly" \
  -e "PROBE_BIND_ADDRESS=$bridge" -e "PROBE_JSON=${PROBE_JSON:-0}" -e "PROBE_TLS=${PROBE_TLS:-0}" -e "PROBE_NEGATIVE=$negative" \
  "$image" /opt/openrind-browser-spike/fixture.cjs >/dev/null
for attempt in $(seq 1 30); do
  if docker logs "$fixture" 2>/dev/null | grep -q 'fixture ready'; then break; fi
  sleep 1
done
 docker logs "$fixture" 2>/dev/null | grep -q 'fixture ready'
fi
probe_args=()
if [ -n "$negative" ]; then probe_args+=(--negative); fi
if [ "$negative" = direct ]; then probe_args+=(--direct); fi
timeout 120 "$OS_BIN" --gateway-endpoint "$GATEWAY" sandbox create \
  --name "$run_id" --from "$image" --policy "$scratch/context/policy.yaml" --provider "$run_id" --no-auto-providers --no-tty \
  -- /usr/bin/node /opt/openrind-browser-spike/probe.cjs "${probe_args[@]}"
