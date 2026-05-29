# Mnemion Server

The Cloudflare Worker behind Mnemion — an agent-first web service with MCP and HTTP interfaces over one persistent, evolving memory.

For the full pitch, architecture, and the model (hive / pattern / entry / facet / link), see the [root README](../README.md) and [`CLAUDE.md`](../CLAUDE.md). This file covers worker-level dev only.

## Setup

```bash
npm install
```

## Run locally

```bash
npm run dev    # build:pages + wrangler dev on :8787 (dev mode, no secret)
```

Dev mode auto-approves OAuth (`Auth.DEV`) — no passkey or secret needed. MCP endpoint at `http://localhost:8787/mcp`.

For frontend-only iteration with mock data (no worker):

```bash
npm run preview
```

## Build & types

```bash
npm run build:pages   # main client + canvas client + SSR (required before dev/deploy)
npm run types         # regenerate worker-configuration.d.ts from wrangler.toml
```

## Test

```bash
npm test                              # full vitest suite (workerd via vitest-pool-workers)
npm run test:watch                    # watch mode
npx vitest run src/__tests__/x.test.ts   # single file
npx vitest run -t "name of test"         # by name
```

## Deploy

First-time setup (from repo root) generates the secret, provisions bindings, deploys, and prints the passkey-registration URL:

```bash
npm run setup
```

Subsequent code-only deploys (no secret rotation):

```bash
npm run deploy
```

## Tools (7)

Metadata is centralized in `src/tools.ts` (SSOT for MCP registration + `/api/tools`).

- `prime` — auto-associative recall: pass conversational context, get semantically-nearest entries + one-hop links.
- `resolve` — read anything by `mnemion://` URI (incl. federated cross-hive URIs and `https://` web fetches).
- `query` — filtered, sorted, paginated reads. Operators: `= != > < >= <= ~ |=` (IN-list). `count_only` mode.
- `search` — cross-pattern full-text search across text facets.
- `mutate` — create, update, patch, archive (batchable, atomic; optimistic locking).
- `propose_change` — propose schema evolution (preview, no commit).
- `apply_change` — commit a proposed change, or revert via point-in-time restore.

## Resources

- `mnemion://index` — master index
- `mnemion://schema/{pattern}` — facet definitions for a pattern
- `mnemion://entry/{pattern}/{id}` — a single entry
- `mnemion://history` — schema evolution history
- `mnemion://_system/{slug}` — agent-facing system docs
