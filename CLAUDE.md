# Mnemion

Persistent, evolving shared memory between a human and their AI agents. MCP server on Cloudflare Workers.

## Project structure

```
project-docs/active/   Design documents (the "why" and "what")
mnemion-js/            Cloudflare Worker — MCP server (the "how")
  src/index.ts         Entry point: OAuthProvider wrapper + route handling
  src/session.ts       SessionDO: McpAgent, MCP protocol handler (per-session DO)
  src/store.ts         StoreDO: per-user data storage (per-user DO, SQLite)
  src/passkey.ts       WebAuthn passkey registration + authentication
  src/constants.ts     Product identity (PRODUCT_NAME, URI_SCHEME, uri() helper)
  scripts/setup.sh     First-run setup: generates secret, deploys, opens passkey registration
```

Future peer: iOS app (Swift).

## Current state

Deployed to `https://your-worker.workers.dev/mcp`. Cross-surface data sharing proven (Claude Code + Claude.ai reading/writing the same store).

### Architecture

Two Durable Objects:
- **SessionDO** (`McpAgent`) — one per MCP session, handles protocol, proxies to store via RPC
- **StoreDO** — one per user, holds all SQLite data. Keyed by `user:{userId}` (currently always `"owner"`)

### Auth

Layered auth behind OAuth 2.1. The `workers-oauth-provider` package wraps the worker and handles the OAuth flow (DCR, tokens).

- **Master secret** (`MNEMION_SECRET`): High-entropy random hex, set via `npm run setup`. Root of trust — used to bootstrap passkeys and as fallback for headless agents. The user's Cloudflare login is the true credential; the secret is ephemeral and replaceable.
- **Passkey** (WebAuthn): Optional convenience layer for browser-based OAuth. Registered via one-time setup URL. Stored in StoreDO `_passkeys` table (single credential, replaced on re-registration). If registered, `/authorize` shows passkey-first UI with secret fallback.
- **No secret configured** = dev mode (auto-approves).

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
- **Auth**: `@cloudflare/workers-oauth-provider` (OAuth 2.1 + PKCE + DCR), `@simplewebauthn/server` for passkeys
- **Validation**: Zod for tool parameter schemas
- **Storage**: KV for OAuth tokens, DO SQLite for all user data

## Key conventions

- The `agents` package bundles its own `@modelcontextprotocol/sdk`. Pin the top-level dep to match (currently 1.26.0) to avoid type conflicts.
- McpAgent's base class has a `sql` tagged template property. Use `db` as the name for the raw `ctx.storage.sql` accessor in StoreDO.
- The DO binding must be named `MCP_OBJECT` — the `McpAgent.serve()` method expects this.
- `wrangler.toml` requires `compatibility_flags = ["nodejs_compat"]` for the agents package.
- Kernel columns (`id`, `created_at`, `updated_at`, `archived_at`) are auto-provided on every user table. They cannot be defined via `propose_change`.
- Structure is resources, operations are tools. If it describes what the organism is, it's a resource. If it changes what the organism is or retrieves dynamic content, it's a tool.
- Product name and URI scheme are defined in `src/constants.ts`. Import `PRODUCT_NAME`, `URI_SCHEME`, `uri()` from there — never hardcode `"mnemion://"` in source.
- `@simplewebauthn/server` is lazy-imported in index.ts to avoid `tslib` resolution issues in the vitest/workerd test environment.

## Development

```bash
cd mnemion-js
npm install
npm run dev          # local server on :8787 (dev mode, no secret needed)
```

## First-time setup

```bash
cd mnemion-js
npm run setup    # generates secret, deploys, prints passkey registration URL
```

This generates a 256-bit random master secret, sets it via wrangler, deploys, and opens the passkey registration page. Run again anytime to rotate the secret and re-register.

## Deploy

```bash
cd mnemion-js
npm run deploy   # deploy code changes (does not rotate secret)
```
