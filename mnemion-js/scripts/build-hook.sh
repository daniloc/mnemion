#!/bin/bash
# wrangler [build] hook. The worker imports the MCP render fragment client
# bundle, so it's always built. The deploy-only work (provisioning Vectorize +
# building the React SPA) is skipped under DEV=1 so `wrangler dev` starts in ~1s
# with no network — Vite serves the SPA in dev.
set -e
cd "$(dirname "$0")/.."

npm run build:pages

if [ -z "$DEV" ]; then
  bash scripts/ensure-vectorize.sh
  npm run build:web
fi
