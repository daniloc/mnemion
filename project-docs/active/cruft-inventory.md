# Identifying cruft (post-refactor cleanup method)

A large refactor accretes cruft. This is the **method** for finding it — repeatable,
so the eventual cleanup pass is systematic, not a vibe — plus the live inventory.

## How we identify cruft (three lenses, cheapest first)

1. **Automated dead-code scan.** `npx ts-prune -p tsconfig.json` lists unused exports
   (the quick signal we use today). For the fuller picture — unused *files*,
   *dependencies*, *types*, and enum members — configure **knip** (`knip.json` with the
   real entry points: `src/index.ts` worker, `web/src/*` SPA, the canvas/fragment vite
   entries, `src/__tests__`). Recommended next step: add `npm run cruft` (knip) and fold
   it into the verify flow as an **advisory** tier (like coherence's symbol-coverage) —
   not a hard gate (too many intentional public-API exports), but a report a cleanup
   pass reads.

2. **The coherence harness.** Already walks every symbol and flags undocumented ones
   (advisory). The same walk can flag *unreferenced* exports — cruft detection native to
   the gravity well. A future harness enhancement, not built yet.

3. **The "one declarative home" doctrine, read backwards.** This is the highest-signal
   lens and it's free: *self-enforcing-declarations* says every invariant has ONE
   declarative home. So **two homes for one job is cruft, by definition.** When a
   refactor supersedes a mechanism, the old home becomes cruft the moment the new one
   lands — look for it deliberately at each landing.

## Circular dependencies — a health lens, with a caveat

The composition wires many core modules into the `FEATURES` tree, which raises the
question of import cycles. **Caveat learned the hard way:** `madge --circular` and
`dpdm` both count `import type` edges, which **erase at runtime** — so they massively
over-report. On this tree they flag ~9–10 "cycles", but a manual trace + the
leaf-preservation design show **every composition cycle is type-only** (e.g.
`policy.ts → security.ts → (import type) policy.ts`; `manifest → io.ts → (import type)
router`). There are **zero real runtime cycles** from the refactor (the only all-runtime
ones, `schema↔dev-seed` and `hive↔evolution`, predate it).

Lesson: a runtime-cycle check must be **type-aware** (`eslint import/no-cycle` with the
TS resolver) or it cries wolf — and a check that cries wolf is itself cruft. Don't add
the raw-tool scan as a standing gate. Verify cycles by tracing whether the back-edge is
`import type`; if it is, it's benign.

## Refactor-specific cruft taxonomy (what to look for)

| Class | Signature | Example here |
|---|---|---|
| **Superseded mechanism** | two declarative homes for one invariant | `composeWritePolicy` (compose.ts) vs the live `security.ts` barrel |
| **Speculative scaffolding** | defined ahead of wiring, never called | `composeTools`/`composeSystemDocs` (no contributor yet) |
| **Orphaned-by-eviction** | helper left behind when its caller moved to a module | (check after each eviction: did a private helper lose its only caller?) |
| **Transitional re-export** | re-export added for discoverability that nothing imports | manifest `writePolicy`/`sensitiveColumns` re-exports |
| **Pre-existing orphan** | unused before the refactor, surfaced by the scan | `labels.truncate`, `format-palette.isNumericFormat`/`resolveFormat`, `extract.ExtractionStatus` |

## Live inventory (triage — confirm before deleting)

**CLEARED (refactor-introduced cruft, eliminated):**
- ~~`composeWritePolicy`~~ — deleted; write-policy lives in the `security.ts` barrel. A
  comment now records why there's no second home.
- ~~manifest `writePolicy`/`sensitiveColumns` re-exports~~ — dropped (a known-dead export
  pollutes the cruft scan — same broken-windows trap as a red coherence baseline; the
  comment + the sibling `security.ts` keep the footprint discoverable).

**NOT cruft (intentional / false-positive — leave):**
- `composeTools`, `composeSystemDocs` — ready extension points, no contributor yet (the 7
  core tools aren't feature-owned). Deleting them would defeat the keystone for those
  registries; keep, documented in feature-manifests.md.
- `FEATURES` (index.ts) — false-positive (imported by effects.ts/schema.ts/kernel.ts).
- `src/index.ts default`, canvas/`env` entries, the `satisfies` lines — runtime/build
  entry points and ts-prune quirks.
- `labels.truncate` (5 refs), `format-palette.resolveFormat` (16 refs) — USED;
  ts-prune false-positives.

**Pre-existing dead — confirmed 0 refs, remove in the final sweep (NOT refactor cruft):**
- `format-palette.isNumericFormat`, `extract.ExtractionStatus`. Predate this work; a
  2-line removal, deferred to keep refactor commits scoped.

## When to run the cleanup

After the manifest composer set is final (DDL/migrations/hooks decisions made), run
`ts-prune`/knip once more — the picture will have shifted (composers wired, re-exports
resolved) — and clear the inventory in one pass. Re-running the scan *is* the
verification that the cleanup was complete.
