# Feature manifests (the extensibility keystone)

**What:** a *feature* is a directory under `entities/features/<name>/` whose
`manifest.ts` exports one typed `Feature` object declaring everything that feature
contributes — post-mutate effects, HTTP routes, MCP tools, kernel patterns, DDL/
migrations, write-policy class, system-docs. Composers fold the per-feature
declarations into the flat registries the rest of the system already reads. Adding a
feature is **2 files**: the manifest + one line in the `FEATURES` barrel.

**Goal:** a forker's agent adds an experimental capability by writing one legible
manifest, not by surgery across `effects.ts` + `index.ts` + `tools.ts` + `kernel.ts`
+ `schema.ts` + `policy.ts`. The whole feature reads top-to-bottom in one file; the
whole feature *set* is greppable in one file.

## Decision: explicit `FEATURES` array (not codegen discovery)

Two mechanisms were spiked in parallel worktrees:
- **A — explicit array** (`entities/features/index.ts` hand-lists `FEATURES`).
- **B — zero-central-edit discovery** (a codegen script scans `features/*/` and emits
  a committed generated barrel, because the worker is esbuild-bundled so Vite's
  `import.meta.glob` is unavailable).

**A was chosen.** B's only advantage is saving one hand-edited array line; it pays for
that with a codegen script, a committed generated file, build pre-hooks, a wrangler
build hook, and a `--check` CI gate. That is the framework machinery this project
deliberately avoids. A wins where it matters:

1. **The contract is legible.** A hand-authored `FEATURES = [documents, pages,
   systemTasks]` *is* the contract an agent reads. B's feature set is only knowable by
   `ls` or by reading a *generated* artifact.
2. **No magic tax, no staleness footgun.** A composes at module load — pure ESM, no
   codegen, no generated file that can go stale if a hook doesn't fire.
3. **Better fork ergonomics.** Two forks adding features conflict on one hand-edited
   array line in A (trivial); in B they conflict on a *generated* barrel, which you
   can't hand-merge — you must rerun codegen.

## The `Feature` contract (`entities/features/feature.ts`)

One typed object; every slot optional. Slots: `effects` (pattern → PatternEffect),
`routes`, `tools`, `patterns` (+ `writeClass`), `migrations`, `systemDocs`. The type
declares all slots now (that's the contract); composers are wired incrementally.

## Composition status & roadmap

`entities/features/compose.ts` has one composer per registry. Every composer **throws
loudly on a cross-feature collision** (two features over one pattern's effect, dup
migration version, dup route/tool/pattern) — a colliding manifest fails worker boot,
never last-write-wins.

| Slot | Composer | Wired? | How it feeds the registry |
|---|---|---|---|
| effects | `composeEffects` | **WIRED** | `effects.ts` `PATTERN_EFFECTS = composeEffects(FEATURES)` (module load) |
| routes | `composeRoutes` | **WIRED** | `src/index.ts` `routes = [...CORE_ROUTES, ...composeRoutes(FEATURES)]`, appended AFTER core (declaration order → a feature route cannot shadow a core route); each route's prefix feeds `BACKEND_PREFIXES`. /f→documents, /page→pages |
| write-policy | (feature `security.ts`) | **WIRED** | `policy.ts` `KERNEL_WRITE_POLICY = mergeDisjoint(CORE, FEATURE_WRITE_POLICY)`. Leaf preserved: policy.ts imports only the pure-data feature-security barrel (types erased), never a manifest. Fail-closed intact; CORE↔feature collision throws loud |
| egress-sensitivity | (feature `security.ts`) | **WIRED** | `policy.ts` `SENSITIVE_COLUMNS` composes feature columns (e.g. `_documents.r2_key`); `findUnclassifiedSensitiveColumns` oracle reads the composed map |
| patterns + DDL | `composePatterns` | roadmap | `schema.ts` `KERNEL_PATTERNS = [...CORE, ...composePatterns(FEATURES)]`; boot DDL + `_fields` seeding + write-class totality already iterate KERNEL_PATTERNS |
| kernel hooks | (feature hooks) | roadmap | ON_CREATE/ON_WRITE/IMMUTABLE compose into kernel.ts's hook registry; enforcement stays at the kernel chokepoint (applyKernelRules). The security-VALIDATION logic — handle carefully; consider whether it belongs in the feature or stays kernel-central |
| migrations | `composeMigrations` | roadmap | sorted, version-unique; appended to the boot migration ledger in `schema.ts` |
| tools | `composeTools` | roadmap (no contributor yet) | metadata half into `tools.ts` SSOT; handler half a per-tool `register(server, hive)` at MCP init. The 7 tools are core; no per-feature tool exists yet |
| system-docs | `composeSystemDocs` | roadmap | concatenated into the `schema.ts` system-doc seed list at boot. (`http-io.md` spans several features — needs splitting first) |

**Wired: effects, routes, write-policy, egress-sensitivity** — a feature owns its
footprint across four registries, including the security-critical one, each composed at
its chokepoint with totality intact. Remaining (DDL, kernel hooks, migrations) is the
same pattern; each is "one-time host wiring," after which every future feature is 2
files. The security leaf-preservation pattern (pure-data `security.ts` per feature, the
leaf composes only data+types) is the template for the DDL/hook composition too.

## Totality

`pattern-effects totality` (executable coherence claim) now asserts over the COMPOSED
`PATTERN_EFFECTS` — proving the composition produces the same registry the inline pile
did, and that `mutate()` carries no re-inlined branch. As each composer is wired, its
host's existing totality (e.g. `verifyWritePolicyTotality` for write-policy) keeps
guarding it — the manifest feeds the oracle, it doesn't bypass it.
