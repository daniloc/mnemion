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
- passes test "pattern-effects totality"

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

`effects` is the first registry wired end-to-end: `PATTERN_EFFECTS` in
`effects.ts` is `composeEffects(FEATURES)` rather than a hand-written literal, so
a new side-effecting pattern is a feature manifest, not another entry in a
central map. Composition for `effects`/`tools`/`writePolicy`/`routes` runs at
MODULE LOAD (static tables); `patterns`/`migrations`/`systemDocs` compose at BOOT
(they touch the DB). The composers fail LOUDLY on collision (two features over
one pattern's effect, a duplicate migration version, a route/tool/pattern name
clash) rather than silently last-write-wins — a malformed manifest can't quietly
shadow another feature. The fail-CLOSED write-policy default is preserved: a
feature pattern declared without a write-policy entry still resolves to
System/denied, never silently agent-writable. The remaining registries keep ONE
source of truth each until they adopt their composer (documented landing spots in
`compose.ts`), so this migration adds the seam without duplicating definitions.
