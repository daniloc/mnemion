# Cambium

Persistent, evolving shared memory between a human and their AI agents. MCP server on Cloudflare Workers.

## Project structure

```
project-docs/active/   Design documents (the "why" and "what")
cambium-js/            Cloudflare Worker — MCP server (the "how")
```

Future peer: iOS app (Swift).

## Current state

Vertical slice validated. The server boots, handles MCP sessions, and supports schema evolution (propose/apply loop). Three of eight tools are implemented.

### What's built
- `cambium-js/src/index.ts` — single-file McpAgent with `get_index`, `propose_change`, `apply_change`
- Durable Object with SQLite: `_index`, `_schema_history`, `_pending_changes` tables
- Authless MCP via Streamable HTTP on `/mcp`

### What's not built
- Data tools: `get_schema`, `query`, `mutate`, `search`, `get_history`
- REST API (`/api/*` via Hono) for the iOS app
- OAuth 2.1 via `workers-oauth-provider`
- Cambium I/O (schema-defined routes)
- Has not been deployed to Cloudflare yet

## Tech stack

- **Runtime**: Cloudflare Workers + Durable Objects (SQLite storage)
- **MCP**: `agents` npm package (`McpAgent` class), `@modelcontextprotocol/sdk`
- **Validation**: Zod for tool parameter schemas

## Key conventions

- The `agents` package bundles its own `@modelcontextprotocol/sdk`. Pin the top-level dep to match (currently 1.26.0) to avoid type conflicts.
- McpAgent's base class has a `sql` tagged template property. Use `db` as the name for the raw `ctx.storage.sql` accessor.
- The DO binding must be named `MCP_OBJECT` — the `McpAgent.serve()` method expects this.
- `wrangler.toml` requires `compatibility_flags = ["nodejs_compat"]` for the agents package.

## Development

```bash
cd cambium-js
npm install
npm run dev          # local server on :8787
./test-vertical-slice.sh  # end-to-end smoke test
```
