# Mnemion

Persistent, evolving shared knowledge management between a human and their AI agents.

MCP and HTTP server on Cloudflare Workers.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/daniloc/mnemion/tree/main/mnemion-js)

One click clones the repo to your account, provisions the resources, and deploys. You set one secret (`MNEMION_SECRET`), then register a passkey at `/setup`. Details under [**Deploy to Cloudflare**](#deploy-to-cloudflare) below.

Every conversation with an AI agent starts cold. Mnemion gives each session access to a shared history of thinking and problem solving — read, write, search, and reshape — so context from yesterday's Claude.ai chat, this morning's Claude Code run, and tomorrow's API agent all share the same memory.

See [`CLAUDE.md`](CLAUDE.md) for architecture and internals.

## How it works

### The model

- **Hive** — the whole store (one per user — optionally shared by several people as members)
- **Pattern** — an organizing structure, like a table (e.g. `tasks`, `decisions`, `people`)
- **Entry** — an instance within a pattern (a single row)
- **Facet** — a typed dimension of an entry (a column)
- **Link** — a typed connection between entries (a foreign key)

Mnemion ships **empty**. There is no prescribed schema. The first conversation creates the first pattern based on what actually needs to happen. The structure that emerges after a month encodes what matters in *this* working relationship.

### The agent surface

Eight MCP tools, scoped to act on entries of any shape:

| Tool | What it's for |
|------|---------------|
| `prime` | Auto-associative recall. Pass the current conversational focus as 1–3 natural sentences; get back the most relevant entries across all patterns ranked by semantic similarity, plus their one-hop links. Relevance is weighted at read time: superseded entries are demoted and annotated, and patterns with a memory-policy half-life decay when neither updated nor recalled. Embedding-based — descriptive language beats keyword lists. |
| `mutate` | All writes. Create, update, patch (edit text in place without resending the whole facet), archive, unarchive. Batchable up to 100 ops atomically. Supports optimistic locking via version field for concurrent-surface safety. Creating an entry that semantically overlaps an existing one (or duplicates an exclusive facet) returns a `possible_overlap` advisory — never a block. |
| `query` | Filtered, sorted, paginated reads from a single pattern. Operators: `= != > < >= <= ~ |=`. The `|=` operator does IN-list lookups (`id|=1,3,7`) for batched multi-id reads. `count_only` mode for fast counts. |
| `search` | Cross-pattern FTS over all text facets. Use when you don't know which pattern holds the answer. |
| `resolve` | Read anything by URI. Supports `mnemion://` URIs, federated cross-hive URIs (e.g. `mnemion://other.hive.dev/entry/axioms/7`), and `https://` URLs — the last fetches and caches web pages and Bluesky threads so they're available to future `prime` recalls. |
| `propose_change` | Two-phase schema evolution, phase one. Validates a structural change and returns a preview without committing. |
| `apply_change` | Two-phase schema evolution, phase two. Commits a previously proposed change. Also handles point-in-time *revert* — restores all data (not just schema) to before a given history entry. |
| `render` | Visual twin of the read tools. Returns a rich UI table (`view=patterns` or `view=entries`) via an MCP-Apps fragment in capable hosts, with a text fallback everywhere else. |

Tool metadata is centralized in `entities/Session/tools.ts` and powers both the MCP server registration and the in-app help view.

### What resources agents read

MCP resources are stable, cacheable, subscribable URIs that agents read for orientation:

- `mnemion://index` — master index: every pattern, its purpose, current state. First read of every session.
- `mnemion://schema/{pattern}` — facet definitions for a pattern.
- `mnemion://entry/{pattern}/{id}` — a single entry.
- `mnemion://history` — schema change log.
- `mnemion://stale` — entries past their staleness horizon (neither updated nor recalled recently); the review surface for maintenance passes. Supports `?days=N`.
- `mnemion://_system/{slug}` — agent-facing system docs (tools, schema-evolution, skills, conventions, memory-maintenance).

After `apply_change`, the server emits `notifications/tools/list_changed` so long-lived clients re-read.

### Schema evolution as a first-class operation

Creating a pattern, adding a facet, archiving an old pattern — all happen mid-conversation through `propose_change` → preview → `apply_change`. Supported change types:

- `create_pattern` — new pattern with facets, links to other patterns
- `add_facet` — extend an existing pattern
- `set_sharing` — toggle an entry's HTTP visibility (public / unlisted / private)
- `set_options` / `set_doctrine` — per-pattern config and prose guidance
- `set_memory_policy` — per-pattern recall hygiene: `{half_life_days, conflict_check, exclusive_facets}`
- `archive_pattern` / `unarchive_pattern`

Mistakes are recoverable. `apply_change` with `revert_history_id` restores the full hive state to before any change in the schema log.

### Auto-associative recall

`prime` is the headline feature. On every `mutate`, Mnemion generates an embedding via Workers AI (`@cf/baai/bge-base-en-v1.5`) and upserts it into a Vectorize index. When an agent calls `prime` with the current conversational focus, Mnemion embeds the focus and KNN-searches the index for the most relevant entries, then expands them one hop along links.

The result: agents don't need to know what to ask for. They describe the moment; the hive surfaces what's near it.

Raw similarity isn't the whole ranking. Relevance is weighted at read time, derived fresh from stored truth:

- **Supersession** — an entry targeted by an active `supersedes` link is demoted (×0.3) and annotated with `superseded_by`. Current truth outranks replaced truth, but the chain stays navigable — nothing is hidden.
- **Decay** — in patterns whose memory policy sets a half-life, relevance is multiplied by `0.5^(age / half_life)`, floored so old-but-relevant can still surface. Age counts from the entry's *last touch*: the later of its last update and its last prime hit (recall is rehearsal — being remembered keeps an entry fresh). Patterns without a policy never decay.

Short-term hits are logged to `_fragment_access_log`. Repeated retrieval promotes a fragment to `_long_term_fragments` — the count is derived from the log, never stored separately. User-pattern hits are logged to `_entry_access_log`, which feeds decay and the stale view.

### Memory maintenance

A hive that only accumulates eventually whispers stale things back. Mnemion counters contradiction and staleness with owner-ratified, read-time-derived mechanisms — nothing auto-deletes:

- **Supersession links** record that one entry replaced another (`mutate(pattern: "link", data: {source, target, label: "supersedes"})`).
- **Write-time overlap advisories** surface near-duplicates at create time so the contradiction is caught when it's born, not when it's recalled.
- **Per-pattern memory policy** (`set_memory_policy`) makes decay and conflict behavior owner-tunable — journals fade fast, axioms never. Agents are taught to *propose* policies as patterns reveal their nature; the owner ratifies.
- **`mnemion://stale`** lists entries past their staleness horizon for review.
- **Maintenance passes** are recorded in `_maintenance_passes`; "days since last pass" (default interval 14 days, charter-overridable) is announced to connecting agents in MCP instructions *and* in prime responses, with a prompt to offer the owner a cleanup pass.

### HTTP I/O and federation

Patterns can grow HTTP endpoints. Five kinds of agent-defined I/O, all expressed as entries:

- **Publications** (`_publications`) — the hive's publication surface. An entry declares a path, a source query, and a transport (**HTML, RSS, JSON, or Markdown with YAML frontmatter**); `GET /p/{path}` renders **live pattern data at request time** — nothing rendered is ever stored, so the page can't go stale. HTML ships opinionated defaults (semantic markup, light/dark, no JS) with two seams: a per-entry `{{facet}}` template (values escaped, template text raw) and a `css` override appended after the defaults. Superseded entries are excluded by default — public projections show current truth. Creation is consent-gated like sharing.
- **Documents** (`_documents`) — an R2-backed file store (**optional — requires R2; see below**). A `_documents` entry holds agent-defined metadata (title, description, tags, visibility); the bytes live in R2, never in the hive. Creating an entry returns a single-use `upload_url`; you `POST` the file (≤25 MB) and it's served at `GET /f/{id}`, gated by the entry's visibility. The metadata is the evolvable knowledge layer; the file is immutable truth it points at — references, not copies. Archiving the entry deletes the blob. Making a file non-private is consent-gated.
- **Shared entries** (`_shared`) — flip an entry to `public` and it becomes readable at `/o/entry/{pattern}/{id}`, edge-cached. Flip to `unlisted` and it's readable by anyone with an auth-code token.
- **Egress** (`_outputs`) — agent-constructed static responses at arbitrary `/o/{path}` URLs.
- **Ingress** (`_inputs`) — `POST /i/{path}` endpoints accept inbound data and create entries in target patterns, with an optional declarative transform DSL to map incoming fields.

**Federation** is a property of `resolve`: any URI whose first path segment contains a dot is treated as a foreign hostname. `mnemion://other.hive.dev/entry/axioms/7` becomes a GET to `https://other.hive.dev/o/entry/axioms/7`. It's **consent-gated**: `resolve` refuses a cross-hive URI — and never sends a token — unless you've allow-listed the peer host first (an active `_federation_hosts` entry, added through a confirmation round-trip); loopback/private/metadata hosts are blocked outright (SSRF). Once a host is allow-listed, private access is granted via `?token=<code>` (auth code → Bearer header), re-validated on every redirect hop. No federation protocol — sovereign hives, voluntary connections, edge-cached public responses.

### Publishing: the publication surface

Mnemion is knowledge management, not just memory — and some knowledge is most useful shared. Federation handles hive→hive sharing (machine to machine); **publications** handle hive→people. A `_publications` entry declares a path, a source query, and a transport, and the worker renders **live pattern data at request time** at `GET /p/{path}`. Nothing rendered is ever stored, so a published page can never go stale relative to its underlying entries.

```
mutate _publications create {
  "path": "now",
  "title": "What I'm working on",
  "source_pattern": "tasks",
  "filters": "[\"status=in-progress\"]",
  "format": "html"
}
```

- **Four opinionated transports**: `html` (semantic single-page, system fonts, light/dark, no JS), `rss` (RSS 2.0 with RFC-822 dates and `mnemion://` guids), `json` (a `{title, count, entries}` envelope), and `markdown` (with **YAML frontmatter** — title, path, source_pattern, generated_at, count — so it drops straight into static-site pipelines and agent ingestion).
- **Two seams on the HTML output**: a per-entry `{{facet}}` template (plus `{{_label}}`, `{{_uri}}`, `{{_id}}`, `{{_updated_at}}` — template text passes through raw, substituted values are HTML-escaped) and a `css` facet appended after the default styles.
- **Current truth by default**: entries demoted by a `supersedes` link are excluded unless `include_superseded` is set — public projections show what's current, not what was replaced.
- **Consent-gated**: creating a publication serves every current and future entry its query matches, so the `mutate` requires an explicit confirmation round-trip. Source must be a user pattern — kernel patterns (tokens, sharing config, etc.) are never publishable.
- **Visibility**: `public` (edge-cached ~60s) / `unlisted` (requires a bearer token with `read:publication:{path}` scope) / `private` (staged, not served).

Where `_outputs` serves static content you wrote, a publication is a *live projection* — the difference between a snapshot and a window.

### Document storage requires R2 (optional)

The document store is the one capability with an external dependency: **Cloudflare R2**, which is off by default on new accounts. **Mnemion runs fully without it** — every other capability (memory, prime, query, search, publications, sharing, ingress, federation, the web UI) works with no R2. Only `/f` file upload and serving are unavailable until you turn R2 on.

To enable it:

1. **Enable R2** in the Cloudflare dashboard → **Storage & databases → R2** (a one-time account toggle; adds a payment method, but usage stays in R2's free tier — 10 GB, $0 egress). This is the only manual step — no CLI can flip an account-level toggle.
2. `npm run enable-documents` — creates the bucket and wires the binding for you.
3. `npm run deploy`.

The binding ships **commented out** because a binding to a non-existent bucket fails deploy — that's what keeps Mnemion deployable on a fresh account. `npm run enable-documents` uncomments it after the bucket exists (and tells you to enable R2 first if you haven't). Until then, creating a `_documents` entry still succeeds (and returns a note that uploads are unavailable), `POST /f` returns `503`, and connecting agents are told document storage is off so they can flag it to you.

**Search story — metadata *and* contents.** A document's metadata (title, description, tags) is a normal entry, covered by `search` and surfaced in `prime`. And on upload the file's **text is extracted** into the `extracted_text` facet (text-family inline; PDFs via `unpdf` in the background) and the entry is re-embedded — so document **contents** join both the full-text index (`search`) and the embedding index (`prime`). `extraction_status` reports `done` / `pending` / `failed` / `unsupported`. (Chunked embeddings for very long documents are a future refinement.)

### Web URL adapters

`resolve` accepts `https://` URLs too. Bluesky threads are fetched via the AT Protocol API (no scraping). Anything else goes through Cloudflare Browser Rendering. Results are cached per-adapter with TTLs in `_web_cache`, and the cached content participates in `prime`'s embedding index — so web pages an agent reads today surface in tomorrow's recalls.

### Skills distribution (plugin marketplace)

Mnemion can serve itself as a Claude Code **plugin marketplace** — and, true to the rest of the system, skills are just entries. Two patterns carry it: `_plugins` (a named package with a semver `version`, a `visibility`, and optional `claude_md` / `settings_json` / `mcp_json`) and `_skills` (a `skill_md` body plus frontmatter fields, linked to a plugin via `plugin_id`). Create both through normal schema evolution the first time you need them, then author skills with `mutate` — no git repo, no static files, no build step.

The marketplace is **emergent**, not a stored artifact. `GET /marketplace.git/*` reads `_plugins` / `_skills` through the same `query` RPC any agent uses and projects them through a git adapter (`src/git.ts`) into a Smart-HTTP packfile on every request. Claude Code clones it like any other marketplace repo:

```
# Public — unauthenticated, serves only fully-public plugins
/plugin marketplace add https://<host>/marketplace/public

# Private — Basic auth with a marketplace-scoped token, serves everything
/plugin marketplace add https://mnemion:<token>@<host>/marketplace.git
```

- **Split serving by visibility.** The public endpoint lists a plugin only if *every* skill in it is public — one private skill hides the whole plugin, so there's no partial exposure. The private endpoint serves all visibility levels and is gated by an `_access_tokens` entry with `marketplace` scope, optionally constrained to specific plugin names.
- **Versioning works through the `version` facet.** Each `_plugins` entry carries a semver `version`, and it flows verbatim into both `.claude-plugin/marketplace.json` (per plugin) and that plugin's `plugin.json` — the two files Claude Code's auto-update compares to decide whether to pull. Bump `version` when you change a skill and clients pick up the new `skill_md` on next startup. The bump is **manual** (agent- or human-driven via `mutate`); the worker does not auto-increment — auto-versioning is a deliberately deferred question (see [`project-docs/archived/skill-delivery.md`](project-docs/archived/skill-delivery.md)), since auto-bumping on every typo would push an update to every client.

Because a skill's `skill_md` is just a record, a skill can teach an agent how to use *this* hive — stored in Mnemion, served by Mnemion, operating on Mnemion. Agent-facing reference: `mnemion://_system/skills`.

### The web UI

The web app is a **React + Vite** single-page app, served by the worker as static assets — a pattern browser and entry editor with live updates over WebSocket: a `mutate` broadcasts a granular delta that patches a single entry in a normalized client store, so only that one card re-renders.

**Agent-authored, customizable pages.** Each pattern's page is rendered from an optional **view spec** the agent writes *as data* into the `_views` pattern — no code, no deploy. A spec picks a `view_type` from a fixed palette and maps the pattern's facets to UI roles:

- **`cards`** — a responsive grid (the default).
- **`board`** — Kanban columns grouped by a facet (`group_by`); cards drag between columns and the move writes back.
- **`table`** — rows with columns mapped to facets.
- **`list`** — compact rows.

The palette is a fixed set of React components (`web/src/views.tsx`); the spec is declarative data interpreted against it. So an agent can lay out a pattern's UI mid-conversation by writing a `_views` entry — the same "structure is data" discipline as schema evolution, applied to the interface.

Browser sessions authenticate via passkey-backed OAuth; the session cookie also gates the API endpoints the UI uses. (The one non-React web surface is the MCP `render` fragment — plain TS, embedded in MCP-Apps-capable hosts.)

### Auth model

Layered, behind OAuth 2.1 with PKCE and Dynamic Client Registration:

- **Master secret** — high-entropy random hex, set by `npm run setup`. The bootstrap credential and the fallback for headless agents. With no secret set, the instance **fails closed**.
- **Passkey** (WebAuthn) — convenience layer for browser-based OAuth. Registered once via the URL `npm run setup` prints. Replaces the master secret for normal use.
- **Access tokens** (`_access_tokens`) — scoped bearer tokens with hierarchical prefix matching (`*`, `read` / `read:entry:axioms:7`, `write`, `upload`, `document`, `marketplace`, `register`). Used by remote agents, single-use uploads, federated peers, and the private plugin marketplace. Tokens are stored **hashed** (the raw value is shown once, at mint), and minting a broad/portable scope is consent-gated.

**One hive, several people.** A hive has a `_members` roster — an `owner` plus members, each with a role and `active`/`suspended` status. Inviting someone is a deliberate, in-person act: an agent creates the member and mints a single-use `register` token, but the token is **inert** until an existing member approves it at `/invite/{token}` with their passkey — only then can the invitee register their own passkey at `/setup`. Every write is attributed (`created_by`/`updated_by`) to the member who made it; suspending or archiving a member stops their logins and tokens.

### Architecture in one paragraph

A single Cloudflare Worker hosts everything. Two Durable Objects: **SessionDO** (one per MCP session, runs the protocol) and **HiveDO** (one per user, owns all SQLite storage — patterns, entries, facets, links, audit logs, the works). Embeddings live in Vectorize. OAuth tokens live in KV. Workers AI generates embeddings on every mutate. The full routing surface is declared as a table in `src/index.ts`; the full schema-evolution surface as a table in `entities/Hive/evolution.ts`. Code is structured as scannable schematics, not procedural chains — see [`CLAUDE.md`](CLAUDE.md) for the design principles ("data is destiny," "code as schematic") that govern the codebase.

## Deploy to Cloudflare

### One-click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/daniloc/mnemion/tree/main/mnemion-js)

Clicking the button clones the repo to your own GitHub, provisions the resources
(KV is auto-provisioned; the Vectorize index is created by the build step), wires
up CI/CD via Workers Builds, and deploys. You'll be prompted for one secret,
**`MNEMION_SECRET`** — paste a high-entropy value (e.g. `openssl rand -hex 32`).
This is required: with no secret set, the instance **fails closed** — `/authorize`
and the owner APIs return `503` and nothing is usable until you set it. (Dev-mode
auto-approve is a separate, explicit `DEV=true` opt-in that a real deploy never sets.)

After it deploys, register your owner passkey **once**:

```
https://<your-worker>.workers.dev/setup?token=<the MNEMION_SECRET you set>
```

That's the only manual step — passkey registration has to happen in your browser,
on your device. After that, browser login uses the passkey and the secret is your
headless/fallback credential. (Document storage still needs R2 — see *Document
storage requires R2* above — but everything else works immediately.)

### Or, from a clone (CLI)

### Prerequisites

- Node.js 22+ (required by Wrangler 4)
- A Cloudflare account (Wrangler will prompt for browser login on first use)
- `openssl` (preinstalled on macOS and most Linux distros)

### One command

From the repo root:

```bash
npm run setup
```

`npm run setup` is idempotent. It:

1. Finds or creates the `mnemion-vectors` Vectorize index (768 dims, cosine — matches the Workers AI `bge-base-en-v1.5` embedding model)
2. Generates a 256-bit master secret and pushes it as `MNEMION_SECRET`
3. Builds the MCP render fragment and deploys the worker — the `OAUTH_KV` namespace is auto-provisioned on this first deploy (no id needed in `wrangler.toml`) and stays linked thereafter
4. Pins `WORKER_HOST` to the deployed host and redeploys — the instance treats `WORKER_HOST` as the authoritative host for every generated URL (`upload_url` / `page_url` / `og_image`) and ignores the inbound `Host` header when it's set, so a spoofed `Host` can't poison a capability URL
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
npm run dev        # concurrently: wrangler dev (worker + DOs, seeded) + Vite HMR for the React app — open the Vite URL
npm test           # vitest suite (runs in workerd via @cloudflare/vitest-pool-workers)
```

For React-app-only iteration: `cd mnemion-js && npm run dev:app`.

The dev scripts pass `--var DEV:true` — the **explicit** opt-in for dev-mode OAuth auto-approve (`Auth.DEV`), so locally you can hit the worker without a passkey or secret. A real deploy never sets `DEV`, so the same secretless state fails closed in production.
