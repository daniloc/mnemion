# mnemion-js — map for agents

> Generated from the spec tree by the coherence harness. Do not edit by hand.

Cloudflare Worker entry: an OAuth-wrapped MCP server whose one declarative route table is the whole HTTP surface.

## Components

### Mnemion  `.`
Cloudflare Worker entry: an OAuth-wrapped MCP server whose one declarative route table is the whole HTTP surface.

_why:_ The worker entry keeps the entire HTTP surface as one scannable declarative route table (method, pattern, auth gate, handler per line) so the system's shape is graspable from the declarations alone, per the "code as schematic" principle. OAuthProvider wraps the worker to own the OAuth 2.1 / DCR / token flow and intercept `/mcp`, `/token`, `/register` before dispatch, so the rest of the code never re-implements auth plumbing.

_works when:_
- src/index.ts exists at root
- wrangler.toml exists at root
- README.md exists at root
- src/index.ts imports @cloudflare/workers-oauth-provider

_files:_ `index.ts`, `vite.canvas.ts`, `vite.config.ts`, `vite.fragment.ts`, `vite.preview.ts`, `vite.web.ts`, `store.ts`

### Hive  `entities/Hive`
The single per-user Durable Object that owns all SQLite data and funnels every agent write through one kernel-enforced chokepoint.

_why:_ HiveDO is the single Durable Object that owns the SQLite store; every write funnels through its `mutate`/`batchMutate`/`processInput`/`consumeUpload` chokepoints precisely so the kernel-write boundary is enforced in one place instead of re-derived per call site. `policy.ts` is the dependency-free leaf source of truth for "which patterns agents can write, through which path, what gate fires" — unclassified kernel patterns fail CLOSED (System → denied) so a new pattern can never silently become agent-writable, and kernel/prime/ingress gates all derive from it so the boundary cannot drift between layers.

_works when:_
- hive.ts exists at this node
- hive.ts imports cloudflare:workers
- policy.ts exists at this node
- prime.ts imports ./policy

_files:_ `data.ts`, `evolution.ts`, `hive.ts`, `kernel.ts`, `labels.ts`, `policy.ts`, `prime.ts`, `schema.ts`, `transform.ts`

### Session  `entities/Session`
The per-session McpAgent Durable Object that speaks the MCP protocol and proxies tool calls to the hive over RPC.

_why:_ SessionDO is one Durable Object per MCP session: it handles the MCP protocol (tools, resources, init instructions) and proxies to the single HiveDO over RPC, keeping protocol concerns out of the data substrate. Tool metadata lives once in `tools.ts` as the SSOT feeding both MCP registration and the `/api/tools` frontend, so the agent-facing surface can't drift between the two; the session stamps the authenticated actor onto writes from its OAuth props so attribution is enforced at the protocol edge.

_works when:_
- session.ts exists at this node
- session.ts imports agents/mcp
- tools.ts exists at this node
- session.ts imports ./tools

_files:_ `session.ts`, `tools.ts`

### Auth  `shared/Auth`
Credential primitives — multi-member passkeys and scoped access/register tokens — isolated as pure db-accessor functions.

_why:_ Auth primitives (passkeys + access/register/auth tokens) are isolated as pure db-accessor functions so credential concerns stay separate from the cognitive substrate; the multi-row passkey model (one credential per member, NULL = bootstrap owner) exists because one shared hive is authenticated into by several people each acting as themselves. `resolveRegisterToken` deliberately re-validates scope/owner/roster at setup/consume time — independent of how the token's fields were set — because an adversarial review showed mint-time checks alone could be bypassed by a post-create constraints update to mount an owner-takeover, and a malformed member-less token must be unusable rather than defaulting to the owner sentinel.

_works when:_
- credentials.ts exists at this node
- passkey.ts exists at this node
- passkey.ts imports @simplewebauthn/server

_files:_ `credentials.ts`, `passkey.ts`

### IO  `shared/IO`
Outbound and inbound adapters: derived publication renderers, web-URL resolution with caching, git pack assembly, and text extraction.

_why:_ IO holds the adapters that move data across the hive's boundary, kept as focused single-purpose modules so each owns one concern. Publications render live pattern projections at request time (never stored) per the "data is destiny" doctrine; `web.ts` caches adapter-fetched content as durable memory with a re-fetch-horizon TTL and refuses blocked hosts; `extract.ts` splits inline text extraction from async PDF extraction off the response path because only the DO has `waitUntil`, capping extracted text to stay under the entry size limit.

_works when:_
- publications.ts exists at this node
- web.ts exists at this node
- git.ts exists at this node
- extract.ts exists at this node

_files:_ `extract.ts`, `git.ts`, `og-png.ts`, `publications.ts`, `web.ts`

### Routing  `shared/Routing`
Declarative HTTP dispatch and session machinery: pattern-matched route table plus constant-time, revocable session auth helpers.

_why:_ The router is the worker's declarative HTTP dispatch (method, pattern, auth gate, param constraints matched in declaration order) with handlers grouped by domain under `routes/`, so the full routing surface stays scannable. Its auth helpers are security-load-bearing: `timingSafeEqual` is constant-time to close a timing-attack finding on secret/token/signature checks, and session cookies carry a random sid plus a KV-stored epoch so every session can be revoked without rotating `MNEMION_SECRET`, while encoding the actor backward-compatibly so deploys don't force a re-login.

_works when:_
- router.ts exists at this node
- router.ts imports ../core/constants
- routes/auth.ts exists at this node
- routes/io.ts exists at this node

_files:_ `router.ts`, `auth.ts`, `canvas.ts`, `dev.ts`, `io.ts`, `marketplace.ts`, `pages.ts`

### Core  `shared/core`
Cross-cutting primitives shared by both the worker and the SPA: product identity, the declarative UI palettes (view / format / block / chart) an agent authors against, and dev-only seed data.

_why:_ Core is the layer both runtimes depend on but neither owns, so it carries zero env-specific imports and stays pure data — that purity is what lets the same module validate a write in the worker and render it in the SPA without forking. Its center of gravity is the agent-authorable UI: `view-palette` (how a pattern renders), `format-palette` (how a value renders), `block-palette` (how a page composes), and the chart pair (`chart-spec` + `chart-svg`). These are the canonical instances of the "self-enforcing declarations" doctrine — one declarative table that is simultaneously the spec an agent reads, the validator the kernel derives (`validateViewSpec`/`validateBlocks`/`validateFormatsMap`, fail-closed at the mutate chokepoint), and the totality oracle the SPA's `Record<…Id, Component>` enforces at compile time. The agent composes UI from these tables as data, never as code, which is what makes live agent-authored rework safe. The chart layer is deliberately split so one spec drives two renderers: `chart-spec` is the single home for the mark set, the categorical color palette, and the long→wide series pivot, and both the in-hive Recharts renderer and the server SVG renderer (`chart-svg`, for published pages and OG cards) derive from it — so a dataset reads identically in-hive and on a public page. `constants` keeps product identity (`PRODUCT_NAME`, `URI_SCHEME`, `uri()`) in one place so the scheme is never hardcoded. `dev-seed` is gated and runs only in the DO constructor under `DEV_SEED`; it writes via raw SQL (trusted, bypassing the kernel hook), so its contents must stay valid against these same palettes by hand — it is inert in production.

_works when:_
- constants.ts exists at this node
- view-palette.ts exists at this node
- view-palette.ts imports ./format-palette
- format-palette.ts exists at this node
- block-palette.ts exists at this node
- chart-spec.ts exists at this node
- chart-svg.ts exists at this node
- chart-svg.ts imports ./chart-spec
- dev-seed.ts exists at this node

_files:_ `block-palette.ts`, `chart-spec.ts`, `chart-svg.ts`, `constants.ts`, `dev-seed.ts`, `format-palette.ts`, `text.d.ts`, `view-palette.ts`

## Bindings

- entry: `src/index.ts` (compat `2025-04-01`)
- entity binding: `MCP_OBJECT` → class `SessionDO`
- entity binding: `MNEMION_HIVE` → class `HiveDO`
- store: `OAUTH_KV` (KV)
- store: `VECTORIZE` (Vectorize)
- store: `AI` (Workers AI)
- var: `WORKER_HOST` = `your-worker.workers.dev`

## Structure

```
mnemion-js/
├─ entities/
│  ├─ Hive/  ●
│  │  ├─ data.ts
│  │  ├─ evolution.ts
│  │  ├─ hive.ts
│  │  ├─ kernel.ts
│  │  ├─ labels.ts
│  │  ├─ policy.ts
│  │  ├─ prime.ts
│  │  ├─ schema.ts
│  │  └─ transform.ts
│  └─ Session/  ●
│     ├─ session.ts
│     └─ tools.ts
├─ shared/
│  ├─ Auth/  ●
│  │  ├─ credentials.ts
│  │  └─ passkey.ts
│  ├─ IO/  ●
│  │  ├─ extract.ts
│  │  ├─ git.ts
│  │  ├─ og-png.ts
│  │  ├─ publications.ts
│  │  └─ web.ts
│  ├─ Routing/  ●
│  │  ├─ routes/
│  │  │  ├─ auth.ts
│  │  │  ├─ canvas.ts
│  │  │  ├─ dev.ts
│  │  │  ├─ io.ts
│  │  │  ├─ marketplace.ts
│  │  │  └─ pages.ts
│  │  └─ router.ts
│  └─ core/  ●
│     ├─ block-palette.ts
│     ├─ chart-spec.ts
│     ├─ chart-svg.ts
│     ├─ constants.ts
│     ├─ dev-seed.ts
│     ├─ format-palette.ts
│     ├─ text.d.ts
│     └─ view-palette.ts
├─ src/
│  └─ index.ts
├─ web/
│  └─ src/
│     └─ store.ts
├─ vite.canvas.ts
├─ vite.config.ts
├─ vite.fragment.ts
├─ vite.preview.ts
└─ vite.web.ts
```

