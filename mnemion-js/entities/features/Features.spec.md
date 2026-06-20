# Features

Per-feature manifests that FEED the scattered registries from one declaration; composers derive each registry from the `FEATURES` array.

## works when
- feature.ts exists at this node
- compose.ts exists at this node
- index.ts exists at this node
- compose.ts imports ./feature
- index.ts imports ./feature
- index.ts imports ./documents/manifest
- index.ts imports ./pages/manifest
- index.ts imports ./system-tasks/manifest
- documents/manifest.ts imports ../../../shared/Routing/routes/io
- pages/manifest.ts imports ../../../shared/Routing/routes/io
- passes test "pattern-effects totality"
- passes test "returns 503 from POST /f and 404 from GET /f when R2 is absent"

## why

A "feature" is the extensibility keystone, and today its footprint is smeared
across registries a forker's agent must find and edit in lockstep: post-mutate
effects (`entities/Hive/effects.ts`), HTTP routes (`src/index.ts`), MCP tools
(`entities/Session/tools.ts`), kernel patterns + DDL (`entities/Hive/schema.ts`),
write-policy class (`entities/Hive/policy.ts`), system docs, and the coherence
spec. The `Feature` type collects all of those contributions into ONE
co-located, typed declaration; the composers in `compose.ts` DERIVE each
registry from the hand-maintained `FEATURES` barrel (`index.ts`). Adding a
feature is then: create one dir + add one import line to the barrel — its whole
footprint legible in the manifest instead of scattered.

`effects` was the first registry wired end-to-end; `routes` is the second:
`PATTERN_EFFECTS` in `effects.ts` is `composeEffects(FEATURES)`, and the route
table in `src/index.ts` is `[...CORE_ROUTES, ...composeRoutes(FEATURES)]` rather
than one hand-written literal. The `documents` feature owns its `/f/*` upload +
serve edges and the `pages` feature owns its `/page/*` serve + OG edges, declared
in their manifests (handlers still imported from the I/O adapter layer,
`shared/Routing/routes/io.ts` — the manifest declares the routing rows, not the
handler bodies). So a new side-effecting pattern, or a new HTTP edge for these
features, is a feature manifest — not another entry in a central map.

Route ORDER is load-bearing and preserved: the router matches in declaration
order (first match wins), and feature routes are appended AFTER `CORE_ROUTES`, so
a feature route can never shadow a core route. The moved patterns (`/f/...`,
`/page/...`) share no prefix with any retained core route (`/o/`, `/p/`,
`/marketplace*`, etc.), so the move changes no match outcome — confirmed by the
route/document/page tests staying green. Each route's `backendPrefix` travels
with its declaration into `BACKEND_PREFIXES`, so a moved route's SPA-fallback
exclusion is derived from the manifest, not re-hardcoded in `src/index.ts`.

Composition for `effects`/`tools`/`writePolicy`/`routes` runs at MODULE LOAD
(static tables); `patterns`/`migrations`/`systemDocs` compose at BOOT (they touch
the DB). The composers fail LOUDLY on collision (two features over one pattern's
effect, a duplicate migration version, a route/tool/pattern name clash) rather
than silently last-write-wins — a malformed manifest can't quietly shadow another
feature. The fail-CLOSED write-policy default is preserved: a feature pattern
declared without a write-policy entry still resolves to System/denied, never
silently agent-writable. System docs stay a single source (`http-io.md` spans
egress/publications/documents/ingress, so it isn't split per-feature); the
remaining registries keep ONE source of truth each until they adopt their
composer (documented landing spots in `compose.ts`), so this migration adds the
seam without duplicating definitions.
