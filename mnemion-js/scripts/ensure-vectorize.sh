#!/bin/bash
# Ensure the Vectorize index exists before deploy.
#
# Vectorize is the one binding Cloudflare does NOT auto-provision (it needs
# explicit dimensions + metric), and a deploy against a missing index fails. This
# runs from wrangler's [build] hook so it covers both one-click "Deploy to
# Cloudflare" installs (Workers Builds) and plain `wrangler deploy`.
#
# Idempotent and non-blocking: a cheap `get` first, create only if missing, and
# never fail the build (|| true) — a transient API hiccup shouldn't block deploy.

set +e
cd "$(dirname "$0")/.."

# Read the index name straight from wrangler.toml so this tracks the binding.
VEC_NAME=$(awk '
  /^\[\[vectorize\]\]/ { in_vec=1; next }
  /^\[/ { in_vec=0 }
  in_vec && /^index_name *= *"/ { match($0, /"[^"]+"/); print substr($0, RSTART+1, RLENGTH-2); exit }
' wrangler.toml)

[ -z "$VEC_NAME" ] && exit 0  # no Vectorize binding declared — nothing to do

if npx wrangler vectorize get "$VEC_NAME" >/dev/null 2>&1; then
  exit 0  # already exists — fast path on every rebuild/redeploy
fi

echo "Creating Vectorize index '$VEC_NAME' (768 dims, cosine — matches @cf/baai/bge-base-en-v1.5)..."
npx wrangler vectorize create "$VEC_NAME" --dimensions=768 --metric=cosine || true
exit 0
