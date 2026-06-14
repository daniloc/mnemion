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

# Worker name and current KV id from wrangler.toml (top-level / production env)
WORKER_NAME=$(awk -F'"' '/^name = / {print $2; exit}' wrangler.toml)
CURRENT_KV_ID=$(awk '
  /^\[\[kv_namespaces\]\]/ { in_kv=1; next }
  /^\[/ { in_kv=0 }
  in_kv && /^id *= *"/ { match($0, /"[^"]+"/); print substr($0, RSTART+1, RLENGTH-2); exit }
' wrangler.toml)
EXPECTED_KV_TITLE="${WORKER_NAME}-OAUTH_KV"

# === KV namespace: find-or-create, patch wrangler.toml ===
echo "Checking KV namespace ${EXPECTED_KV_TITLE}..."

# Wrangler may print banner/warning lines around the JSON — extract the JSON array defensively.
LIST_RAW=$(npx wrangler kv namespace list 2>&1 || true)
EXISTING_KV_ID=$(node -e "
  const raw = process.argv[1];
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end < 0) process.exit(0);
  try {
    const data = JSON.parse(raw.slice(start, end + 1));
    const ns = data.find(n => n && n.title === process.argv[2]);
    if (ns) process.stdout.write(ns.id);
  } catch (e) {}
" "$LIST_RAW" "$EXPECTED_KV_TITLE")

if [ -n "$EXISTING_KV_ID" ]; then
  NEW_KV_ID="$EXISTING_KV_ID"
  echo "  Found existing: $NEW_KV_ID"
else
  echo "  Creating..."
  CREATE_LOG=$(mktemp)
  # Don't let a non-zero exit (e.g. "already exists") kill the script silently — inspect output instead.
  set +e
  npx wrangler kv namespace create OAUTH_KV 2>&1 | tee "$CREATE_LOG"
  CREATE_RC=${PIPESTATUS[0]}
  set -e
  NEW_KV_ID=$(grep -oE 'id *= *"[a-f0-9]+"' "$CREATE_LOG" | head -1 | sed 's/.*"\([a-f0-9]*\)".*/\1/')
  rm -f "$CREATE_LOG"
  if [ -z "$NEW_KV_ID" ]; then
    echo ""
    echo "Could not create or detect KV namespace ${EXPECTED_KV_TITLE} (wrangler exit $CREATE_RC)."
    echo "If the namespace already exists, run 'npx wrangler kv namespace list' and paste its id"
    echo "into the [[kv_namespaces]] block of wrangler.toml, then re-run setup."
    exit 1
  fi
fi

if [ "$NEW_KV_ID" != "$CURRENT_KV_ID" ]; then
  echo "  Patching wrangler.toml: $CURRENT_KV_ID -> $NEW_KV_ID"
  # Replace only the FIRST occurrence — the [env.test] block may share the same
  # "REPLACE_ME" placeholder, and setup.sh only provisions the production namespace.
  awk -v old="$CURRENT_KV_ID" -v new="$NEW_KV_ID" '
    !done && index($0, old) { sub(old, new); done=1 }
    { print }
  ' wrangler.toml > wrangler.toml.tmp && mv wrangler.toml.tmp wrangler.toml
fi

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
