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

## Refactor-specific cruft taxonomy (what to look for)

| Class | Signature | Example here |
|---|---|---|
| **Superseded mechanism** | two declarative homes for one invariant | `composeWritePolicy` (compose.ts) vs the live `security.ts` barrel |
| **Speculative scaffolding** | defined ahead of wiring, never called | `composeTools`/`composeSystemDocs` (no contributor yet) |
| **Orphaned-by-eviction** | helper left behind when its caller moved to a module | (check after each eviction: did a private helper lose its only caller?) |
| **Transitional re-export** | re-export added for discoverability that nothing imports | manifest `writePolicy`/`sensitiveColumns` re-exports |
| **Pre-existing orphan** | unused before the refactor, surfaced by the scan | `labels.truncate`, `format-palette.isNumericFormat`/`resolveFormat`, `extract.ExtractionStatus` |

## Live inventory (triage — confirm before deleting)

**Eliminate (superseded / dead):**
- `entities/features/compose.ts` — `composeWritePolicy` is dead (write-policy wired via
  `entities/features/security.ts`, not this). Reconcile: either route both through one
  mechanism or delete the unused one. *Resolve when the composer set settles (after the
  DDL/migrations wiring lands).*

**Pending, NOT cruft (do not delete):**
- `composePatterns`, `composeMigrations` — being wired by the DDL/migrations pass.
- `FEATURES` (index.ts) — ts-prune false-positive (imported by effects.ts/index.ts).
- `src/index.ts` `default`, canvas/fragment entry exports — runtime/build entry points.

**Review (likely pre-existing orphans — confirm no dynamic use):**
- `labels.truncate`, `format-palette.isNumericFormat` / `resolveFormat`,
  `extract.ExtractionStatus`. Grep for string/dynamic references before removing.

**Decide:**
- Manifest `writePolicy`/`sensitiveColumns` re-exports — keep for dir-discoverability, or
  drop (the `security.ts` file is already the discoverable home)? Lean drop.
- `composeTools`/`composeSystemDocs` — keep as typed roadmap (documented in
  feature-manifests.md) or delete until a contributor exists? Lean keep-with-doc, since
  the `Feature` type slot is the contract; revisit if they rot.

## When to run the cleanup

After the manifest composer set is final (DDL/migrations/hooks decisions made), run
`ts-prune`/knip once more — the picture will have shifted (composers wired, re-exports
resolved) — and clear the inventory in one pass. Re-running the scan *is* the
verification that the cleanup was complete.
