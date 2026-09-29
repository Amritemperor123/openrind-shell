#!/bin/bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
os() { /opt/openrind-desktop/fuse-runtime/openshell --gateway-endpoint http://127.0.0.1:18770 "$@"; }
run_id="bsc-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
scratch="$(mktemp -d /tmp/openrind-step3-XXXXXX)"
image="openrind-browser-step3:$run_id"
cleanup() {
  os sandbox delete "$run_id" >/dev/null 2>&1 || true
  os provider delete "$run_id" >/dev/null 2>&1 || true
  os provider profile delete "$run_id" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  case "$scratch" in /tmp/openrind-step3-*) rm -rf -- "$scratch" ;; esac
}
trap cleanup EXIT
read -r OPENRIND_BROWSER_SERVICE_TOKEN
export OPENRIND_BROWSER_SERVICE_TOKEN
read -r grant
printf %s "$grant" > "$scratch/grant"
unset grant
bridge="$(docker network inspect openshell-docker --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')"
cp dist/native-check.cjs "$scratch/"
sed -e "s/BRIDGE_ADDRESS/$bridge/g" -e 's/openrind-browser-spike/openrind-browser-client/g' \
  ../../evals/browser-transport/policy.yaml > "$scratch/policy.yaml"
printf '%s\n' '{"protocol":1,"endpoint":"http://host.openshell.internal:18789/mcp","requireProxy":true}' > "$scratch/descriptor.json"
cat > "$scratch/Dockerfile" <<'EOF'
FROM openrind-shell-fuse:browser-step3
USER root
COPY native-check.cjs /opt/openrind-browser/
COPY descriptor.json /tmp/browser-descriptor.json
RUN /usr/bin/node /opt/openrind-browser/provision.cjs < /tmp/browser-descriptor.json
COPY policy.yaml /etc/openshell/policy.yaml
RUN chmod 755 /etc/openrind-browser /opt/openrind-browser /usr/local/bin/openrind-browser-client && chmod 644 /etc/openrind-browser/descriptor.json /opt/openrind-browser/*
EOF
cat > "$scratch/profile.yaml" <<EOF
id: $run_id
display_name: Browser Step 3 validation
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
binaries: [/usr/local/bin/openrind-browser-client]
EOF
os provider profile import --file "$scratch/profile.yaml" >/dev/null
os provider create --name "$run_id" --type "$run_id" --credential OPENRIND_BROWSER_SERVICE_TOKEN >/dev/null
unset OPENRIND_BROWSER_SERVICE_TOKEN
docker build --pull=false -q -t "$image" "$scratch" >/dev/null
cat > "$scratch/check.sh" <<'EOF'
#!/bin/sh
set -eu
export OPENRIND_BROWSER_GRANT="$(cat /sandbox/browser-grant)"
node /opt/openrind-browser/native-check.cjs
# The mcp subcommand reads persisted scopes, not the agent-only --mcp-config
# flag. Use a disposable HOME containing the identical fixed server entry.
export HOME="$(mktemp -d /tmp/openrind-claude-XXXXXX)"
cp /opt/openrind-browser/mcp.json "$HOME/.claude.json"
/usr/local/bin/claude-real mcp list >/tmp/browser-discovery.txt 2>&1 || {
  head -c 2000 /tmp/browser-discovery.txt; exit 1;
}
grep -q 'openrind-browser.*Connected' /tmp/browser-discovery.txt || { head -c 2000 /tmp/browser-discovery.txt; exit 1; }
echo 'PASS actual claude-real discovers the production browser MCP server'
EOF
timeout 90 /opt/openrind-desktop/fuse-runtime/openshell --gateway-endpoint http://127.0.0.1:18770 sandbox create \
  --name "$run_id" --from "$image" --policy "$scratch/policy.yaml" --provider "$run_id" --no-auto-providers --no-tty \
  --upload "$scratch/grant:/sandbox/browser-grant" --upload "$scratch/check.sh:/sandbox/browser-check.sh" \
  -- /bin/sh /sandbox/browser-check.sh
