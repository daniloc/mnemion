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

_files:_ `constants.ts`, `dev-seed.ts`, `text.d.ts`, `index.ts`, `vite.canvas.ts`, `vite.config.ts`, `vite.fragment.ts`, `vite.preview.ts`

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

_files:_ `extract.ts`, `git.ts`, `publications.ts`, `web.ts`

### Routing  `shared/Routing`
Declarative HTTP dispatch and session machinery: pattern-matched route table plus constant-time, revocable session auth helpers.

_why:_ The router is the worker's declarative HTTP dispatch (method, pattern, auth gate, param constraints matched in declaration order) with handlers grouped by domain under `routes/`, so the full routing surface stays scannable. Its auth helpers are security-load-bearing: `timingSafeEqual` is constant-time to close a timing-attack finding on secret/token/signature checks, and session cookies carry a random sid plus a KV-stored epoch so every session can be revoked without rotating `MNEMION_SECRET`, while encoding the actor backward-compatibly so deploys don't force a re-login.

_works when:_
- router.ts exists at this node
- router.ts imports ../core/constants
- routes/auth.ts exists at this node
- routes/io.ts exists at this node

_files:_ `router.ts`, `auth.ts`, `canvas.ts`, `dev.ts`, `io.ts`, `marketplace.ts`, `pages.ts`

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
│  └─ core/
│     ├─ constants.ts
│     ├─ dev-seed.ts
│     └─ text.d.ts
├─ src/
│  └─ index.ts
├─ vite.canvas.ts
├─ vite.config.ts
├─ vite.fragment.ts
└─ vite.preview.ts
```

