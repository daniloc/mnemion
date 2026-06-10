#!/bin/bash
# Enable the document store: create the R2 bucket and uncomment its binding.
#
# The only thing you must do by hand is enable R2 on the account once
# (Cloudflare dashboard → Storage & databases → R2) — that's an account-level
# toggle no CLI can flip. Everything else (bucket creation, wiring the binding)
# this script does for you. Re-runnable; redeploy afterward with `npm run deploy`.
set -e

cd "$(dirname "$0")/.."

BUCKET="mnemion-documents"

echo "Creating R2 bucket ${BUCKET} (if it doesn't exist)..."
CREATE_LOG=$(mktemp)
set +e
npx wrangler r2 bucket create "$BUCKET" >"$CREATE_LOG" 2>&1
RC=$?
set -e

if [ $RC -ne 0 ] && ! grep -qi "already" "$CREATE_LOG"; then
  if grep -qi "enable R2\|10042" "$CREATE_LOG"; then
    echo ""
    echo "R2 is not enabled on your Cloudflare account yet."
    echo "Enable it once in the dashboard → Storage & databases → R2, then re-run:"
    echo "  npm run enable-documents"
    rm -f "$CREATE_LOG"
    exit 1
  fi
  echo "Failed to create the bucket:"
  cat "$CREATE_LOG"
  rm -f "$CREATE_LOG"
  exit 1
fi
rm -f "$CREATE_LOG"
echo "  Bucket ready."

# Uncomment the default [[r2_buckets]] block (the one for ${BUCKET}, leaving the
# env.test block alone). Idempotent: a no-op once the block is already active.
echo "Wiring the DOCUMENTS binding in wrangler.toml..."
awk '
  /^# \[\[r2_buckets\]\]$/ {
    print substr($0, 3); getline; print substr($0, 3); getline; print substr($0, 3); next
  }
  { print }
' wrangler.toml > wrangler.toml.tmp && mv wrangler.toml.tmp wrangler.toml

echo ""
echo "Document store enabled. Redeploy to activate it:"
echo "  npm run deploy"
