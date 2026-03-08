# Cambium Server

MCP server on Cloudflare Workers providing persistent, evolving shared memory between a human and their AI agents. See `project-docs/active/cambium-server.md` for the full design.

## Current state

Vertical slice: 3 of 8 MCP tools implemented.

- `get_index()` — read the master index (orientation)
- `propose_change()` — propose a structural change, get a preview
- `apply_change()` — commit a proposed change (creates SQLite tables, updates index)

No auth. No data tools (`query`, `mutate`, `search`) yet. No REST API.

## Setup

```bash
cd cambium-js
npm install
```

## Run locally

```bash
npm run dev
```

The MCP endpoint is at `http://localhost:8787/mcp`.

## Test

With the dev server running:

```bash
./test-vertical-slice.sh
```

This initializes an MCP session, reads the empty index, proposes a `tasks` object, applies it, and reads the index again to confirm the organism grew.

## Deploy

```bash
npm run deploy
```

Requires Cloudflare account auth via `wrangler login`.
