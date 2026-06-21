# Authoring a feature (the fork contract)

This is the one page to read before adding a capability — by you or your agent. The
goal of the whole architecture: **a feature is one directory**, and adding one touches
as few files as possible while the system keeps itself honest as you hack.

## First, pick your tier — most "features" need no code at all

| Tier | What it is | Cost | Example |
|---|---|---|---|
| **Data** | a new pattern + a view spec, written through the running app | **a `mutate` call, 0 code** | a new knowledge pattern; a board view |
| **Feature module** | new *behavior* — effects, routes, kernel patterns, hooks, tools | **one directory** (below) | `documents`, `pages` |
| **Core** | the data engine, the generic verbs, the router, the security kernel | not yours to extend | — |

If your idea is "a new kind of thing to store," it's **Tier Data** — use `propose_change`
+ `mutate`, write a `_views` spec, done. Only drop to a feature module when you need
new *behavior* the seven generic tools can't express.

## A feature module = one directory under `entities/features/<name>/`

Reference implementation: **`entities/features/documents/`** — read it; it exercises
every slot. The files (all optional — declare only what you use):

| File | Declares | Composed into | Discipline |
|---|---|---|---|
| `manifest.ts` | the `Feature` object: `name`, `effects`, `routes`, `tools`, references to the siblings | `FEATURES` (the barrel) | carries code; the only file that may import handlers/effect bodies |
| `schema.ts` | kernel pattern DDL + facets + migrations | `KERNEL_TABLES`, the boot migration loop | **pure data + `import type` only** |
| `security.ts` | write-class + egress-sensitive columns | `KERNEL_WRITE_POLICY`, `SENSITIVE_COLUMNS` | **pure data + `import type` only** |
| `hooks.ts` | pre-mutation validation (`onCreate`/`onWrite`/`immutable`) | `ON_CREATE`/`ON_WRITE`/`IMMUTABLE` (enforced at `applyKernelRules`) | code, but **`import type` only from `kernel.ts`** |
| `<name>.spec.md` | intent + `## works when` claims + `## why` | the coherence graph | a `passes test "<x>"` claim for any invariant |

**To register:** add one line to `entities/features/index.ts` (`FEATURES = [...]`).
That's the headline number — **one new directory + one barrel line.** Each composer
fails *loud* on a collision (two features over one pattern, a feature shadowing a core
pattern), so a mistake crashes boot, never silently wins.

## Verify (the one loop)

```
npm test                  # 503+ tests incl. the security totalities
npm run coherence:verify  # claims + executable invariant tests through the spec
npm run cruft             # unused exports (the one-declarative-home detector)
```

Green on all three = you didn't break the boundary. A `passes test "..."` claim in your
spec makes your feature's invariant part of `coherence:verify` — wire one for anything
security-relevant.

## Sharp edges (read these — they're the traps a security review found)

These are the places the structure can't fully protect you yet. Honesty up front beats
a silent footgun:

1. **Keep `security.ts` / `schema.ts` / `hooks.ts` leaf-clean — `import type` ONLY from
   `policy.ts`/`kernel.ts`.** `policy.ts` is the dependency-free security leaf; if any of
   these files (or anything a manifest transitively imports) gains a *runtime* import of
   `policy.ts`/`kernel.ts`/`schema.ts`, you can form an import cycle whose composed
   registry (`KERNEL_WRITE_POLICY`, `ON_CREATE`, …) is observed half-built at module
   load → **fail-OPEN** for not-yet-composed patterns. The pure-data split is the only
   thing preventing this; the type system does not enforce it. Run `npx dpdm -T --circular src/index.ts`
   if you touch the import graph.

2. **Your write-class is a string cast, not the enum** (`"kernel_open" as KernelPolicy["class"]`)
   — that's the price of the leaf. A typo makes the pattern fall through `writeClass()`
   to *neither* System-denied *nor* a matching consent gate (agent-writable, no gate).
   Guard: the `write-policy totality` test asserts every composed class is a real
   `WriteClass` member, and you must add your pattern to `EXPECTED` in `policy.test.ts`.
   Do both.

3. **Declare every secret/redact column in `security.ts`** — and the egress sieve only
   auto-warns for *secret-named* columns (`*_token`, `*_key`, …). A sensitively-named
   column that doesn't match the heuristic (e.g. `recovery_blob`) will **leak** via the
   `/ws` delta and export if you forget. If you add one, also add a claim that exports
   strip it.

4. **`ctx.internalCreate` in an effect is a TRUSTED write** — it bypasses the consent
   layer. Only ever call it with a literal pattern + system-derived data; never an
   attacker-influenced pattern name or payload.

5. **`IMMUTABLE_AFTER_CREATE` is not yet a feature slot.** If your pattern needs a field
   frozen *after* create (e.g. a capability you must not let an agent repoint), the
   composition surface doesn't expose it yet — raise it rather than working around it.

## Why it's shaped this way

The architecture is one idea: **every invariant has one declarative home, enforced at the
chokepoint it's about, with a totality test that fails loud.** Security is a *capability*
(the `trusted` flag, set only by `ownerDataCtx`), not a convention; side effects, routes,
write-policy, and hooks are *registries composed from features*, not call-site edits. The
coherence harness keeps the spec and code entangled as you edit. See
`project-docs/archived/{self-enforcing-declarations,feature-manifests,data-is-destiny}.md`
and the `## why` in each component's spec.
