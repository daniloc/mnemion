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
- documents/schema.ts exists at this node
- pages/schema.ts exists at this node
- documents/manifest.ts imports ./schema
- pages/manifest.ts imports ./schema
- documents/hooks.ts exists at this node
- pages/hooks.ts exists at this node
- documents/manifest.ts imports ./hooks
- pages/manifest.ts imports ./hooks
- passes test "pattern-effects totality"
- passes test "returns 503 from POST /f and 404 from GET /f when R2 is absent"
- passes test "requires a title"
- passes test "refuses agent-supplied blob bookkeeping"
- passes test "refuses a page block that sources a kernel pattern"
- clipboards/manifest.ts exists at this node
- clipboards/schema.ts exists at this node
- clipboards/hooks.ts exists at this node
- clipboards/security.ts exists at this node
- index.ts imports ./clipboards/manifest
- clipboards/manifest.ts imports ./schema
- clipboards/manifest.ts imports ./hooks
- passes test "clipboard constraint and metric keysets are total"
- passes test "a clipboard submission collects every field violation"
- passes test "patch on a clipboard-bound pattern is rejected"
- passes test "clipboard completion progress is derived from the submission log"
- scratchpad/manifest.ts exists at this node
- scratchpad/schema.ts exists at this node
- scratchpad/hooks.ts exists at this node
- scratchpad/security.ts exists at this node
- index.ts imports ./scratchpad/manifest
- scratchpad/manifest.ts imports ./schema
- scratchpad/manifest.ts imports ./hooks
- passes test "a scratchpad note requires a pad slug and a kind"
- passes test "scratchpad notes are scoped and read newest-first by pad"

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

Patterns + migrations are the third and fourth registries wired end-to-end: each
feature owns its PATTERN STRUCTURE — the kernel-pattern DDL/facets/index and any
feature-specific schema migration — as PURE DATA in its dir
(`<name>/schema.ts`, type-only imports, no manifest code), and `schema.ts` builds
`KERNEL_TABLES = [...CORE_KERNEL_TABLES, ...composePatterns(FEATURES)]` while its
boot migration pile gains a tail loop over `composeMigrations(FEATURES)`. The
`documents` feature owns the `_documents` table + its v12 extraction-columns
migration; the `pages` feature owns the `_pages` table + path index. The move is
byte-identical: every consumer of `KERNEL_TABLES` (the boot DDL loop, `_fields`
seeding, the audit triggers, and crucially `verifyFieldsIntegrity` — the
DDL↔`_fields` drift oracle — plus `verifyWritePolicyTotality`) reads the COMPOSED
array, so a feature pattern is indistinguishable from a core one and an existing
hive sees no schema diff at boot. The feature `schema.ts` files stay PURE DATA so
they share the leaf discipline of the `*/security.ts` siblings (the structure half
of "a feature owns its schema," beside the security half).

The kernel PRE-MUTATION HOOKS are the fifth registry, completing "a feature owns its
kernel pattern": the `_documents` create validation (title required) + its
system-managed immutable bookkeeping columns live in `documents/hooks.ts`, and the
`_pages` write-time hook (URL-safe path + block-palette validation + the
kernel-pattern exfil guard) lives in `pages/hooks.ts`. A feature declares these in
its manifest's `hooks` slot; `kernel.ts` renames its hand-written literals to
`CORE_ON_CREATE`/`CORE_ON_WRITE`/`CORE_IMMUTABLE` and derives the EXPORTED
`ON_CREATE`/`ON_WRITE`/`IMMUTABLE` as `mergeDisjoint(CORE_*, compose*(FEATURES))`.
ENFORCEMENT does NOT move — `applyKernelRules` (the one chokepoint every mutate runs
through) reads the EXPORTED composed maps, so the validation fires byte-for-byte as
before (confirmed by the document title/immutability + page block-exfil tests staying
green); only the DECLARATION moves into the feature dir, exactly as `effects` compose
into `PATTERN_EFFECTS` but fire at the mutate chokepoint. The hook bodies are code, so
`<dir>/hooks.ts` imports ONLY TYPES from `kernel.ts` (the hook signature types +
`ImmutableRule` shape) — type imports are erased at runtime, so the `kernel.ts →
FEATURES → manifest → hooks` back-edge is type-only and adds NO runtime cycle
(`dpdm -T`, which strips type-only edges, shows the same single pre-existing runtime
cycle before and after). `mergeDisjoint` mirrors policy.ts: a feature hook for a CORE
pattern throws at module load, so a feature can never silently override a core
invariant.

Composition for `effects`/`tools`/`writePolicy`/`routes` runs at MODULE LOAD
(static tables); `patterns`/`migrations`/`systemDocs` compose at BOOT (they touch
the DB). The composers fail LOUDLY on collision (two features over one pattern's
effect, a duplicate migration version, a route/tool/pattern name clash) rather
than silently last-write-wins — a malformed manifest can't quietly shadow another
feature; a feature↔core pattern-name clash is caught by policy.ts's `mergeDisjoint`
at module load. The fail-CLOSED write-policy default is preserved: a feature
pattern declared without a write-policy entry still resolves to System/denied,
never silently agent-writable. System docs stay a single source (`http-io.md`
spans egress/publications/documents/ingress, so it isn't split per-feature); the
remaining registries (`tools`, `systemDocs`) keep ONE source of truth each until
they adopt their composer (documented landing spots in `compose.ts`), so this
migration adds the seam without duplicating definitions.

`clipboards` is the feature that EXTENDS THE CORE CHOKEPOINT. Unlike `documents`/
`pages` (which add only effects/routes/their own pattern + hooks), a clipboard is a
validated job-dispatch form: a `_clipboards` row binds a reusable, deterministically-
validated form to a target dataset pattern, and every create/update on that pattern
becomes a SUBMISSION — validated collect-all (regex/range/length/cross-field/composite
uniqueness) and scored against a composable numeric completion contract. The feature
DIR owns only the declaration (the `_clipboards` pattern/schema, the fail-closed
DEFINITION hook in `hooks.ts` that rejects an unknown constraint/metric/op, and the
`Open` write class). The ENFORCEMENT is core: two generic LEAF engines
(`entities/Hive/{constraints,completion}.ts` — `CONSTRAINT_RULES`/`COMPARISON_OPS` and
`COMPLETION_METRICS`) configured by the `_clipboards` DATA, invoked at the ONE mutate
chokepoint (`executeMutate`) via the `clipboardFor` seam on `DataContext`. So the
chokepoint covers every write path — MCP mutate AND public ingress — and a fanout of
agents all filling one clipboard is race-free (a single DO serializes the
SELECT-then-INSERT, so composite-uniqueness dedupe holds and each submission's derived
progress is a consistent snapshot). The fail-closed knot is a double-entry TOTALITY
oracle: the constraint/metric/op keys the definition hook ACCEPTS must equal the keys
the engines ENFORCE — a rule that could be stored but silently isn't checked (fail-OPEN)
fails the suite. Progress is DERIVED from the submission log every read (data-is-destiny:
`count`/`sources_covered`/`days_since_last` are SQL aggregates, never stored counters).
`patternClass` joined `KernelContext` so the definition hook can require a dataset-class
target (guaranteeing the chokepoint's type coercion runs before numeric comparison).

`scratchpad` is the pub/sub coordination feature: a `_scratchpad` row is a NOTE posted to
a named shared PAD, so agents in neighboring sessions on one hive can coordinate a fanout
(claim/done/found) without polling. The DATA half is doctrine-standard — an `Open`,
`auditExempt`, append-only kernel pattern (coordination chatter, not durable memory, so
NOT `primeInclude` and GC'd at 30 days in the boot sweep, mirroring `_entry_access_log`)
with an `onCreate` hook validating the pad slug + kind. Reads are free: the
`mnemion://scratchpad/{pad}` resource is an ordinary `query` (newest-first by pad), and
agents can poll `query _scratchpad pad=X id>cursor` to catch up. The PUSH half (Phase 2)
extends CORE — there is no HiveDO→SessionDO channel today, so a post fans out via an
effect that RPCs each live session's `notifyScratch`, which must emit `sendResourceUpdated`
from WITHIN the agents-framework agent context (a bare DO-to-DO RPC has none — confirmed
by spike). `schedule()` is the supported in-context entrypoint, so the emit is a
near-immediate scheduled task. The session registry + the per-pad `resources/subscribe`
handlers are the new SessionDO↔HiveDO seam this feature owns.
