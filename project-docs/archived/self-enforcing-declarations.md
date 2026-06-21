# Self-Enforcing Declarations

> A design standard for a codebase that AI agents read, extend, and must not silently break. Synthesizes and sharpens the existing `data-is-destiny` and `code-as-schematic` doctrines into one operational rule.

## The premise

Most codebases express each invariant three times — **docs** say what should be true, **code** enforces something, **tests** check a third thing — and every divergence between the three is a latent bug or a stale doc. For a project edited by agents (and humans), that triple is the dominant source of silent rot: an agent updates one face and not the others, and nothing fails until a reviewer finds the gap.

The fix is not "write better docs" or "add more tests." It is to **collapse spec, enforcement, and test into one artifact** so they cannot drift, and to add a check that *keeps* them collapsed as the code grows.

This is what the write-class work did. `src/policy.ts` is simultaneously:
- the **spec** an agent reads to understand which patterns agents may write and what gate fires,
- the **enforcement** every gate (`session.ts`, `data.ts`, `kernel.ts`, `hive.ts`, `evolution.ts`, `prime.ts`) derives from, and
- the **oracle** the totality check and the admission-matrix test assert completeness against.

When those three are the same table, interpretability and durable correctness stop trading off — they become the same property.

## The standard

> **Every invariant gets one declarative home — a table keyed by the thing it governs — from which all consequences are derived, all enforcement reads, and a totality check proves completeness. Reading the table is reading the spec, the enforcement, and the test at once.**

An invariant that meets this standard is *self-enforcing* (the runtime can't violate it without the table saying so) and *self-documenting* (an agent learns the whole rule from one place).

## The five properties

A declaration is self-enforcing when it has all five. Missing any one reintroduces drift.

1. **One table, and it's data.** Not a predicate copied across call sites, not a naming convention standing in for an unmodeled fact (`startsWith("_")` was "kernel-ness" inferred from a name), not prose in a doc. A table an agent can read in one screen.

2. **Derive, never duplicate.** Consequences are computed from the table, never separately stored. An agent reading one row knows every consequence instead of hunting N copies. (This is `data-is-destiny` applied to *behavior*, not just stored values: store the rule once, derive its gates.)

3. **Enforce at the chokepoint the invariant is about.** Locate enforcement where every path converges on the thing being protected — a reference monitor — not in whichever layer is convenient. The ingress consent-bypass existed because consent lived in the session layer while the invariant was about the data write; ingress reached the write by another path and inherited nothing. Validate at the boundary, not at the source.

4. **Fail closed.** Absence resolves to the safe state — an unclassified kernel pattern is `System` (denied), not open. Forgetting to update the table is then *safe*, not dangerous. This is what makes the standard forgiving enough to live with.

5. **Totality check that fails loudly.** A boot-time pass and/or a double-entry test assert that every governed thing appears in the table. This converts "the next reviewer finds the next hole" into "the test finds it at commit time." Without it, the table silently grows gaps. With it, the collapse of spec/enforcement/test *survives* growth.

## The metric

Measure architectural quality by **blast radius**: *how many files must an agent read, and keep in sync, to safely add one pattern, one tool, one route, one invariant?* Drive that number toward one. A change whose correctness depends on remembering to touch six unguarded lists is a change that will eventually be made wrong. The totality check is what lets the number be one *in practice* — it turns "six files you must remember" into "one file; the test names the rest if you forget."

## The per-pattern unification (the open work)

Today, per-pattern truth is spread across four files: `schema.ts` (DDL/facets/description), `policy.ts` (write-class/consent/prime/audit), `kernel.ts` (immutable fields + `ON_CREATE` validation), `hive.ts` (lifecycle hooks). Each is individually clean, but the *organism* — "what is `_documents`, fully" — is not described in one place. That tax grows with every new facet of behavior.

The end-state is **one logical declaration per pattern**. The constraint is layering: the enforcement-critical facets must live in a **leaf module** (`policy.ts` is imported by kernel/data/session and cannot pull in `schema.ts`'s heavy deps without import cycles). So the realistic ideal is layered, not monolithic:

> Every per-pattern fact lives in exactly one table keyed by pattern name; pure enforcement facets live in the leaf; effectful facets (DDL, lifecycle handlers) reference functions; and **a single boot-time totality pass asserts every pattern appears in every required table.**

The totality pass is what lets an agent treat the physically-layered tables as one logical record — it guarantees alignment, so reading any one row tells you which others must exist. Today only write-class has its check (`verifyWritePolicyTotality`). The durable generalization is one pass that covers all per-pattern tables together.

## Where this is the wrong tool

The standard is judgment, not dogma. Do **not** apply it to:

- **Effects.** Encoding "delete the R2 blob" or "dispatch the task" as data is a homemade rules engine — an inner-platform anti-pattern. Only the *dispatch* (which pattern reacts to which event) should be tabular; the handler stays imperative code. Declarativeness buys nothing once you are describing side effects.
- **One-offs.** A table of one is worse than an `if`. Convert to a table when the case count grows, not in anticipation.
- **History.** Migrations and audit logs are point-in-time records by design (`data-is-destiny` already exempts them). You cannot *derive* a migration; do not force a schematic onto genuinely sequential history.

## The interpretability multiplier

The strongest agent-interpretability lever specific to this project: the agent-facing schema resource (`mnemion://schema/{pattern}`) is **derived from these tables** and already carries `write_class`. Push more per-pattern truth into that derived resource — consent semantics, recall inclusion, what writes it admits — so the agent *using* the product and the agent *editing the code* read the same single source. That makes the docs un-drift-able by construction, addressing the recurring failure mode where prose docs lag the code.

## Checklists

**Adding a new invariant** ("which X may do Y"):
1. Make a table keyed by X with the rule as data.
2. Default the unlisted case to the safe state (fail closed).
3. Derive every gate from the table — no call site re-derives the predicate.
4. Enforce at the chokepoint all paths cross, not the convenient layer.
5. Add a totality check (boot warning) and a double-entry test (independently-declared expectations whose keyset must equal the table's).

**Adding a new kernel pattern:**
1. `KERNEL_TABLES` (structure) and `KERNEL_WRITE_POLICY` (behavior) — the totality check forces both.
2. Field rules in `IMMUTABLE` / `IMMUTABLE_AFTER_CREATE` / `ON_CREATE` as needed.
3. If it has a lifecycle reaction, a hook (see the named seam in `write-class-policy.md`); otherwise nothing — absence of a hook is the correct default.
4. Run the matrix test: it fails until the pattern is classified everywhere required.

## Reference implementation

- `src/policy.ts` — a self-enforcing declaration (write class + consent + behavioral flags).
- `src/schema.ts:verifyWritePolicyTotality` — the loud totality check.
- `src/__tests__/policy.test.ts` — the double-entry matrix (spec = oracle).
- `project-docs/archived/write-class-policy.md` — the worked example and its remaining seam.
