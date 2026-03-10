# Mnemion

Persistent, evolving shared memory between a human and their AI agents. MCP server on Cloudflare Workers.

## Project structure

```
project-docs/active/   Design documents (the "why" and "what")
mnemion-js/            Cloudflare Worker — MCP server (the "how")
  src/index.ts         Route table + OAuthProvider config (~60 lines)
  src/router.ts        Declarative router: types, enums, pattern matching, dispatch
  src/routes/auth.ts   /authorize, /auth/verify, passkey setup & authentication
  src/routes/io.ts     /o/:path egress, /i/:path ingress, /upload/:token
  src/routes/marketplace.ts  Dev seed, token management, git endpoints
  src/session.ts       SessionDO: McpAgent, MCP protocol handler (per-session DO)
  src/store.ts         StoreDO: per-user data storage (per-user DO, SQLite)
  src/passkey.ts       WebAuthn passkey registration + authentication
  src/transform.ts     Transform DSL evaluator for ingress field mapping
  src/constants.ts     Product identity (PRODUCT_NAME, URI_SCHEME, uri() helper)
  src/system-docs/     Markdown files with {{placeholder}} syntax, loaded at runtime
  src/text.d.ts        Type declaration for .md text imports
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

### Vocabulary

Mnemion uses biological vocabulary at every layer — API parameters, URIs, JSON response keys, and docs: **hive** (the whole store), **pattern** (organizing structure), **entry** (instance within a pattern), **facet** (dimension of an entry), **link** (connection between entries). Internal SQL tables (`_objects`, `_fields`) keep implementation names but are never exposed to agents.

### Resources (stable, cacheable, subscribable)

- `mnemion://index` — master index
- `mnemion://schema/{pattern_name}` — facet definitions for a pattern
- `mnemion://history` — schema evolution history (supports `?limit=N`)
- `mnemion://entry/{pattern}/{id}` — individual entry by URI

### Tools (6 total)

- `resolve` — read anything by `mnemion://` URI (escape hatch for platforms without resource support)
- `query` — filtered, sorted, paginated reads (supports `count_only` mode)
- `search` — cross-pattern full-text search across text facets
- `mutate` — create, update, or archive entries
- `propose_change` — propose schema evolution (preview, no commit)
- `apply_change` — commit proposed change (fires resource update notifications)

### HTTP I/O

Agent-defined HTTP endpoints, configured as entries:
- **Egress** (`_outputs`): `GET /o/{path}` — serve content at arbitrary paths with configurable MIME type and visibility
- **Ingress** (`_inputs`): `POST /i/{path}` — accept inbound data, create entries in target patterns with optional transform DSL

### Internal tables

- `_schema_history` — log of all schema changes
- `_pending_changes` — proposed but uncommitted changes
- `_outputs` / `_inputs` — HTTP I/O endpoint definitions
- `_auth_codes` — one-time bearer tokens for remote agents
- `_system_docs` — agent orientation docs (seeded from `src/system-docs/*.md`)

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
- Kernel columns (`id`, `created_at`, `updated_at`, `archived_at`) are auto-provided on every pattern. They cannot be defined via `propose_change`.
- Structure is resources, operations are tools. If it describes what the organism is, it's a resource. If it changes what the organism is or retrieves dynamic content, it's a tool.
- Product name and URI scheme are defined in `src/constants.ts`. Import `PRODUCT_NAME`, `URI_SCHEME`, `uri()` from there — never hardcode `"mnemion://"` in source.
- `@simplewebauthn/server` is lazy-imported in `routes/auth.ts` to avoid `tslib` resolution issues in the vitest/workerd test environment.
- System docs live in `src/system-docs/*.md` with YAML frontmatter (`slug`, `title`). Placeholders (`{{PRODUCT_NAME}}`, `{{uri:path}}`) are resolved at runtime by `resolveDocPlaceholders()` in store.ts.
- `wrangler.toml` has a `[[rules]]` entry to import `.md` files as text modules.

## Design principle: code as schematic

Structure code as declarative, scannable tables — not procedural chains. A reader should grasp the system's shape from the declarations alone, without tracing control flow. Enums for categories, typed records for configuration, implementation in focused single-purpose files.

The route table in `index.ts` is the reference example: method, pattern, auth gate, and handler on one line per route. The full routing surface is visible in 15 lines.

## Router architecture

Declarative dispatch table in `src/router.ts`. Routes are matched in declaration order.

- **`Method`** enum: `GET`, `POST`, `ANY`
- **`Auth`** enum: `NONE` (default), `DEV` (no secret configured), `CONFIGURED` (secret required to exist), `SECRET` (Basic auth against master secret)
- **`where`** constraints: regex validation on extracted params (e.g. `{ token: /^[a-fA-F0-9]+$/ }`)
- **`RouteContext`**: `request`, `url`, `env`, `params`, `store` — passed to every handler

Route handlers are grouped by domain in `src/routes/`. OAuthProvider intercepts `/mcp`, `/token`, `/register` before the dispatch table runs.

## Next milestone: Svelte frontend

- **Keep the worker as the server** — no SvelteKit. The routing, auth, and data layers stay hand-built.
- **Use Svelte as a component framework** for rendering pages (schema viewer, data browser, etc.)
- First page: schema viewer.

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
