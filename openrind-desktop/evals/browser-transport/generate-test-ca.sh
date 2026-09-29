#!/bin/sh
# Ephemeral test-only CA, generated in the disposable run directory, never committed.
set -eu
umask 077
cd /run/browser-probe
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=Openrind-Transport-Test-CA \
  -keyout ca.key -out ca.crt >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj /CN=host.openshell.internal \
  -keyout server.key -out server.csr >/dev/null 2>&1
printf '%s\n' 'basicConstraints=critical,CA:FALSE' 'extendedKeyUsage=serverAuth' \
  'subjectAltName=DNS:host.openshell.internal' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 2 -extfile server.ext -out server.crt >/dev/null 2>&1
chmod 644 ca.crt
