# Mnemion

Persistent, evolving shared memory between a human and their AI agents. MCP server on Cloudflare Workers.

## Project structure

```
project-docs/active/   Design documents (the "why" and "what")
mnemion-js/            Cloudflare Worker — MCP server (the "how")
  src/index.ts         Route table + OAuthProvider config (~60 lines)
  src/router.ts        Declarative router: types, enums, pattern matching, dispatch
  src/routes/auth.ts   /authorize, /auth/verify, passkey setup & authentication
  src/routes/io.ts     /o/entry/:pattern/:id shared entries, /o/:path egress, /i/:path ingress, /upload/:token
  src/routes/marketplace.ts  Token management, git endpoints (composes query + git adapter)
  src/routes/dev.ts    Dev-only seed routes (Auth.DEV gated, inert in production)
  src/routes/pages.ts  Svelte SSR pages, /api/* JSON endpoints, WebSocket proxy
  src/session.ts       SessionDO: McpAgent, MCP protocol handler (per-session DO)
  src/hive.ts          HiveDO: DO shell — RPC wrappers, URI resolution, federation, WebSocket
  src/data.ts          Query engine, mutation engine (CRUD), cross-pattern search
  src/evolution.ts     Schema evolution: CHANGE_TYPES declaration table, propose/apply/revert
  src/credentials.ts   Passkey CRUD, access token validation
  src/kernel.ts        Pre-mutation hooks, immutable fields, scope matching
  src/schema.ts        DDL, migrations, kernel table declarations, system doc seeding
  src/passkey.ts       WebAuthn passkey registration + authentication
  src/transform.ts     Transform DSL evaluator for ingress field mapping
  src/git.ts           Git protocol adapter (file tree → git pack, used by marketplace)
  src/constants.ts     Product identity (PRODUCT_NAME, URI_SCHEME, uri() helper)
  src/system-docs/     Markdown files with {{placeholder}} syntax, loaded at runtime
  src/pages/           Svelte components (SchemaViewer, HiveMap, LinkMap) + SSR entry points
  scripts/setup.sh     First-run setup: generates secret, deploys, opens passkey registration
```

Future peer: iOS app (Swift).

## Current state

Deployed to `https://your-worker.workers.dev/mcp`. Cross-surface data sharing proven (Claude Code + Claude.ai reading/writing the same store).

### Architecture

Two Durable Objects:
- **SessionDO** (`McpAgent`) — one per MCP session, handles protocol, proxies to hive via RPC
- **HiveDO** — one per user, holds all SQLite data. Keyed by `user:{userId}` (currently always `"owner"`)

HiveDO is a thin wiring shell. Domain logic lives in pure-function modules with `db`/context injected:
- **`data.ts`** — query, mutate, search (DataContext)
- **`evolution.ts`** — schema evolution via `CHANGE_TYPES` declaration table (EvolutionContext)
- **`credentials.ts`** — passkey + token operations (db)
- **`kernel.ts`** — pre-mutation hooks, immutable fields, scope matching
- **`schema.ts`** — DDL, migrations, kernel table declarations, audit triggers

### Auth

Layered auth behind OAuth 2.1. The `workers-oauth-provider` package wraps the worker and handles the OAuth flow (DCR, tokens).

- **Master secret** (`MNEMION_SECRET`): High-entropy random hex, set via `npm run setup`. Root of trust — used to bootstrap passkeys and as fallback for headless agents. The user's Cloudflare login is the true credential; the secret is ephemeral and replaceable.
- **Passkey** (WebAuthn): Optional convenience layer for browser-based OAuth. Registered via one-time setup URL. Stored in HiveDO `_passkeys` table (single credential, replaced on re-registration). If registered, `/authorize` shows passkey-first UI with secret fallback.
- **Access tokens** (`_access_tokens`): Scoped bearer tokens for remote agents, uploads, marketplace, and federated access. Created via `mutate`. Scope matching is hierarchical prefix-based.
- **No secret configured** = dev mode (auto-approves).

### Vocabulary

Mnemion uses biological vocabulary at every layer — API parameters, URIs, JSON response keys, and docs: **hive** (the whole store), **pattern** (organizing structure), **entry** (instance within a pattern), **facet** (dimension of an entry), **link** (connection between entries). Internal SQL tables (`_objects`, `_fields`) keep implementation names but are never exposed to agents.

### Resources (stable, cacheable, subscribable)

- `mnemion://index` — master index
- `mnemion://schema/{pattern_name}` — facet definitions for a pattern
- `mnemion://history` — schema evolution history (supports `?limit=N`)
- `mnemion://entry/{pattern}/{id}` — individual entry by URI

### Tools (6 total)

- `resolve` — read anything by `mnemion://` URI, including federated cross-hive URIs (escape hatch for platforms without resource support)
- `query` — filtered, sorted, paginated reads (supports `count_only` mode)
- `search` — cross-pattern full-text search across text facets
- `mutate` — create, update, or archive entries
- `propose_change` — propose schema evolution (preview, no commit)
- `apply_change` — commit proposed change (fires resource update notifications)

### HTTP I/O & Federation

Agent-defined HTTP endpoints, configured as entries:
- **Shared entries** (`_shared`): `GET /o/entry/{pattern}/{id}` — serve entries marked public or unlisted
- **Egress** (`_outputs`): `GET /o/{path}` — serve agent-constructed content at arbitrary paths
- **Ingress** (`_inputs`): `POST /i/{path}` — accept inbound data, create entries in target patterns with optional transform DSL

**Federation**: `resolve` recognizes foreign URIs by a dot in the first path segment (hostname). `mnemion://other.hive.dev/entry/axioms/7` → `GET https://other.hive.dev/o/entry/axioms/7`. Private access via `?token=<auth_code>` → Bearer header. Public responses edge-cached. No federation protocol — sovereign hives, voluntary connections.

### Entry sharing

Entry-level visibility via the `_shared` kernel pattern. Controlled through `propose_change` with `set_sharing` type:
- **public** — openly readable at `/o/entry/{pattern}/{id}`, edge-cached
- **unlisted** — readable with valid access token (anyone-with-the-link)
- **private** — not served (default; removes sharing)

### Access tokens

Unified `_access_tokens` kernel pattern (replaced `_auth_codes`, `_upload_tokens`, `_marketplace_tokens`). Hierarchical scope matching via `scopeMatches()` (kernel.ts, re-exported by credentials.ts):
- `*` — full access (OAuth, session login, all reads/writes)
- `read` — read any shared entry or output (matches `read:entry:axioms:7`)
- `upload` — write via `/upload/{token}` (constraints JSON: `{target_pattern, target_id, target_facet, mode}`)
- `marketplace` — private marketplace git access (constraints JSON: `{plugins: [...]}`)

### Internal tables

- `_schema_history` — log of all schema changes
- `_pending_changes` — proposed but uncommitted changes
- `_access_tokens` — unified scoped access tokens
- `_shared` — entry-level sharing for HTTP access
- `_outputs` / `_inputs` — HTTP I/O endpoint definitions
- `_system_docs` — agent orientation docs (seeded from `src/system-docs/*.md`)

## Tech stack

- **Runtime**: Cloudflare Workers + Durable Objects (SQLite storage)
- **MCP**: `agents` npm package (`McpAgent` class), `@modelcontextprotocol/sdk`
- **Auth**: `@cloudflare/workers-oauth-provider` (OAuth 2.1 + PKCE + DCR), `@simplewebauthn/server` for passkeys
- **Validation**: Zod for tool parameter schemas
- **Storage**: KV for OAuth tokens, DO SQLite for all user data

## Key conventions

- The `agents` package bundles its own `@modelcontextprotocol/sdk`. Pin the top-level dep to match (currently 1.26.0) to avoid type conflicts.
- McpAgent's base class has a `sql` tagged template property. Use `db` as the name for the raw `ctx.storage.sql` accessor in HiveDO.
- The DO binding must be named `MCP_OBJECT` — the `McpAgent.serve()` method expects this.
- `wrangler.toml` requires `compatibility_flags = ["nodejs_compat"]` for the agents package.
- Kernel columns (`id`, `created_at`, `updated_at`, `archived_at`) are auto-provided on every pattern. They cannot be defined via `propose_change`.
- Structure is resources, operations are tools. If it describes what the organism is, it's a resource. If it changes what the organism is or retrieves dynamic content, it's a tool.
- Product name and URI scheme are defined in `src/constants.ts`. Import `PRODUCT_NAME`, `URI_SCHEME`, `uri()` from there — never hardcode `"mnemion://"` in source.
- `@simplewebauthn/server` is lazy-imported in `routes/auth.ts` to avoid `tslib` resolution issues in the vitest/workerd test environment.
- System docs live in `src/system-docs/*.md` with YAML frontmatter (`slug`, `title`). Placeholders (`{{PRODUCT_NAME}}`, `{{uri:path}}`) are resolved at runtime by `resolveDocPlaceholders()` in schema.ts.
- `wrangler.toml` has a `[[rules]]` entry to import `.md` files as text modules.

## Design principle: code as schematic

Structure code as declarative, scannable tables — not procedural chains. A reader should grasp the system's shape from the declarations alone, without tracing control flow. Enums for categories, typed records for configuration, implementation in focused single-purpose files.

The route table in `index.ts` is the reference example: method, pattern, auth gate, and handler on one line per route. The full routing surface is visible in 15 lines. The `CHANGE_TYPES` table in `evolution.ts` follows the same pattern: validate, preview, apply per change type — the full schema evolution surface scannable in one table.

Domain logic lives in pure-function modules with context injected. HiveDO builds context objects (`dataCtx()`, `evoCtx()`) and delegates. No God objects — each module owns one concern.

## Router architecture

Declarative dispatch table in `src/router.ts`. Routes are matched in declaration order.

- **`Method`** enum: `GET`, `POST`, `ANY`
- **`Auth`** enum: `NONE` (default), `DEV` (no secret configured), `CONFIGURED` (secret required to exist), `SECRET` (Basic auth against master secret)
- **`where`** constraints: regex validation on extracted params (e.g. `{ token: /^[a-fA-F0-9]+$/ }`)
- **`RouteContext`**: `request`, `url`, `env`, `params`, `store` — passed to every handler

Route handlers are grouped by domain in `src/routes/`. OAuthProvider intercepts `/mcp`, `/token`, `/register` before the dispatch table runs.

## Svelte frontend

- **No SvelteKit** — Svelte as component framework only, worker serves pages.
- Two Vite builds: server `.mjs` (SSR) + client `.client.txt` (text import via wrangler rules).
- Session cookies (HMAC-SHA256) via `Auth.SESSION` gate for browser pages.
- Pages: SchemaViewer (pattern browser + entry editor), HiveMap (force-directed pattern visualization), LinkMap (cross-pattern reference graph).
- WebSocket live updates via Hibernatable API on HiveDO.
- Test environment at `your-test-worker.workers.dev` (`[env.test]` in wrangler.toml, Auth.DEV mode).

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
