# Mnemion

Persistent, evolving shared memory between a human and their AI agents. MCP server on Cloudflare Workers.

Every conversation with an AI agent starts cold. Mnemion gives each session access to a shared substrate — read, write, search, and reshape — so context from yesterday's Claude.ai chat, this morning's Claude Code run, and tomorrow's API agent all share the same memory.

See [`CLAUDE.md`](CLAUDE.md) for architecture and internals.

## How it works

### The model

- **Hive** — the whole store (one per user)
- **Pattern** — an organizing structure, like a table (e.g. `tasks`, `decisions`, `people`)
- **Entry** — an instance within a pattern (a single row)
- **Facet** — a typed dimension of an entry (a column)
- **Link** — a typed connection between entries (a foreign key)

Mnemion ships **empty**. There is no prescribed schema. The first conversation creates the first pattern based on what actually needs to happen. The structure that emerges after a month encodes what matters in *this* working relationship.

### The agent surface

Seven MCP tools, scoped to act on entries of any shape:

| Tool | What it's for |
|------|---------------|
| `prime` | Auto-associative recall. Pass the current conversational focus as 1–3 natural sentences; get back the most relevant entries across all patterns ranked by semantic similarity, plus their one-hop links. Embedding-based — descriptive language beats keyword lists. |
| `mutate` | All writes. Create, update, patch (edit text in place without resending the whole facet), archive, unarchive. Batchable up to 100 ops atomically. Supports optimistic locking via version field for concurrent-surface safety. |
| `query` | Filtered, sorted, paginated reads from a single pattern. Operators: `= != > < >= <= ~ |=`. The `|=` operator does IN-list lookups (`id|=1,3,7`) for batched multi-id reads. `count_only` mode for fast counts. |
| `search` | Cross-pattern FTS over all text facets. Use when you don't know which pattern holds the answer. |
| `resolve` | Read anything by URI. Supports `mnemion://` URIs, federated cross-hive URIs (e.g. `mnemion://other.hive.dev/entry/axioms/7`), and `https://` URLs — the last fetches and caches web pages and Bluesky threads so they're available to future `prime` recalls. |
| `propose_change` | Two-phase schema evolution, phase one. Validates a structural change and returns a preview without committing. |
| `apply_change` | Two-phase schema evolution, phase two. Commits a previously proposed change. Also handles point-in-time *revert* — restores all data (not just schema) to before a given history entry. |

Tool metadata is centralized in `src/tools.ts` and powers both the MCP server registration and the in-app help view.

### What resources agents read

MCP resources are stable, cacheable, subscribable URIs that agents read for orientation:

- `mnemion://index` — master index: every pattern, its purpose, current state. First read of every session.
- `mnemion://schema/{pattern}` — facet definitions for a pattern.
- `mnemion://entry/{pattern}/{id}` — a single entry.
- `mnemion://history` — schema change log.
- `mnemion://_system/{slug}` — agent-facing system docs (tools, schema-evolution, skills, conventions).

After `apply_change`, the server emits `notifications/tools/list_changed` so long-lived clients re-read.

### Schema evolution as a first-class operation

Creating a pattern, adding a facet, archiving an old pattern — all happen mid-conversation through `propose_change` → preview → `apply_change`. Supported change types:

- `create_pattern` — new pattern with facets, links to other patterns
- `add_facet` — extend an existing pattern
- `set_sharing` — toggle an entry's HTTP visibility (public / unlisted / private)
- `set_options` / `set_doctrine` — per-pattern config and prose guidance
- `archive_pattern` / `unarchive_pattern`

Mistakes are recoverable. `apply_change` with `revert_history_id` restores the full hive state to before any change in the schema log.

### Auto-associative recall

`prime` is the headline feature. On every `mutate`, Mnemion generates an embedding via Workers AI (`@cf/baai/bge-base-en-v1.5`) and upserts it into a Vectorize index. When an agent calls `prime` with the current conversational focus, Mnemion embeds the focus and KNN-searches the index for the most relevant entries, then expands them one hop along links.

The result: agents don't need to know what to ask for. They describe the moment; the hive surfaces what's near it.

Short-term hits are logged to `_fragment_access_log`. Repeated retrieval promotes a fragment to `_long_term_fragments` — the count is derived from the log, never stored separately.

### HTTP I/O and federation

Patterns can grow HTTP endpoints. Three kinds of agent-defined I/O, all expressed as entries:

- **Shared entries** (`_shared`) — flip an entry to `public` and it becomes readable at `/o/entry/{pattern}/{id}`, edge-cached. Flip to `unlisted` and it's readable by anyone with an auth-code token.
- **Egress** (`_outputs`) — agent-constructed responses at arbitrary `/o/{path}` URLs.
- **Ingress** (`_inputs`) — `POST /i/{path}` endpoints accept inbound data and create entries in target patterns, with an optional declarative transform DSL to map incoming fields.

**Federation** is a property of `resolve`: any URI whose first path segment contains a dot is treated as a foreign hostname. `mnemion://other.hive.dev/entry/axioms/7` becomes a GET to `https://other.hive.dev/o/entry/axioms/7`. Private cross-hive access is granted via `?token=<code>` (auth code → Bearer header). No federation protocol — sovereign hives, voluntary connections, edge-cached public responses.

### Web URL adapters

`resolve` accepts `https://` URLs too. Bluesky threads are fetched via the AT Protocol API (no scraping). Anything else goes through Cloudflare Browser Rendering. Results are cached per-adapter with TTLs in `_web_cache`, and the cached content participates in `prime`'s embedding index — so web pages an agent reads today surface in tomorrow's recalls.

### The web UI

Mnemion serves Svelte-based pages directly from the worker (no SvelteKit — Svelte as a component framework only):

- **SchemaViewer** — pattern browser and entry editor. Live updates over WebSocket.
- **HiveMap** — force-directed visualization of patterns, sized by entry count.
- **LinkMap** — cross-pattern reference graph, showing how patterns connect via links.
- **Canvas** — a tldraw-based infinite canvas for spatial thinking. Murderboard-style: drag pattern entries onto the canvas, group them, draw connections, annotate. Entry shapes store *only references* (`{pattern, entryId}`) and hydrate live from the underlying entries — the canvas never goes stale relative to the data.

Browser sessions authenticate via passkey-backed OAuth. The same session cookie also gates the API endpoints the UI uses.

### Auth model

Layered, behind OAuth 2.1 with PKCE and Dynamic Client Registration:

- **Master secret** — high-entropy random hex, set by `npm run setup`. The bootstrap credential and the fallback for headless agents.
- **Passkey** (WebAuthn) — optional convenience layer for browser-based OAuth. Registered once via the URL `npm run setup` prints. Replaces the master secret for normal use.
- **Access tokens** (`_access_tokens`) — scoped bearer tokens with hierarchical prefix matching (`*`, `read`, `read:entry:axioms:7`, `upload`, `marketplace`). Used by remote agents, single-use uploads, federated peers, and the private plugin marketplace.

### Architecture in one paragraph

A single Cloudflare Worker hosts everything. Two Durable Objects: **SessionDO** (one per MCP session, runs the protocol) and **HiveDO** (one per user, owns all SQLite storage — patterns, entries, facets, links, audit logs, the works). Embeddings live in Vectorize. OAuth tokens live in KV. Workers AI generates embeddings on every mutate. The full routing surface is declared as a table in `src/index.ts`; the full schema-evolution surface as a table in `src/evolution.ts`. Code is structured as scannable schematics, not procedural chains — see [`CLAUDE.md`](CLAUDE.md) for the design principles ("data is destiny," "code as schematic") that govern the codebase.

## Deploy to Cloudflare

### Prerequisites

- Node.js 20+
- A Cloudflare account (Wrangler will prompt for browser login on first use)
- `openssl` (preinstalled on macOS and most Linux distros)

### One command

From the repo root:

```bash
npm run setup
```

`npm run setup` is idempotent. It:

1. Finds or creates the `OAUTH_KV` namespace and patches its id into `wrangler.toml`
2. Finds or creates the `mnemion-vectors` Vectorize index (768 dims, cosine — matches the Workers AI `bge-base-en-v1.5` embedding model)
3. Generates a 256-bit master secret and pushes it as `MNEMION_SECRET`
4. Builds the Svelte client + SSR bundles and deploys the worker
5. Prints (and optionally opens) a one-time URL: `https://<your-worker>.workers.dev/setup?token=<secret>`

Open that URL once in a browser to register a passkey. After that, browser-based OAuth uses the passkey; the master secret remains as a fallback for headless agents and re-registration.

### Optional: rename the worker

By default the worker deploys as `mnemion`. If you want a different subdomain (or you already have a worker by that name on your account), edit `name` and `WORKER_HOST` in `mnemion-js/wrangler.toml` before running setup.

### Connect an MCP client

Your MCP endpoint is:

```
https://<your-worker>.workers.dev/mcp
```

Add it to Claude Desktop, Claude Code, or any MCP client that supports remote servers with OAuth. The first connection opens the OAuth flow in a browser; your passkey authorizes it.

## Subsequent deploys

Code changes only — no secret rotation, no re-registration:

```bash
npm run deploy
```

Re-running `npm run setup` rotates the master secret and replaces your passkey.

## Local development

```bash
npm run dev        # builds frontend, runs wrangler dev on :8787 in dev mode (no secret required)
npm test           # vitest suite (runs in workerd via @cloudflare/vitest-pool-workers)
```

For frontend-only iteration with mock data: `cd mnemion-js && npm run preview`.

Dev mode auto-approves OAuth (`Auth.DEV`), so you can hit the worker without a passkey or secret.
