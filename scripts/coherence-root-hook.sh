#!/bin/sh
# Coherence is installed for mnemion-js, while host hooks start at the repo root.
# Its protocol carries a cwd as well as inheriting the process cwd.
cli=$1
shift
jq -c --arg cwd "$PWD" '.cwd = $cwd' | node "$cli" "$@"
