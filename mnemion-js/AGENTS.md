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

_why:_ HiveDO is the single Durable Object that owns the SQLite store; every write funnels through its `mutate`/`batchMutate`/`processInput`/`consumeUpload` chokepoints precisely so the kernel-write boundary is enforced in one place instead of re-derived per call site. `policy.ts` is the dependency-free leaf source of truth for "which patterns agents can write, through which path, what gate fires" — unclassified kernel patterns fail CLOSED (System → denied) so a new pattern can never silently become agent-writable, and kernel/prime/ingress gates all derive from it so the boundary cannot drift between layers. Reads share the SAME boundary, on the same flag. `DataContext.trusted` is required and gates kernel access symmetrically: an untrusted context (`!trusted`) may neither write a kernel pattern nor read one. The trust decision is a CAPABILITY, not a per-call-site convention: `HiveDO` exposes two named constructors over a trust-agnostic `ctxFields` — `ownerDataCtx` (the ONLY `trusted: true`) and `servedDataCtx` (`trusted: false`) — and there is no trust parameter to dial at a call site. Served/untrusted reads (public page chart/metric, OG card, publication source, `/o/entry`) AND untrusted writes (ingress, upload) go through `servedDataCtx`, where the `data.ts` engine refuses any kernel pattern — so a serve/ingress sink physically cannot read or write `_access_tokens`/`_members`/etc. The served public-page + OG-card render orchestration lives in its own module (`render.ts`), handed a narrow `RenderContext` that exposes ONLY the served reader (`servedQuery`) — never `db`, never a trusted context, no way to construct one — so the render path's single data access IS the kernel-refusing chokepoint. That made the old per-block `isKernelPattern` guard in `renderBlockHtml` provably redundant (a kernel-named block just reads back empty through `servedQuery`); it was deleted, leaving one chokepoint instead of a guard to forget per block type. Because trust is fixed by the constructor (and the engine flag is required, no default), a NEW serve path can't silently inherit kernel access; it fails CLOSED. `context-capability totality` guards that the split can't rot back into a trust-defaulting factory. This replaced a block-list of scattered per-sink `isKernelPattern` checks that failed open. The read totality is the served-entry-point enumeration in `security.test.ts`, the analogue of `policy.test.ts` for writes. Instance identity is configuration, not request data: `currentHost()` is authoritative on `WORKER_HOST` and IGNORES the inbound `Host`, so an attacker cannot poison a capability URL (`upload_url`/`page_url`/`og_image`) by sending a spoofed `Host` on an unauthenticated request (e.g. a `/ws` upgrade). Cross-hive (foreign-URI) resolution lives in its own module (`federation.ts`), the one place that sends THIS hive's access token (`?token=` → `Authorization: Bearer`) to another origin. Its token-send is CO-LOCATED with the allow-list consent check in a single function (`federatedResolve`) precisely so the approved host and the contacted host can never drift apart: a token is attached only to a request whose host is BOTH not `isBlockedFederationHost` (SSRF block) AND `isHostAllowed` (the `_federation_hosts` consent allow-list), and that pair is re-validated on the INITIAL request AND on EVERY redirect hop, in lockstep with the fetch loop. Splitting the gate from the fetch — across modules or call sites — would let a future edit move one without the other; here they move as a unit. The DO hands the module a NARROW `FederationContext` — only the bound allow-list lookup (`isHostAllowed`, wrapping `_federation_hosts`, never `db`) + `errorJson` — so federation cannot read anything else; `resolve` stays on the DO and decides local vs. federated before dispatching here. This is the security analysis's "condition #2".

_works when:_
- hive.ts exists at this node
- hive.ts imports cloudflare:workers
- hive.ts imports ./data
- policy.ts exists at this node
- data.ts exists at this node
- prime.ts imports ./policy
- passes test "write-policy totality"
- passes test "context-capability totality"
- passes test "pattern-effects totality"
- effects.ts exists at this node
- effects.ts imports ../features
- effects.ts imports ../features/compose
- documents.ts exists at this node
- hive.ts imports ./documents
- render.ts exists at this node
- hive.ts imports ./render
- federation.ts exists at this node
- hive.ts imports ./federation

_files:_ `data.ts`, `documents.ts`, `effects.ts`, `evolution.ts`, `federation.ts`, `hive.ts`, `kernel.ts`, `labels.ts`, `policy.ts`, `prime.ts`, `render.ts`, `schema.ts`, `transform.ts`

### Session  `entities/Session`
The per-session McpAgent Durable Object that speaks the MCP protocol and proxies tool calls to the hive over RPC.

_why:_ SessionDO is one Durable Object per MCP session: it handles the MCP protocol (tools, resources, init instructions) and proxies to the single HiveDO over RPC, keeping protocol concerns out of the data substrate. Tool metadata lives once in `tools.ts` as the SSOT feeding both MCP registration and the `/api/tools` frontend, so the agent-facing surface can't drift between the two; the session stamps the authenticated actor onto writes from its OAuth props so attribution is enforced at the protocol edge.

_works when:_
- session.ts exists at this node
- session.ts imports agents/mcp
- tools.ts exists at this node
- session.ts imports ./tools

_files:_ `session.ts`, `tools.ts`

### Features  `entities/features`
Per-feature manifests that FEED the scattered registries from one declaration; composers derive each registry from the `FEATURES` array.

_why:_ A "feature" is the extensibility keystone, and today its footprint is smeared across registries a forker's agent must find and edit in lockstep: post-mutate effects (`entities/Hive/effects.ts`), HTTP routes (`src/index.ts`), MCP tools (`entities/Session/tools.ts`), kernel patterns + DDL (`entities/Hive/schema.ts`), write-policy class (`entities/Hive/policy.ts`), system docs, and the coherence spec. The `Feature` type collects all of those contributions into ONE co-located, typed declaration; the composers in `compose.ts` DERIVE each registry from the hand-maintained `FEATURES` barrel (`index.ts`). Adding a feature is then: create one dir + add one import line to the barrel — its whole footprint legible in the manifest instead of scattered. `effects` is the first registry wired end-to-end: `PATTERN_EFFECTS` in `effects.ts` is `composeEffects(FEATURES)` rather than a hand-written literal, so a new side-effecting pattern is a feature manifest, not another entry in a central map. Composition for `effects`/`tools`/`writePolicy`/`routes` runs at MODULE LOAD (static tables); `patterns`/`migrations`/`systemDocs` compose at BOOT (they touch the DB). The composers fail LOUDLY on collision (two features over one pattern's effect, a duplicate migration version, a route/tool/pattern name clash) rather than silently last-write-wins — a malformed manifest can't quietly shadow another feature. The fail-CLOSED write-policy default is preserved: a feature pattern declared without a write-policy entry still resolves to System/denied, never silently agent-writable. The remaining registries keep ONE source of truth each until they adopt their composer (documented landing spots in `compose.ts`), so this migration adds the seam without duplicating definitions.

_works when:_
- feature.ts exists at this node
- compose.ts exists at this node
- index.ts exists at this node
- compose.ts imports ./feature
- index.ts imports ./feature
- index.ts imports ./documents/manifest
- index.ts imports ./pages/manifest
- index.ts imports ./system-tasks/manifest
- passes test "pattern-effects totality"

_files:_ `compose.ts`, `manifest.ts`, `feature.ts`, `index.ts`, `manifest.ts`

### Auth  `shared/Auth`
Credential primitives — multi-member passkeys and scoped access/register tokens — isolated as pure db-accessor functions.

_why:_ Auth primitives (passkeys + access/register/auth tokens) are isolated as pure db-accessor functions so credential concerns stay separate from the cognitive substrate; the multi-row passkey model (one credential per member, NULL = bootstrap owner) exists because one shared hive is authenticated into by several people each acting as themselves. `resolveRegisterToken` deliberately re-validates scope/owner/roster at setup/consume time — independent of how the token's fields were set — because an adversarial review showed mint-time checks alone could be bypassed by a post-create constraints update to mount an owner-takeover, and a malformed member-less token must be unusable rather than defaulting to the owner sentinel. Access tokens are stored HASHED at rest (`hashToken`, SHA-256): `findAccessToken` hashes the presented value and compares digests, mint stores only the digest (the raw token is shown once), and a boot migration hashes any legacy plaintext token in place. So a read of an `_access_tokens` row — a `query`, a `search` hit, a leaked DO snapshot — discloses only a digest, never a usable bearer. This is a deliberate exception to "store truth once": the secret's preimage is never persisted, which neuters the entire "a token reached a read sink" class independent of which sink leaks. Because the column holds a digest, every lookup that needs the token is async (`crypto.subtle.digest`), which is why these accessors return Promises.

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

_files:_ `block-palette.ts`, `chart-spec.ts`, `chart-svg.ts`, `constants.ts`, `dev-seed.ts`, `escape.ts`, `format-palette.ts`, `text.d.ts`, `view-palette.ts`

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
│  │  ├─ documents.ts
│  │  ├─ effects.ts
│  │  ├─ evolution.ts
│  │  ├─ federation.ts
│  │  ├─ hive.ts
│  │  ├─ kernel.ts
│  │  ├─ labels.ts
│  │  ├─ policy.ts
│  │  ├─ prime.ts
│  │  ├─ render.ts
│  │  ├─ schema.ts
│  │  └─ transform.ts
│  ├─ Session/  ●
│  │  ├─ session.ts
│  │  └─ tools.ts
│  └─ features/  ●
│     ├─ documents/
│     │  └─ manifest.ts
│     ├─ system-tasks/
│     │  └─ manifest.ts
│     ├─ compose.ts
│     ├─ feature.ts
│     └─ index.ts
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
│     ├─ escape.ts
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

