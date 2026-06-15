#!/bin/bash
set -e

cd "$(dirname "$0")/.."

# === Ensure wrangler is authenticated ===
# Subsequent wrangler calls run inside $(...) or pipes, which strips the TTY and makes
# wrangler refuse interactive OAuth login. Do the login check first, in a clean TTY.
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "Cloudflare login required. Opening browser..."
  npx wrangler login
fi

# === KV namespace ===
# No manual step: the OAUTH_KV binding in wrangler.toml has no id, so
# `wrangler deploy` (below) auto-provisions the namespace and links it. The
# resolved id is written back into wrangler.toml on a local deploy.

# === Vectorize index: find-or-create ===
VEC_NAME=$(awk '
  /^\[\[vectorize\]\]/ { in_vec=1; next }
  /^\[/ { in_vec=0 }
  in_vec && /^index_name *= *"/ { match($0, /"[^"]+"/); print substr($0, RSTART+1, RLENGTH-2); exit }
' wrangler.toml)

echo "Checking Vectorize index ${VEC_NAME}..."
if npx wrangler vectorize get "$VEC_NAME" >/dev/null 2>&1; then
  echo "  Already exists."
else
  echo "  Creating (768 dims, cosine — matches @cf/baai/bge-base-en-v1.5)..."
  npx wrangler vectorize create "$VEC_NAME" --dimensions=768 --metric=cosine
fi

# === R2 bucket: find-or-create ===
R2_NAME=$(awk '
  /^\[\[r2_buckets\]\]/ { in_r2=1; next }
  /^\[/ { in_r2=0 }
  in_r2 && /^bucket_name *= *"/ { match($0, /"[^"]+"/); print substr($0, RSTART+1, RLENGTH-2); exit }
' wrangler.toml)

if [ -n "$R2_NAME" ]; then
  echo "Checking R2 bucket ${R2_NAME}..."
  if npx wrangler r2 bucket info "$R2_NAME" >/dev/null 2>&1; then
    echo "  Already exists."
  else
    echo "  Creating..."
    npx wrangler r2 bucket create "$R2_NAME"
  fi
fi

# === Master secret ===
SECRET=$(openssl rand -hex 32)
echo ""
echo "Setting master secret..."
printf '%s' "$SECRET" | npx wrangler secret put MNEMION_SECRET 2>&1 | grep -v "^$"

# === Deploy ===
echo ""
echo "Deploying..."
TMPFILE=$(mktemp)
npx wrangler deploy 2>&1 | tee "$TMPFILE"

# Extract the workers.dev URL from deploy output
WORKER_URL=$(grep -o 'https://[^ ]*\.workers\.dev' "$TMPFILE" | head -1)
rm -f "$TMPFILE"

if [ -z "$WORKER_URL" ]; then
  echo ""
  echo "Could not detect worker URL from deploy output."
  echo "Your master secret has been set. Construct your setup URL manually:"
  echo "  https://<your-worker>.workers.dev/setup?token=$SECRET"
else
  SETUP_URL="${WORKER_URL}/setup?token=${SECRET}"
  echo ""
  echo "========================================="
  echo "  Register your passkey:"
  echo "  $SETUP_URL"
  echo "========================================="
  echo ""

  # Try to open in browser
  if command -v open &> /dev/null; then
    read -p "Open in browser now? [Y/n] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
      open "$SETUP_URL"
    fi
  fi
fi

echo ""
echo "This URL contains your master secret. Use it once to register, then discard."
echo "To reset: run this script again to generate a new secret and re-register."
