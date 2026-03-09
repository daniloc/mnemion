# Cambium Server

MCP server on Cloudflare Workers providing persistent, evolving shared memory between a human and their AI agents.

## Setup

```bash
npm install
```

## Run locally

```bash
npm run dev
```

Dev mode: no password needed. MCP endpoint at `http://localhost:8787/mcp`.

## Deploy

```bash
npx wrangler deploy
npx wrangler secret put CAMBIUM_SECRET   # set your password (one-time)
```

MCP endpoint at `https://<your-worker>.workers.dev/mcp`.

## Test

With the dev server running:

```bash
./test-vertical-slice.sh
```

## Tools

- `resolve(uri)` — read anything by `cambium://` address
- `query(object, ...)` — filtered, sorted reads with `count_only` mode
- `search(term)` — cross-object full-text search
- `mutate(object, operation, data)` — create, update, or archive records
- `propose_change(description, change)` — propose schema evolution
- `apply_change(change_id)` — commit a proposed change

## Resources

- `cambium://index` — master index
- `cambium://schema/{object}` — field definitions per object
- `cambium://history` — schema evolution history
- `cambium://records/{object}/{id}` — individual record
