# Mnemion

Persistent, evolving shared memory between you and your AI agents.

Mnemion is **not an MCP server** — it's an agent-first web service that happens to *speak* MCP. It also speaks plain HTTP, and that duality is the point: agents reach for the MCP tools, but you can `POST` a large file straight to an endpoint when you need byte-for-byte accuracy that inference can't promise. Two doors into one memory.

Every conversation with an AI agent starts cold. Mnemion gives each session access to a shared substrate — read, write, search, and reshape — so context from yesterday's Claude.ai chat, this morning's Claude Code run, and tomorrow's API agent all draw on the same memory.

> Architecture and internals: [`CLAUDE.md`](CLAUDE.md).

## What this is (and isn't)

A few months of solo noodling that turned into something I find genuinely useful. I make no warranty that it's *good* — but I think it's interesting.

It is **alpha**: lightly hardened, single-user, and server-side robustness is the smaller slice of my developer time. **Do your own diligence before storing anything sensitive in it right now.** This is an idea playground more than a deeply reviewed product.

It's also deliberately **manual**. Mnemion could capture everything automatically; it doesn't, on purpose. It's *less sponge than clerk* — you ask for the outcomes you want. Being deliberate about what's stored, why, and how has mattered more to me than indiscriminate capture.

## How it works

### Two interfaces, one memory

Mnemion exposes the same store two ways:

- **MCP** — the seven tools below, for agents that speak the protocol.
- **HTTP** — fixed-URI endpoints for reads, writes, ingress, and egress. Add or patch large files over plain HTTP when token budgets or byte accuracy matter; inference introduces hiccups, a `POST` does not.

Neither is privileged. An agent primes over MCP, you upload a 200 KB document over HTTP, and both touch the same entries.

### The model

- **Hive** — the whole store (one per user)
- **Pattern** — an organizing structure, like a table (e.g. `tasks`, `decisions`, `people`)
- **Entry** — an instance within a pattern (a single row)
- **Facet** — a typed dimension of an entry (a column)
- **Link** — a typed connection between entries (a foreign key)

Mnemion ships **empty**. There is no prescribed schema. The first conversation creates the first pattern based on what actually needs to happen. The structure that emerges after a month encodes what matters in *this* working relationship.

### Agent-defined schema, evolved in conversation

You don't migrate Mnemion; you talk to it. Creating a pattern, adding a facet, archiving an old one — all happen mid-conversation through `propose_change` → preview → `apply_change`. Change types:

- `create_pattern` — new pattern with facets and links to other patterns
- `add_facet` — extend an existing pattern
- `set_sharing` — toggle an entry's HTTP visibility (public / unlisted / private)
- `set_options` / `set_doctrine` — per-pattern config and prose guidance
- `archive_pattern` / `unarchive_pattern`

Mistakes are recoverable. `apply_change` with `revert_history_id` restores the *full* hive state — not just schema — to before any change in the log (30-day window).

### Fixed URIs → federated memory

Every entry lives at a stable address: `mnemion://entry/{pattern}/{id}`. Because the address is fixed, resolution works *across* Mnemion instances. Mark an entry public and another hive can resolve `mnemion://other.hive.dev/entry/axioms/7` — it becomes a `GET` to `https://other.hive.dev/o/entry/axioms/7`, with private access granted via `?token=<code>`.

No federation protocol, no registry. Sovereign hives, voluntary connections, edge-cached public responses.

### Resources, and the resolver that bridges to them

Your entries are exposed as MCP **resources** — stable, cacheable, subscribable URIs agents read for orientation:

- `mnemion://index` — master index: every pattern, its purpose, current state. First read of every session.
- `mnemion://schema/{pattern}` — facet definitions for a pattern.
- `mnemion://entry/{pattern}/{id}` — a single entry.
- `mnemion://history` — schema change log.
- `mnemion://_system/{slug}` — agent-facing system docs (tools, schema-evolution, conventions).

Not every platform supports MCP resources. So the **`resolve` tool** doubles as a bridge: an agent on a resource-less platform (say, Claude.ai) can still read any URI by calling `resolve` instead. Create **links** between entries to establish relationships — tie tasks to projects, associate thoughts, whatever the work needs.

### The resolver eats the web, too

`resolve` accepts `https://` URLs, not just `mnemion://` ones. Hand it any web page and it loads the destination, renders it with Cloudflare Browser Rendering, and reduces it to markdown.

**Bluesky is first-class:** threads are fetched via the AT Protocol read-only API — browser runs bypassed, no scraping. Everything is cached in `_web_cache` with per-adapter TTLs, and cached content joins the embedding index — so a page an agent reads today surfaces in tomorrow's `prime` recall.

### `prime` — recall by topic, not by query

`prime` is the headline feature. Pass it the current conversational focus in 1–3 natural sentences; it embeds that focus, KNN-searches a Vectorize index, and returns the most relevant entries across *all* patterns — plus their one-hop links and any relevant working-session fragments. Agents don't need to know what to ask for. They describe the moment; the hive surfaces what's near it.

Under the hood: every `mutate` generates an embedding via Workers AI (`@cf/baai/bge-base-en-v1.5`) and upserts it into Vectorize. Repeated retrieval of a short-term fragment promotes it to long-term — the count derived from an access log, never stored as a counter.

The payoff: resume a conversation between tools, or across time.

### The agent surface — seven MCP tools

| Tool | What it's for |
|------|---------------|
| `prime` | Auto-associative recall. Pass the current focus as 1–3 natural sentences; get the most relevant entries across all patterns by semantic similarity, plus their one-hop links. Descriptive language beats keyword lists. |
| `mutate` | All writes. Create, update, patch (edit text in place without resending the whole facet), archive, unarchive. Batchable up to 100 ops atomically. Optimistic locking via version field for concurrent-surface safety. |
| `query` | Filtered, sorted, paginated reads from one pattern. Operators: `= != > < >= <= ~ \|=`. The `\|=` operator does IN-list lookups (`id\|=1,3,7`). `count_only` mode for fast counts. |
| `search` | Cross-pattern full-text search over all text facets. Use when you don't know which pattern holds the answer. |
| `resolve` | Read anything by URI: `mnemion://` URIs, federated cross-hive URIs, and `https://` URLs (fetched, reduced to markdown, and cached). |
| `propose_change` | Schema evolution, phase one. Validates a structural change and returns a preview without committing. |
| `apply_change` | Schema evolution, phase two. Commits a proposed change — or, with `revert_history_id`, restores all data to before a given history entry. |

Tool metadata is centralized in `src/tools.ts` and powers both MCP registration and the in-app help view. After `apply_change`, the server emits `notifications/tools/list_changed` so long-lived clients re-read.

### HTTP I/O

Beyond reads, patterns can grow HTTP endpoints — all expressed as entries:

- **Shared entries** (`_shared`) — flip an entry to `public` and it's readable at `/o/entry/{pattern}/{id}`, edge-cached; `unlisted` makes it readable by anyone with a token.
- **Egress** (`_outputs`) — agent-constructed responses at arbitrary `/o/{path}` URLs.
- **Ingress** (`_inputs`) — `POST /i/{path}` endpoints accept inbound data and create entries in target patterns, with an optional declarative transform DSL to map incoming fields.

### The web UI

Mnemion serves Svelte pages directly from the worker (no SvelteKit — Svelte as a component framework only):

- **SchemaViewer** — pattern browser and entry editor, live over WebSocket.
- **HiveMap** — force-directed visualization of patterns, sized by entry count.
- **LinkMap** — cross-pattern reference graph.
- **Canvas** — a tldraw-based infinite canvas for spatial thinking. Murderboard-style: drag pattern entries onto the canvas, group them, draw connections, annotate. Entry shapes store *only references* (`{pattern, entryId}`) and hydrate live — the canvas never goes stale relative to the data.

Browser sessions authenticate via passkey-backed OAuth; the same session cookie gates the UI's API endpoints.

### Auth model

Layered, behind OAuth 2.1 with PKCE and Dynamic Client Registration:

- **Master secret** — high-entropy random hex, set by `npm run setup`. The bootstrap credential and fallback for headless agents.
- **Passkey** (WebAuthn) — optional convenience layer for browser-based OAuth. Registered once via the URL `npm run setup` prints; replaces the secret for normal use.
- **Access tokens** (`_access_tokens`) — scoped bearer tokens with hierarchical prefix matching (`*`, `read`, `read:entry:axioms:7`, `upload`, `marketplace`). Used by remote agents, single-use uploads, federated peers, and the private plugin marketplace.

### Architecture in one paragraph

A single Cloudflare Worker hosts everything. Two Durable Objects: **SessionDO** (one per MCP session, runs the protocol) and **HiveDO** (one per user, owns all SQLite storage — patterns, entries, facets, links, audit logs). Embeddings live in Vectorize, OAuth tokens in KV, Workers AI generates embeddings on every mutate. The routing surface is a declarative table in `src/index.ts`; the schema-evolution surface a table in `src/evolution.ts`. Code is structured as scannable schematics, not procedural chains — see [`CLAUDE.md`](CLAUDE.md) for the governing design principles ("data is destiny," "code as schematic").

## Deploy to Cloudflare

### Prerequisites

- Node.js 20+
- A Cloudflare account (Wrangler prompts for browser login on first use)
- `openssl` (preinstalled on macOS and most Linux distros)

### One command

From the repo root:

```bash
npm run setup
```

`npm run setup` is idempotent. It:

1. Finds or creates the `OAUTH_KV` namespace and patches its id into `wrangler.toml`
2. Finds or creates the `mnemion-vectors` Vectorize index (768 dims, cosine — matches the `bge-base-en-v1.5` embedding model)
3. Generates a 256-bit master secret and pushes it as `MNEMION_SECRET`
4. Builds the Svelte client + SSR bundles and deploys the worker
5. Prints (and optionally opens) a one-time URL: `https://<your-worker>.workers.dev/setup?token=<secret>`

Open that URL once in a browser to register a passkey. After that, browser-based OAuth uses the passkey; the master secret remains a fallback for headless agents and re-registration.

### Optional: rename the worker

By default the worker deploys as `mnemion`. For a different subdomain (or if you already have a worker by that name), edit `name` and `WORKER_HOST` in `mnemion-js/wrangler.toml` before running setup.

### Connect an MCP client

Your MCP endpoint:

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

Dev mode auto-approves OAuth (`Auth.DEV`), so you can hit the worker without a passkey or secret. Worker-level details live in [`mnemion-js/README.md`](mnemion-js/README.md).
