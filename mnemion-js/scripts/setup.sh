#!/bin/bash
set -e

cd "$(dirname "$0")/.."

# Generate a 256-bit random secret (64 hex chars)
SECRET=$(openssl rand -hex 32)

echo "Setting master secret..."
printf '%s' "$SECRET" | npx wrangler secret put MNEMION_SECRET 2>&1 | grep -v "^$"

echo ""
echo "Deploying..."
# Stream deploy output to both terminal and temp file for URL extraction
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
