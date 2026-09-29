#!/usr/bin/env bash
set -euo pipefail
umask 077
here="$(cd "$(dirname "$0")" && pwd)"
payload="${1:?Verified staging directory required}"
scratch="$(mktemp -d /tmp/browser-local-db-XXXXXX)"
name="blf-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
image="$name:tls"
cleanup() {
  code=$?; set +e
  docker rm -fv "$name" >/dev/null 2>&1
  docker image rm "$image" >/dev/null 2>&1
  case "$scratch" in /tmp/browser-local-db-*) rm -rf -- "$scratch" ;; esac
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
# The native CLI tar reader must use Linux files, not Windows-mounted files.
# Verify again after copying so a mount/transfer fault cannot look like FUSE loss.
mkdir "$scratch/artifacts"
cp "$payload/"* "$scratch/artifacts/"
(cd "$scratch/artifacts" && sha256sum -c SHA256SUMS >/dev/null)
bridge="$(docker network inspect openshell-docker --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')"
[[ "$bridge" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
cp "$here/../../../tests/fuse/postgres-fixture/gen-certs.sh" "$scratch/"
docker run --rm --network none --user "$(id -u):$(id -g)" --entrypoint bash -e "FIXTURE_DB_HOST=$bridge" \
  --mount "type=bind,src=$scratch,dst=/fixture" openrind-shell-fuse:local /fixture/gen-certs.sh >/dev/null
head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$scratch/password"
printf 'POSTGRES_PASSWORD=%s\n' "$(cat "$scratch/password")" > "$scratch/db.env"
docker run -d --name "$name" --env-file "$scratch/db.env" -p "$bridge::5432" \
  --mount "type=bind,src=$scratch/certs,dst=/fixture-certs,readonly" \
  --entrypoint sh postgres:16-alpine -c 'cp /fixture-certs/server.crt /tmp/server.crt; cp /fixture-certs/server.key /tmp/server.key; chown postgres:postgres /tmp/server.*; chmod 600 /tmp/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key' >/dev/null
port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$name")"
[[ "$port" =~ ^[0-9]+$ ]]
ready=0
for attempt in $(seq 1 30); do
  if docker exec "$name" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ]
cp "$here/../../../tests/fuse/Dockerfile.local-postgres" "$scratch/context/Dockerfile"
docker build --pull=false --build-arg BASE_IMAGE=openrind-shell-fuse:local \
  --build-arg "OPENERAL_TEST_DB_HOST=$bridge" --build-arg "OPENERAL_TEST_DB_PORT=$port" \
  -t "$image" "$scratch/context" >/dev/null
export DATABASE_URL="postgresql://postgres:$(cat "$scratch/password")@$bridge:$port/postgres"
export OPENSHELL_GATEWAY_ENDPOINT="${OPENSHELL_GATEWAY_ENDPOINT:-http://127.0.0.1:18770}"
export OPENRIND_BROWSER_FUSE_IMAGE="$image"
bash "$here/run-fuse-artifacts.sh" "$scratch/artifacts"
