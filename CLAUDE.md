# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Mnemion

Persistent, evolving shared memory between a human and their AI agents. MCP server on Cloudflare Workers.

## Project structure

Source is organized into **component directories**, each with a co-located
`*.spec.md` (intent + `## works when` claims + protected `## why`). The
coherence harness derives a graph/agent-map from the spec tree + code and
verifies the specs haven't rotted (see "Coherence" below). `entities/` are the
two Durable Objects + their domain logic; `shared/` are cross-cutting
primitives; `src/` keeps the worker entry, the Svelte frontend, agent docs, and
tests.

```
project-docs/active/   Design documents (the "why" and "what")
mnemion-js/            Cloudflare Worker — MCP server (the "how")
  Mnemion.spec.md      Root spec: OAuth-wrapped MCP server, one declarative route table
  coherence.config.json  Coherence harness config (component dirs, adapters)

  src/index.ts         Route table + OAuthProvider config (the worker entry; wrangler `main`)
  src/pages/           Svelte components (SchemaViewer, HiveMap, LinkMap, Canvas, EntryDetail) + SSR + canvas/fragment entry points
  src/system-docs/     Markdown files with {{placeholder}} syntax, loaded at runtime
  src/__tests__/       vitest (vitest-pool-workers)

  entities/Hive/       (HiveDO — the per-user Durable Object; Hive.spec.md)
    hive.ts            DO shell — RPC wrappers, URI resolution, federation, WebSocket
    data.ts            Query engine, mutation engine (CRUD), cross-pattern search
    kernel.ts          Pre-mutation hooks, immutable fields, scope matching
    policy.ts          Write-class SSOT: KERNEL_WRITE_POLICY table; every consent/kernel/ingress gate derives from it
    prime.ts           Auto-associative priming: Workers AI embeddings + Vectorize KNN
    evolution.ts       Schema evolution: CHANGE_TYPES declaration table, propose/apply/revert
    schema.ts          DDL, migrations, kernel table declarations, system doc seeding
    labels.ts          Single source of truth for "what does this entry look like" (deriveLabel, truncate)
    transform.ts       Transform DSL evaluator for ingress field mapping
  entities/Session/    (SessionDO — per-session McpAgent; Session.spec.md)
    session.ts         McpAgent, MCP protocol handler (per-session DO)
    tools.ts           Tool metadata SSOT — feeds session.ts MCP registration and /api/tools

  shared/Routing/      (Routing.spec.md)
    router.ts          Declarative router: types, enums, pattern matching, dispatch
    routes/auth.ts     /authorize, /auth/verify, passkey setup & authentication, /invite/:token approval
    routes/io.ts       /o/entry shared entries, /o/:path egress, /p/:path publications, /f documents, /i ingress, /upload
    routes/marketplace.ts  Token management, git endpoints (composes query + git adapter)
    routes/dev.ts      Dev-only seed routes (Auth.DEV gated, inert in production)
    routes/canvas.ts   /canvas SSR page + /api/canvases, /api/canvas
    routes/pages.ts    Svelte SSR pages, /api/* JSON endpoints, WebSocket proxy
  shared/Auth/         (Auth.spec.md)
    credentials.ts     Passkey CRUD, access token validation
    passkey.ts         WebAuthn passkey registration + authentication
  shared/IO/           (IO.spec.md — adapters across the hive boundary)
    publications.ts    Publication renderers: live pattern data → HTML/RSS/JSON/markdown, template seam
    web.ts             Web URL resolution adapter dispatch (Bluesky, browser-rendering); _web_cache
    git.ts             Git protocol adapter (file tree → git pack, used by marketplace)
    extract.ts         Document text extraction (inline text, async PDF)
  shared/core/
    constants.ts       Product identity (PRODUCT_NAME, URI_SCHEME, uri() helper)
    dev-seed.ts        DEV_SEED-gated realistic data population (raw SQL, runs in DO ctor)
    text.d.ts          Ambient module decls for *.md / *.client.txt text imports

  docs/coherence/      Generated: _graph.html, _overview.html, graph.json, why-proposals.md
  AGENTS.md            Generated agent map (coherence overview)
  vite.config.ts       Main SSR + client build (SchemaViewer/HiveMap/LinkMap/EntryDetail)
  vite.canvas.ts       Separate build for canvas-client.client.txt → dist/canvas/
  scripts/setup.sh     First-run setup: generates secret, deploys, opens passkey registration
```

Future peer: iOS app (Swift).

## Current state

Deploys as a single Cloudflare Worker that exposes MCP at `/mcp`. Cross-surface data sharing proven (Claude Code + Claude.ai reading/writing the same store).

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

- **Master secret** (`MNEMION_SECRET`): High-entropy random hex, set via `npm run setup`. Root of trust — used to bootstrap the owner passkey and as fallback for headless agents. The user's Cloudflare login is the true credential; the secret is ephemeral and replaceable. Master-secret logins resolve to the `owner` actor.
- **Passkey** (WebAuthn): Optional convenience layer for browser-based OAuth. Registered via one-time setup URL. Stored in HiveDO `_passkeys` table — **one credential per member** (re-registering a member replaces only that member's row). If any passkey is registered, `/authorize` shows passkey-first UI with secret fallback. Authentication offers all members' credentials and resolves the actor from the one used.
- **Access tokens** (`_access_tokens`): Scoped bearer tokens for remote agents, uploads, marketplace, and federated access. Created via `mutate`. Scope matching is hierarchical prefix-based. Optional `member` column attributes a token to a member; the OAuth external-token path resolves the session's actor from it (member-less → `owner` sentinel; suspended/archived member → refused).
- **No secret configured** = dev mode (auto-approves).

### Shared hive (multi-member)

One hive, several people. Hive identity (which Durable Object) is decoupled from actor identity (which person): `HIVE_ID` (`shared/core/constants.ts`, literal `"user:owner"` — a rename for clarity, not a re-key) names the single store every member authenticates into; the authenticated member's label rides in the OAuth session props as `actor`, separate from `hiveId`. Design doc: `project-docs/active/shared-hive.md`.

- **Members** (`_members` kernel pattern): the roster. `label` (immutable handle, the join key for passkeys/tokens), `display_name`, `role` (`owner`|`member`), `status` (`active`|`suspended`). The `owner` member is seeded on boot and reserved. Creating a member is consent-gated at the MCP layer (it grants standing access to the whole hive).
- **Invite flow**: (1) create the `_members` row with `label` + `display_name` (the inviting agent names them); (2) mint a `register`-scoped access token with `member: "<label>"` (forced single-use; the hook refuses `owner` and any non-active-roster member); (3) the token is minted **inert** — an existing member must approve it in person at `/invite/{token}` via passkey (master-secret fallback) before it works; (4) once approved, give the invitee its `/setup?token=...` URL, where they register their own passkey, bound to that member. The setup endpoints accept either the master secret (owner bootstrap) or an **approved** `register` token (invitee). The passkey approval — not the agent-satisfiable mutate round-trip — is the real human-consent gate: `approved_at` is IMMUTABLE on the mutate path and set only by the approval endpoint, so an agent acting on injected content can mint an invite but never activate it.
- **Revocation**: suspend (`status: suspended`) or archive a member → their passkey logins and tokens stop resolving; also archive their `_access_tokens` rows. The global session epoch (`/sessions/revoke`) remains the all-at-once panic button.
- **Attribution** (per-entry `created_by`/`updated_by`): every write stamps the session actor onto the entry. `created_by`/`updated_by` are kernel columns (auto-provided on every pattern, like `created_at`; not facets), set by the mutate engine from the actor — MCP writes from the session props (`session.ts`), browser writes from the session cookie (which now carries the member, backward-compatibly), internal/ingress writes default to the `owner` sentinel. Caller-supplied `created_by`/`updated_by` are stripped (`executeMutate`) so attribution can't be forged. Surfaced automatically in `query`/`resolve`/prime row reads.

### Vocabulary

Mnemion uses biological vocabulary at every layer — API parameters, URIs, JSON response keys, and docs: **hive** (the whole store), **pattern** (organizing structure), **entry** (instance within a pattern), **facet** (dimension of an entry), **link** (connection between entries). Internal SQL tables (`_objects`, `_fields`) keep implementation names but are never exposed to agents.

### Resources (stable, cacheable, subscribable)

- `mnemion://index` — master index
- `mnemion://schema/{pattern_name}` — facet definitions for a pattern
- `mnemion://history` — schema evolution history (supports `?limit=N`)
- `mnemion://entry/{pattern}/{id}` — individual entry by URI
- `mnemion://stale` — entries past their staleness horizon (supports `?days=N`); review surface for maintenance passes

### Tools (7 total)

Tool metadata is centralized in `entities/Session/tools.ts` (SSOT for `session.ts` MCP registration + `/api/tools` frontend):

- `prime` — auto-associative recall: pass conversational context, get semantically-nearest entries + one-hop links. Workers AI embeds entries on write, Vectorize indexes them, prime queries KNN. Relevance is weighted at read time: superseded entries demoted ×0.3 + annotated `superseded_by`; patterns with a memory-policy half-life decay by `0.5^(age/half_life)` where age runs from the later of `updated_at` and the last prime hit (`_entry_access_log` — recall is rehearsal). `raw_similarity` is kept alongside weighted `relevance`. A `maintenance` field appears when a cleanup pass is overdue.
- `resolve` — read anything by `mnemion://` URI, including federated cross-hive URIs and `mnemion://web/<https-url>` for adapter-cached web fetches (escape hatch for platforms without resource support)
- `query` — filtered, sorted, paginated reads (supports `count_only` mode). Filter operators: `= != > < >= <= ~` (LIKE) and `|=` (IN, comma-separated values — e.g. `id|=1,3,7` for batched multi-id lookups)
- `search` — cross-pattern full-text search across text facets
- `mutate` — create, update, or archive entries. Single creates in user patterns run a policy-gated write-time conflict check (synchronous embed + KNN ≥0.80 same-pattern; the vector is reused for the post-write upsert) and return `possible_overlap` advisories; exclusive-facet duplicates advise via cheap SQL (batch included). Advisory only — never blocks.
- `propose_change` — propose schema evolution (preview, no commit)
- `apply_change` — commit proposed change (fires resource update notifications)

### HTTP I/O & Federation

Agent-defined HTTP endpoints, configured as entries:
- **Shared entries** (`_shared`): `GET /o/entry/{pattern}/{id}` — serve entries marked public or unlisted
- **Egress** (`_outputs`): `GET /o/{path}` — serve agent-constructed content at arbitrary paths
- **Documents** (`_documents`): R2-backed file store. `_documents` entry holds agent metadata (title/description/tags/visibility) + system-managed blob bookkeeping (`r2_key`/`size`/`content_type`/`stored_at`, IMMUTABLE); bytes live in R2 (`DOCUMENTS` binding), never the hive. Two-step: `mutate _documents create` auto-mints a single-use `document`-scoped token and returns `upload_url`; `POST /f/{token}` streams to R2 (≤25 MB) and records the key. Served at `GET /f/{id}`, visibility-gated like `_shared` (private 404 / unlisted token `read:document:{id}` / public edge-cached). Archiving the entry deletes the R2 object (waitUntil). Non-private visibility is consent-gated (visibility-aware, like set_sharing). R2 key is fully random (non-enumerable). On upload, text is extracted into `extracted_text` (text-family inline via `shared/IO/extract.ts`; PDF via `unpdf` in `ctx.waitUntil`) and the entry re-embedded, so document contents are searchable (`search`) and recallable (`prime` — `_documents` is in prime's KERNEL_INCLUDE); `extraction_status` reports done/pending/failed/unsupported. Chunked embeddings for long docs are a future seam.
- **Publications** (`_publications`): `GET /p/{path}` — live pattern projections rendered at request time (never stored). Formats: html (default styles + owner `css` override), rss, json, markdown (YAML frontmatter). Source query reuses the data.ts query engine (filters/facets/sort/limit pass through); superseded entries excluded by default. Per-entry `template` seam: `{{facet}}` + `{{_label}}`/`{{_uri}}`/`{{_id}}`/`{{_updated_at}}` — template text raw, substituted values HTML-escaped in html/rss. Source must be a user pattern (kernel patterns never publishable). Creation is consent-gated at the MCP layer like `_shared`. ETag = max(publication, served entries) `updated_at`; public responses edge-cached 60s.
- **Ingress** (`_inputs`): `POST /i/{path}` — accept inbound data, create entries in target patterns with optional transform DSL

**Federation**: `resolve` recognizes foreign URIs by a dot in the first path segment (hostname). `mnemion://other.hive.dev/entry/axioms/7` → `GET https://other.hive.dev/o/entry/axioms/7`. Private access via `?token=<auth_code>` → Bearer header. Public responses edge-cached. No federation protocol — sovereign hives, voluntary connections.

Federation is gated by a consent allow-list (`_federation_hosts` kernel pattern): `resolve` refuses any cross-hive URI — and never sends a token — unless the target host has an active entry there. Loopback/private/link-local/internal hosts (incl. cloud metadata) are blocked outright and can't be allow-listed (`isBlockedFederationHost` in kernel.ts). Adding a host is consent-gated at the MCP `mutate` layer (confirmation round-trip, also blocked inside batches), so an agent acting on untrusted content can't silently leak the owner's token to an attacker host.

### Memory maintenance (contradiction management + decay)

All read-time-derived, owner-ratified, never auto-deleting:

- **Supersession**: a `supersedes`-labeled `_links` row (source supersedes target). Prime demotes + annotates; entry resolution and the stale view annotate `superseded_by`. Entries are never hidden.
- **Memory policy**: `memory_policy` JSON column on `_objects` (beside `doctrine`), set via the `set_memory_policy` change type. Shape: `{half_life_days?: number|null, conflict_check?: "annotate"|"off", exclusive_facets?: string[]}`. Defaults when unset: conflict check on, decay off. Surfaced per-pattern in the index. Kernel patterns can't carry policy.
- **Decay**: `decayMultiplier` in prime.ts — `max(0.05, 0.5^(age/half_life))`, ranking only, never data. `_entry_access_log` records prime hits on user-pattern entries.
- **Stale view**: `mnemion://stale` — per-pattern horizon of 3× half-life (90 days without a policy).
- **Maintenance passes**: `_maintenance_passes` kernel pattern. Days-since derived from the latest row; interval from charter key `maintenance_interval_days` (default 14). Overdue status injected into MCP init instructions (session.ts) AND the prime response (web clients never see init instructions).
- Agent protocol lives in `src/system-docs/memory-maintenance.md`.

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
- `register` — one-time passkey-registration link for inviting a member (constraints JSON: `{member}`; forced single-use). Minted **inert**; requires a member's passkey approval at `/invite/{token}` (sets `approved_at`) before `/setup` accepts it. Not usable as an API token (doesn't match `*`); rejects `owner` and non-roster members.

### Internal tables

- `_schema_history` — log of all schema changes
- `_pending_changes` — proposed but uncommitted changes
- `_access_tokens` — unified scoped access tokens (optional `member` attribution)
- `_members` — roster of people sharing the hive (label/display_name/role/status); `owner` seeded + reserved. See "Shared hive" under Auth.
- `_passkeys` — WebAuthn credentials, one row per member (`member` column; NULL = owner bootstrap). Not agent-facing (created via the setup flow, not `mutate`).
- `_shared` — entry-level sharing for HTTP access
- `_outputs` / `_inputs` — HTTP I/O endpoint definitions
- `_publications` — declarative outbound projections served at `/p/{path}`; rendering is always derived, never stored
- `_documents` — file-store metadata (title/tags/visibility + system-managed r2_key/size/content_type/stored_at); bytes live in R2, served at `/f/{id}`
- `_system_docs` — agent orientation docs (seeded from `src/system-docs/*.md`)
- `_web_cache` — adapter-fetched web content (Bluesky threads 24h, browser-rendered markdown 30d). TTL = re-fetch horizon, not eviction: active content is retained indefinitely as memory; only superseded duplicates are GC'd (7-day grace, pinned excluded). A re-fetch that returns empty keeps the existing snapshot (snapshot protection in web.ts). `pinned` column + `resolve(retain: true)` freeze a snapshot forever (always served, never re-fetched/GC'd) until `retain: false`; pinning stays system-managed (`_web_cache` is write-class System in `entities/Hive/policy.ts` — driven only through resolve, never agent mutate)
- `_canvases` — tldraw document snapshots for the Canvas spatial-thinking UI (full document state in the `snapshot` facet — do not modify directly; mutate via canvas tools/UI). Entry-type shapes inside the snapshot store **only references** (`{type: 'entry', pattern, entryId, x, y, w, h}`) — display label and facet preview are hydrated at render time from the live entry. Do not denormalize entry data into the snapshot; it goes stale.
- `_fragment_access_log` — append-only log of prime hits per short-term fragment. Promotion to `_long_term_fragments` is COUNT(*)-derived from this log, not a stored counter. GC'd alongside fragments. Audit-exempt (high-frequency append-only).
- `_entry_access_log` — append-only log of prime hits per user-pattern entry. Feeds decay (`last_touch`) and the stale view. Audit-exempt, write-protected, GC'd at 90 days.
- `_maintenance_passes` — record of completed memory-maintenance passes; days-since-last-pass is derived from the latest row, never stored.

## Tech stack

- **Runtime**: Cloudflare Workers + Durable Objects (SQLite storage)
- **MCP**: `agents` npm package (`McpAgent` class), `@modelcontextprotocol/sdk`
- **Auth**: `@cloudflare/workers-oauth-provider` (OAuth 2.1 + PKCE + DCR), `@simplewebauthn/server` for passkeys
- **AI**: Workers AI (embeddings) + Vectorize (KNN index, `mnemion-vectors` / per-env `*-vectors`)
- **Validation**: Zod for tool parameter schemas
- **Storage**: KV for OAuth tokens, DO SQLite for all user data
- **Frontend**: Svelte 5 (component framework only, no SvelteKit), Vite for SSR + client builds

### Wrangler bindings

- `MCP_OBJECT` — SessionDO binding (required name; `McpAgent.serve()` expects it)
- `MNEMION_HIVE` — HiveDO binding
- `OAUTH_KV` — OAuth token storage
- `AI` — Workers AI for embeddings
- `VECTORIZE` — Vectorize index for prime KNN
- `DOCUMENTS` — R2 bucket for document blobs (`mnemion-documents`; bytes for the `_documents` store). **Optional**: ships commented out in `wrangler.toml` (a binding to a non-existent bucket fails deploy), and `Env.DOCUMENTS` is optional. Mnemion runs fully without R2 — only `/f` upload/serve degrade (create returns a `documents_note`; `POST /f` → 503). Enable via dashboard → Storage & databases → R2, then `npm run enable-documents` (creates the bucket + uncomments the binding) and `npm run deploy`. When R2 is off, the index annotates `_documents` with an `unavailable` note and the MCP init message flags it so agents can tell the user. Document *contents* are not yet indexed for search/prime (metadata is); text extraction is the future seam.

### Environments

- Default — production deploy (host comes from your CF account's `workers.dev` subdomain, or a custom route).
- `[env.test]` — `Auth.DEV` mode, no secret. Used as a federation peer / test target. Provision with `wrangler deploy --env test` after the main env exists.

## Key conventions

- The `agents` package bundles its own `@modelcontextprotocol/sdk`. Pin the top-level dep to match (currently 1.26.0) to avoid type conflicts.
- McpAgent's base class has a `sql` tagged template property. Use `db` as the name for the raw `ctx.storage.sql` accessor in HiveDO.
- The DO binding must be named `MCP_OBJECT` — the `McpAgent.serve()` method expects this.
- `wrangler.toml` requires `compatibility_flags = ["nodejs_compat"]` for the agents package.
- Kernel columns (`id`, `version`, `created_at`, `updated_at`, `archived_at`, `created_by`, `updated_by`) are auto-provided on every pattern. They cannot be defined via `propose_change`. `created_by`/`updated_by` are set by the mutate engine from the session actor (not facets, not caller-settable).
- Structure is resources, operations are tools. If it describes what the organism is, it's a resource. If it changes what the organism is or retrieves dynamic content, it's a tool.
- Product name and URI scheme are defined in `shared/core/constants.ts`. Import `PRODUCT_NAME`, `URI_SCHEME`, `uri()` from there — never hardcode `"mnemion://"` in source.
- `@simplewebauthn/server` is lazy-imported in `routes/auth.ts` to avoid `tslib` resolution issues in the vitest/workerd test environment.
- System docs live in `src/system-docs/*.md` with YAML frontmatter (`slug`, `title`). Placeholders (`{{PRODUCT_NAME}}`, `{{uri:path}}`) are resolved at runtime by `resolveDocPlaceholders()` in schema.ts.
- `wrangler.toml` has a `[[rules]]` entry to import `.md` files as text modules.

## Design principle: data is destiny

`project-docs/data-is-destiny.md` is doctrine. Operational rules derived from it:

- **Store truth once, derive its consequences.** Counts, summaries, labels, and previews are computed at read time, not stored as columns. The `entry_count`/`latest_activity` on `/api/index` are SQL-computed every call. Entry labels are derived via `entities/Hive/labels.ts` (`deriveLabel`) wherever they're needed; never persisted.
- **Snapshots store references, not denormalized data.** Canvas entry shapes hold `{pattern, entryId}` and hydrate from the live entry; `_fragment_access_log` is the source of promotion eligibility, not a stored counter.
- **Audit logs are exempt** — `_mutation_log`, `_schema_history`, `_pending_changes` are point-in-time records on purpose.
- **Caches are bounded with explicit invalidation policy** — `_web_cache` has per-adapter TTLs (re-fetch horizon) with superseded-duplicate GC; resolved content is retained as durable memory, not evicted on TTL. Vectorize embeddings are re-upserted on every mutate via `embedAfterMutate`.
- **Schema integrity is checked at boot.** `verifyFieldsIntegrity` in `schema.ts` walks every pattern and warns on drift between actual table DDL and the `_fields` metadata table — guards against migration mistakes producing lying agent-facing schemas. `_fields` is the long-standing partial duplication that justifies the check; full deduplication (deriving facet metadata from PRAGMA) is a future cleanup.
- **Instance identity is configuration, not request data.** `env.WORKER_HOST` is the authoritative host for every generated URL (`upload_url`, `page_url`, `og_image`, the `_system/instance` doc); `currentHost()` returns it and **ignores** the inbound `Host` header when it's a real value. The inbound `Host` (recorded in `fetch()`) is only the fallback when `WORKER_HOST` isn't configured — i.e. local dev. This is a security boundary: an attacker who sends a spoofed `Host` on an unauthenticated request (e.g. a `/ws` upgrade) must not be able to poison a capability URL handed to the owner. `scripts/setup.sh` pins `WORKER_HOST` to the deployed host at first deploy; production should always have it set. (This inverts the earlier "derive from inbound Host" convenience, which made request data authoritative for a security-relevant value.)

## Design principle: code as schematic

Structure code as declarative, scannable tables — not procedural chains. A reader should grasp the system's shape from the declarations alone, without tracing control flow. Enums for categories, typed records for configuration, implementation in focused single-purpose files.

The route table in `index.ts` is the reference example: method, pattern, auth gate, and handler on one line per route. The full routing surface is visible in 15 lines. The `CHANGE_TYPES` table in `evolution.ts` follows the same pattern: validate, preview, apply per change type — the full schema evolution surface scannable in one table.

Domain logic lives in pure-function modules with context injected. HiveDO builds context objects (`dataCtx()`, `evoCtx()`) and delegates. No God objects — each module owns one concern.

## Design principle: self-enforcing declarations

The operational synthesis of the two principles above, for a codebase agents edit. Every invariant gets **one declarative home** (a table keyed by what it governs) that is simultaneously the spec an agent reads, the enforcement every gate derives from, and the oracle a totality check asserts completeness against — so spec, enforcement, and test can't drift. Five properties make a declaration self-enforcing: (1) one table, and it's data; (2) derive, never duplicate; (3) enforce at the chokepoint the invariant is about, not the convenient layer; (4) fail closed (absence → the safe state); (5) a totality check that fails loudly. Reference: `entities/Hive/policy.ts` (write-class registry) + `verifyWritePolicyTotality` + `src/__tests__/policy.test.ts`. Full doctrine and checklists: `project-docs/active/self-enforcing-declarations.md`. Quality metric: minimize the number of files an agent must touch in lockstep to add a pattern/tool/route/invariant — drive it toward one. Not for effects (keep imperative), one-offs, or history (migrations/audit logs).

## Design principle: security boundaries are self-enforcing declarations

The security model is a set of **boundaries**, each enforced at ONE chokepoint a
new code path physically cannot avoid — never a guard remembered at each call
site (a block-list fails open the moment someone forgets a sink). Each boundary
has the same anatomy: a chokepoint + a `## why` stating the invariant + a
totality/regression test + a coherence `works when` claim anchoring the
chokepoint. The boundaries:

- **Untrusted reads & writes** → one required `trusted` flag on `DataContext`,
  symmetric: an untrusted context (`!ctx.trusted`) may neither WRITE a kernel
  pattern (`executeUntrustedWrite`) nor READ one (`query`/`search`/`aggregate`).
  Writes enter untrusted via ingress/upload; reads via `servedDataCtx`/
  `servedQuery` (public page, OG, publication, `/o/entry`). The flag is required
  (no default) so a new serve/ingress path can't silently inherit kernel access —
  it fails CLOSED. Oracle: `verifyWritePolicyTotality` + `policy.test.ts` (writes),
  and the served-entry-point totality in `security.test.ts` (reads).
- **Egress sensitivity** → the read/serialization dual of the write registry.
  `SENSITIVE_COLUMNS` (`policy.ts`) declares which columns must never leave the DO
  in the clear; `seal(pattern, row)` is the one sieve every "row → bytes that
  leave the DO" path routes through (mutate response, `/ws` broadcast, audit
  trigger, export, served reads). `secret` columns are also **born hashed** —
  generated in app code and stored as a digest *before* INSERT (`hive.ts`
  `mintSecrets`; the `randomblob` SQL default is gone), so the preimage never
  lands in a column, the audit log, or a delta; the raw is returned ONCE at mint.
  Oracle: `findUnclassifiedSensitiveColumns` (boot) + the seal/born-hashed tests.
  A new egress inherits redaction by routing through `seal`; a new secret column
  fails loud until classified.
- **Instance IDENTITY** → the host is configuration (`WORKER_HOST`), never request
  data; `currentHost()` ignores the inbound `Host`.
- **Served CONTENT** → agent-authored egress is inert (`Content-Security-Policy:
  sandbox`), never active script on the first-party origin.

When you add a serve path, a stored secret, a generated URL, or a content egress:
**route it through the existing boundary — do not re-implement the guard.** Adding
a *new* boundary means adding all four parts (chokepoint, why, totality test,
claim) so the next agent inherits it by construction.

## Coherence (spec ↔ code)

The same idea, tooled for docs. The [coherence harness](https://github.com/daniloc/coherence) (`coherence-harness`, a dev dep) derives a multi-resolution graph from the `*.spec.md` tree + the code, renders an outline (`docs/coherence/_graph.html`), an agent map (`AGENTS.md`, `docs/coherence/_overview.html`), and **verifies the specs haven't rotted** against the code.

- **One spec per component directory.** Each `entities/*` and `shared/*` dir has a `*.spec.md`: a one-line intent, a `## works when` list of checkable claims (`X exists`, `X imports Y`, `typechecks`), and a protected `## why` (rationale — authored, never auto-generated; bootstrapped from git history in `docs/coherence/why-proposals.md`). The **what** is derivable from code; the **why** is not.
- `npm run coherence:docs` regenerates the graph + agent map; `npm run coherence:verify` runs claims, the narrative evidence chain, and coverage (flags undocumented symbols / claimless / why-less components). Requires **Node ≥22** (same as wrangler).
- When you move or rename a component, or change what it does, update its spec — `verify` is the check that the map still matches the territory. Keep `## why` current by hand; let the rest derive.

## Router architecture

Declarative dispatch table in `shared/Routing/router.ts`. Routes are matched in declaration order.

- **`Method`** enum: `GET`, `POST`, `ANY`
- **`Auth`** enum: `NONE` (default), `DEV` (no secret configured), `CONFIGURED` (secret required to exist), `SECRET` (Basic auth against master secret)
- **`where`** constraints: regex validation on extracted params (e.g. `{ token: /^[a-fA-F0-9]+$/ }`)
- **`RouteContext`**: `request`, `url`, `env`, `params`, `store` — passed to every handler

Route handlers are grouped by domain in `shared/Routing/routes/`. OAuthProvider intercepts `/mcp`, `/token`, `/register` before the dispatch table runs.

## Svelte frontend

- **No SvelteKit** — Svelte as component framework only, worker serves pages.
- Three Vite builds (chained in `npm run build:pages`): main client + canvas client (`vite.canvas.ts`) + SSR server bundle. Each emits `.client.txt` text modules consumed by route handlers via wrangler `[[rules]]`.
- Session cookies (HMAC-SHA256) via `Auth.SESSION` gate for browser pages.
- Pages:
  - **SchemaViewer** — pattern browser + entry editor (extracted detail logic into `EntryDetail.svelte`)
  - **HiveMap** — force-directed pattern visualization
  - **LinkMap** — cross-pattern reference graph
  - **Canvas** (`/canvas`) — tldraw-based infinite canvas for spatial thinking; persists snapshots to `_canvases` via `/api/canvas`. Murderboard-style: drag pattern instances, group/note/link elements, draw connections.
- WebSocket live updates via Hibernatable API on HiveDO.
- Test environment configured as `[env.test]` in wrangler.toml (Auth.DEV mode).

## Development

The web app is **React + Vite** (`web/`), served by the worker as static assets
(the `ASSETS` binding, `dist/web`). The worker owns `/mcp`, `/api/*`, `/o /p /f
/i`, OAuth; everything else falls through to the SPA shell (`src/index.ts`
`BACKEND_PREFIXES`). Canvas (`/canvas`) and the MCP render fragment are the only
remaining Svelte (their own vite builds). The legacy Svelte-SSR notebook is retired.

```bash
cd mnemion-js
npm install
npm run dev          # concurrently: wrangler dev (DOs + DEV_SEED data, :8787) +
                     # Vite HMR (:5173, proxies /api + /ws to the worker). Open :5173.
npm run build:web    # React SPA → dist/web
npm run build:pages  # canvas client + MCP fragment + canvas SSR (the Svelte remnants)
npm run types        # regenerate worker-configuration.d.ts from wrangler.toml
npm run coherence:docs / coherence:verify   # spec graph + rot check (Node ≥22)

# Seed a local dev hive with your REAL data (when you want realistic content):
npm run pull-hive https://<your-host> <*-token>   # once → dev-data/hive.json
npm run dev                                        # then, in another terminal:
npm run import-hive                                # loads it into the local hive
```

**Node ≥22** is required for `wrangler` and the `coherence` bin. If your default is older, use a version manager (`nvm use 22`) for `deploy`/`types`/`dev:worker`/`coherence:*`.

### Agent-authored views (hyperdesk)

The web app renders each pattern per an optional agent-authored **view spec** in
the `_views` kernel pattern: a `view_type` (`board`/`table`/`list`/`cards`) + a
declarative `config` mapping facets to UI roles (e.g. board `{group_by, title}`).
The agent writes these via `mutate` — declarative data interpreted against a
fixed React component palette (`web/src/views.tsx`), never code. The SPA holds
entries in a normalized store (`web/src/store.ts`, `useSyncExternalStore`); a
mutate broadcasts a granular delta `{pattern, op, id, entry}` over `/ws`, which
patches one entry so only its `React.memo`'d card re-renders (the faint `r{n}`
badge is the visible proof).

## Testing

```bash
cd mnemion-js
npm test             # vitest run — full suite
npm run test:watch   # vitest in watch mode
npx vitest run path/to/file.test.ts                 # single test file
npx vitest run -t "name of test"                    # tests matching a name
```

Tests live in `mnemion-js/src/__tests__/` and run inside `@cloudflare/vitest-pool-workers` (workerd runtime). `isolatedStorage: true` rolls back DO SQLite between tests. `tsconfig` excludes `src/__tests__` because tests import the `cloudflare:test` virtual module. Use `fetchMock` from `cloudflare:test` to mock outbound HTTP in DO tests (`activate()`/`deactivate()` per test).

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
