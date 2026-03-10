# Mnemion

Persistent, evolving shared memory between a human and their AI agents. MCP server on Cloudflare Workers.

## Project structure

```
project-docs/active/   Design documents (the "why" and "what")
mnemion-js/            Cloudflare Worker — MCP server (the "how")
  src/index.ts         Entry point: OAuthProvider wrapper + shared secret auth
  src/session.ts       SessionDO: McpAgent, MCP protocol handler (per-session DO)
  src/store.ts         StoreDO: per-user data storage (per-user DO, SQLite)
```

Future peer: iOS app (Swift).

## Current state

Deployed to `https://your-worker.workers.dev/mcp`. Cross-surface data sharing proven (Claude Code + Claude.ai reading/writing the same store).

### Architecture

Two Durable Objects:
- **SessionDO** (`McpAgent`) — one per MCP session, handles protocol, proxies to store via RPC
- **StoreDO** — one per user, holds all SQLite data. Keyed by `user:{userId}` (currently always `"owner"`)

### Auth

Shared secret behind OAuth 2.1. The `workers-oauth-provider` package wraps the worker and handles the OAuth flow (DCR, tokens). The identity provider is a single password stored as a Cloudflare Workers secret (`MNEMION_SECRET`). No secret configured = dev mode (auto-approves).

### Resources (stable, cacheable, subscribable)

- `mnemion://index` — master index
- `mnemion://schema/{object_name}` — per-object field definitions
- `mnemion://history` — schema evolution history (supports `?limit=N`)
- `mnemion://records/{object}/{id}` — individual record by URI

### Tools (6 total)

- `resolve` — read anything by `mnemion://` URI (escape hatch for platforms without resource support)
- `query` — filtered, sorted, paginated reads (supports `count_only` mode)
- `search` — cross-object full-text search across text fields
- `mutate` — create, update, or archive records
- `propose_change` — propose schema evolution (preview, no commit)
- `apply_change` — commit proposed change (fires resource update notifications)

### Internal tables

- `_index` — curated JSON document describing what exists (single row)
- `_schema_history` — log of all schema changes
- `_pending_changes` — proposed but uncommitted changes

## Tech stack

- **Runtime**: Cloudflare Workers + Durable Objects (SQLite storage)
- **MCP**: `agents` npm package (`McpAgent` class), `@modelcontextprotocol/sdk`
- **Auth**: `@cloudflare/workers-oauth-provider` (OAuth 2.1 + PKCE + DCR)
- **Validation**: Zod for tool parameter schemas
- **Storage**: KV for OAuth tokens, DO SQLite for all user data

## Key conventions

- The `agents` package bundles its own `@modelcontextprotocol/sdk`. Pin the top-level dep to match (currently 1.26.0) to avoid type conflicts.
- McpAgent's base class has a `sql` tagged template property. Use `db` as the name for the raw `ctx.storage.sql` accessor in StoreDO.
- The DO binding must be named `MCP_OBJECT` — the `McpAgent.serve()` method expects this.
- `wrangler.toml` requires `compatibility_flags = ["nodejs_compat"]` for the agents package.
- Kernel columns (`id`, `created_at`, `updated_at`, `archived_at`) are auto-provided on every user table. They cannot be defined via `propose_change`.
- Structure is resources, operations are tools. If it describes what the organism is, it's a resource. If it changes what the organism is or retrieves dynamic content, it's a tool.

## Development

```bash
cd mnemion-js
npm install
npm run dev          # local server on :8787 (dev mode, no secret needed)
```

## Deploy

```bash
cd mnemion-js
npx wrangler deploy
npx wrangler secret put MNEMION_SECRET   # set your password (one-time)
```
