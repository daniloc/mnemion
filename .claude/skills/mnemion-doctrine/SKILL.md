---
name: mnemion-doctrine
title: Mnemion development doctrine
description: The architectural doctrine for developing and extending the Mnemion repo — convert block-lists to chokepoints, one declarative home per invariant, fail closed, prove totality with an oracle, make the boundary un-routable in types, keep intent/structure/evolution converged. Use whenever adding or changing an invariant, security boundary, kernel pattern, feature, tool, route, or serve/egress path in this repo, or when reviewing/decomposing its code. This is the standard the codebase converged on; follow it so edits add order instead of sludge.
metadata:
  author: Danilo Campos
  scope: repo
---

This is the doctrine the Mnemion codebase converged on. It is not style advice — it is the reason the security surface stopped leaking and the structure stays coherent under agentic editing. Apply it; do not relitigate it. Full derivation (the why, the retrospective, the physics) is in `references/doctrine.md`.

## The one rule

> A recurring bug is a structural question being answered at call sites instead of at a boundary. Don't patch faster — invert the architecture so the bug becomes **unrepresentable**.

The fix-one-open-another loop *is* the diagnosis. When you see two or more findings clustered on the same seam, stop patching instances and enforce the invariant from a single home.

## The core conversion: O(N) → O(1)

Turn a **block-list** (N guards you must remember at N sinks; fails open the moment one is forgotten) into a **chokepoint** (one reference monitor every path physically crosses). A chokepoint earns trust from four properties that travel together — miss one and drift returns:

1. **One declarative home, and it's data.** A table keyed by the thing it governs. Not a predicate copied across call sites. Not a naming convention standing in for an unmodeled fact (`startsWith("_")` was kernel-ness inferred from a string — a bug). Not prose in a doc.
2. **Derive, never duplicate.** Every gate computes from the table. This is `data-is-destiny` applied to *behavior*: store the rule once, derive its enforcement.
3. **Enforce at the chokepoint the invariant is *about*** — where all paths converge on the protected thing, not the convenient layer. (The ingress consent-bypass happened because consent lived in the session layer while the invariant was about the *write*.)
4. **Fail closed.** Absence resolves to the safe state. Unclassified → denied, not open. Forgetting to update the table must be *safe*.

## The linchpin: prove totality

A chokepoint is not enough — you must *know* it's the only path. A totality oracle converts the unanswerable block-list question ("did we find every sink?") into a checkable one ("does the one declaration cover the enumerable domain, and fail loud if not?").

Reference oracles: `verifyWritePolicyTotality`, the served-entry-point enumeration in `security.test`, `findUnclassifiedSensitiveColumns`. **The macro-level job is the definition and defense of totality.** A boundary without an oracle is a half-boundary — don't ship it.

The oracles are runnable and CI-gated — these are the ratchets that make the surface append-only-with-review (each fails loud on a regression):

- `npm run coherence:verify` — boundary anchoring (every declared invariant has a chokepoint + oracle claim).
- `npm run conventions:check` — no new convention crossing (a load-bearing guard at N sites with no contract).
- `npm run injection-lint:check` — no new raw SQL-identifier / HTML interpolation site.
- `npm run atlas:check` — the trust atlas stays in sync with the boundary claims (no managed chokepoint left off the map, no dangling edge).

## Capability over convention

Oracles and coherence verify the *anatomy* exists (the chokepoint symbol, the green test). They cannot verify the chokepoint is un-routable-*around*. That comes from the **type system**: named capability constructors with no trust parameter to dial at a call site (`ownerDataCtx` / `servedDataCtx`). Make the wrong call *unexpressible*, not merely guarded. When you catch yourself adding a guard a future forker could forget, ask: can the type system forbid the mistake instead?

**Conventions are failures lurking in the code; we want contracts.** If something holds only because everyone remembers to do it, it will eventually not hold. Promote it to a contract (a type, a chokepoint, an oracle, a ratchet).

## The enforcement ladder, and the atlas that measures it

Enforcement is graded, not binary. Every boundary sits at one of three tiers; push the security-load-bearing ones up:

1. **Enshrined (structural)** — the unsafe state is *unrepresentable*. One transition map every path crosses, no trust parameter to dial: `ownerDataCtx`/`servedDataCtx`, `quoteIdent` (raw string → SQL identifier), born-hashed secrets, `inertHeaders` (served content → inert response), `resolveHost` (config → host, inbound `Host` ignored). The best tier — correct by construction; no oracle needed to *stay* correct.
2. **Totality-checked** — N sites, but an oracle enumerates the domain and fails loud if they disagree: `verifyWritePolicyTotality`, `SENSITIVE_COLUMNS`/egress, the scope grammar, SSRF block-host coverage, served-read gating. Correct because *checked* every build.
3. **Convention** — N unmanaged sites held by memory. A latent tear on a security boundary; tolerable only where a tear is cheap.

**Match rigor to consequence.** Not every boundary needs tier-1 — over-enshrining (every crossing a ceremony) is its own pathology. But a *security* boundary at tier-3 is a bug waiting for a forgetful edit; the goal is zero tier-3 security crossings.

The architecture is a **trust-graded manifold**: charts (trust domains — `owner-trusted`, `served-untrusted`, `agent-mcp`, `public-egress`, `federated`, `storage`) stitched by transition maps (the chokepoints). Trust is directional — most arrows preserve-or-lower it; only an enshrined chokepoint may raise it. `docs/coherence/atlas.md` (generated by `scripts/atlas.mjs`, gated by `npm run atlas:check`) is that manifold made legible: it derives each crossing's tier from the live boundary claims and flags any tier-3 security crossing or atlas drift. When you add a serve/egress/credential/SQL/host crossing, the atlas is where you confirm the manifold is still well-formed.

## Keep the three graphs converged

Entropy is the divergence of **Intent** (specs), **Structure** (imports), and **Evolution** (git change-coupling). Sludge is their divergence; order is their convergence.

- Update a component's `*.spec.md` when you change what it does — `coherence:verify` is the check the map still matches the territory.
- A concern smeared across N homes that co-change is the same defect as a leaky block-list. Collapse it to one home that co-changes only with itself (`coherence:decompose` measures this as LOCALITY).
- Docs are derived from the territory or they lie. Don't hand-maintain what can be generated.

## Operational checklists

**Adding / changing an invariant ("which X may do Y"):**
1. Make a table keyed by X, with the rule as data.
2. Default the unlisted case to the safe state (fail closed).
3. Derive every gate from the table — no call site re-derives the predicate.
4. Enforce at the chokepoint all paths cross.
5. Add a totality check (boot warning) **and** a double-entry test (independently-declared expectations whose keyset must equal the table's).
6. If it's a new security boundary, add all four parts: chokepoint + `## why` + totality test + coherence `boundary` claim. `coherence scaffold boundary <name>` emits the complete shape so you can't ship half.

**Adding a kernel pattern:** classify it in `KERNEL_TABLES` and `KERNEL_WRITE_POLICY`; set field rules in `IMMUTABLE`/`ON_CREATE`; declare every sensitive column; add a lifecycle hook only if it needs one (absence is the correct default). The matrix/totality tests fail until it's classified everywhere required.

**Adding a feature:** one directory under `entities/features/<name>/` + one `FEATURES` barrel line. Its manifest *feeds* the central registries; enforcement stays central. Follow `project-docs/archived/authoring-a-feature.md`. Keep `security.ts`/`hooks.ts` leaf-clean (`import type` only). (Paths under `project-docs/` are repo-root-relative — not under `mnemion-js/`, where the dev commands run.)

**Adding a serve path, stored secret, generated URL, or content egress:** route it through the *existing* boundary — do not re-implement the guard. Served reads via `servedDataCtx`/`servedQuery`; outward emission via `seal`/`sealAll`; secrets born hashed; host from `WORKER_HOST` config, never request data; agent-authored egress stays inert (`Content-Security-Policy: sandbox`).

## Where this is the wrong tool

Don't force a declaration onto: **effects** (the *dispatch* may be tabular; the handler stays imperative — a data-driven side-effect engine is the inner-platform anti-pattern), **one-offs** (a table of one is worse than an `if`; convert when the case count grows, not in anticipation), or **history** (migrations and audit logs are point-in-time records by design — you cannot derive them).

## The metric

Measure quality by **blast radius**: how many files must an agent read and keep in sync to safely add one pattern/tool/route/invariant? Drive it toward one. The totality check is what makes it one *in practice* — it turns "six files you must remember" into "one file; the test names the rest if you forget." And **prefer the convergent move only when it is the cheap move** — if adding a row to a registry is harder than scattering a guard, fix the scaffolding, because the cheap move is the one that will actually get made.

## Process

- **Verify, don't assume.** Exit codes are masked by pipes (`npm test | tail` reports tail's status) — redirect to a file, capture `$?`, read the summary line. Test agent-facing changes through MCP (`npm run mcp:smoke`), not just `/api`+RPC. The ratchets above + `coherence:verify` + the unit suite run in CI (`.github/workflows/ci.yml`) on every push — a new convention, a new raw interpolation, atlas drift, or a rotted spec fails the build, so the doctrine is gated, not just documented.
- **Blind adversarial review** is the perturbation that distinguishes real structure from a story you told yourself — but blind reviewers sharing an injected prior falsely converge, so ground-truth every converging claim.
- The scoreboard of success is the **shift in finding-class**: from "the boundary is leaking now" to "a future forker could get this latch wrong." The second is the price of extensibility, not a regression.

## In one breath

One declarative home (data, not convention) → derive every gate → enforce at the chokepoint all paths cross → fail closed → assert totality so the absence of holes is *checked* → make the boundary un-routable in types, not just documented → keep intent, structure, and evolution converged, and make the convergent move the cheapest one. Inference is the energy; coherence is the cone; the work is to make the convergent move the cheap move.
