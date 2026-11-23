#!/bin/sh
set -eu
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
export PATH
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$base/app/cli.js" install "$@"
