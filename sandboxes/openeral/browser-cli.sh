#!/bin/sh
base="$(basename "$0")"
export OPENRIND_BROWSER_BIN="$base"
exec /usr/bin/node /opt/openrind-browser/cli.cjs "$@"
