# The Mnemion Doctrine — full derivation

*What converged, June 15–21, 2026 — extracted from the commits and transcripts of the week the project reached a coherent state. `SKILL.md` is the operational distillation; this is the why.*

## 0. The originating insight (the seed crystal)

Everything downstream traces to one observation:

> *"The consent-gate / kernel-pattern boundary is being defended hole-by-hole… Each fix is correct, but you're patching instances of one structural question rather than enforcing it from a single invariant. Multiple 'blind adversarial review found the prior fix incomplete' commits are the tell."*

The doctrine is the generalization of that diagnosis. **A recurring class of bug is never a run of bad luck — it is a structural question being answered at call sites instead of at a boundary.** The "fix-one-open-another" loop *is* the diagnosis. You don't escape it by patching faster; you invert the architecture so the hole becomes unrepresentable.

## 1. The core conversion: O(N) → O(1)

Convert a **block-list** (N guards you must remember at N sinks, fails open the moment one is forgotten) into a **chokepoint** (one reference monitor every path must physically cross). A chokepoint isn't trusted because it's careful — it's trusted because of four properties that travel together; miss one and drift returns:

1. **One declarative home, and it's data.** One table keyed by the thing it governs — not a predicate copied across call sites, not a naming convention standing in for an unmodeled fact (`startsWith("_")` was kernel-ness *inferred from a string*), not prose in a doc.
2. **Derive, never duplicate.** Every gate computes from the table. This is *data-is-destiny applied to behavior* — store the rule once, derive its enforcement, the same way you store items once and derive the cart count.
3. **Enforce at the chokepoint the invariant is *about*** — where all paths converge on the thing being protected, not the convenient layer. The ingress consent-bypass existed because consent lived in the session layer while the invariant was about the *write*; ingress reached the write by another road and inherited nothing.
4. **Fail closed.** Absence resolves to the safe state. An unclassified pattern is denied, not open. Forgetting to update the table becomes *safe*, not dangerous — this is what makes the standard forgiving enough to live with.

## 2. The linchpin that lets you stop: the totality oracle

A chokepoint alone is insufficient, because you can't *know* it's the only path. The unanswerable question of a block-list is *"did we find every sink?"* The totality oracle converts it into a checkable one: *"does the one declaration cover the enumerable domain, and fail loud if not?"*

This turns **"the next reviewer finds the next hole"** into **"the absence of holes is asserted at commit time."** `verifyWritePolicyTotality`, the served-entry-point enumeration, `findUnclassifiedSensitiveColumns` — each enumerates a domain and fails the suite on any unclassified member. *"The entire job at the macro level is definition and defense of totality."*

## 3. Capability over convention (the un-routable-around layer)

Coherence and oracles verify the *anatomy* is present — the chokepoint symbol exists, the test is green. They **cannot** verify the chokepoint is genuinely un-bypassable. That property comes from the **type system**: `ownerDataCtx` / `servedDataCtx` are named capability constructors with **no trust parameter to dial at a call site** — orchestration handed only the served constructor *physically cannot* reach kernel data. The split made the consent-gate bug *unexpressible*. "How do we make it impossible to represent?" is the real success condition, asked repeatedly.

The coda sharpened this into a tracked quantity: **conventions are failures lurking in the code; we need contracts.** A convention detector (`scripts/conventions.mjs`, `conventions:check`) now ratchets the convention→contract surface so the gap can only shrink; an injection-lint (`injection-lint:check`) does the same for the chokepoint-shaped guards (`escapeXml`/`isValidColumn`) that have no enumerable domain to build a totality over.

This resolved into a **graded enforcement ladder**: *enshrined* (structural — the unsafe state is unrepresentable: the capability split, `quoteIdent`, born-hashed secrets, `resolveHost`) above *totality-checked* (an oracle proves the N sites agree) above *convention* (held by memory). The right move is to push security boundaries up the ladder, matching rigor to consequence — over-enshrining is its own inner-platform pathology. And the ladder revealed the geometry the whole doctrine was implicitly describing: the architecture is a **trust-graded manifold** — charts (trust domains: `owner-trusted`, `served-untrusted`, `agent-mcp`, `public-egress`, `federated`, `storage`) stitched by transition maps (the chokepoints), where trust is directional and only an enshrined crossing may raise it. The manifold's consistency condition — transition maps must agree on overlaps, or the space is ill-defined — *is* the three-graph cocycle of §5; a convention crossing is a place the manifold can tear. `docs/coherence/atlas.md` (generated by `scripts/atlas.mjs`, gated by `atlas:check`) makes the manifold legible: it derives each crossing's tier from the live boundary claims and flags any tier-3 security crossing or atlas drift, turning "is the boundary well-formed?" into a rendered, checkable map whose target state is **zero tier-3 security crossings**.

## 4. The meta-doctrine: anti-entropy as a response function

Would a genuinely distinct architecture show *an anti-entropic signature absent from decohering codebases*?

- Clean-at-a-snapshot is **not** anti-entropy. Any codebase is ordered the day after a refactor. The 2nd law isn't violated by order; it's violated by order **maintained under perturbation.**
- So the signature isn't a property of the code — it's the code's **response function to a perturbation.** A decohering codebase *absorbs* an injected defect silently; an anti-entropic one *expels* it: the perturbation trips a loud failure (fail-closed totality, a red claim, a cruft hit) at the site, and the next edit pumps it back out.
- **There is always a per-edit ordering tax.** A codebase with *zero* ordering cost per edit isn't efficient — it's free-riding on inherited order until it's gone. The verification + cruft + totality compute (plus the agent's attention) *is* the energy that exports entropy. If you can't find the tax, you're looking at a decohering system coasting.

The falsification experiment is identical to the product's purpose: **hand the codebase to a fork's agent that doesn't share the intent, let it hack 100 commits, and measure whether fan-out, cruft, and drift stay bounded.** The system's scientific test and its reason to exist are the same measurement.

## 5. The deepest unification: entropy is three-graph divergence

Three graphs over a codebase: **Intent** (specs), **Structure** (imports), **Evolution** (git change-coupling).

> **Sludge is precisely the divergence of these three. Order is their convergence.**

This collapses two problems into one. *"Convert a block-list to a chokepoint"* = *"collapse a concern smeared across N homes into one"* = *"reduce intent↔structure↔evolution divergence."* The thing that made the security review come up empty (one chokepoint) is *literally* the thing that makes a decomposition wise (one concern, one home, co-changing only with itself). **Security and decomposition need no separate physics** — both fall out of minimizing one measure. Hence `coherence:decompose` measuring LOCALITY as three-graph agreement.

## 6. The portability thesis (framework, not heroic pass)

The sturdy outcome was **~70% architecture, ~30% Coherence** — and the 30% is *the entire durability*. Architecture produces a sturdy *snapshot*; Coherence converts "sturdy now" into "stays sturdy under hands that don't share the intent." A great architecture with no anchoring *is exactly what decays into* a block-list — those scattered `startsWith("_")` checks were a clean idea once.

The doctrine becomes a *property of the framework* — not of disciplined agents — only when the framework **flips the cost gradient**:

> **Portability = making the convergent (O(1), chokepoint, one-home) move *cheaper* than the divergent (O(N), add-a-guard) move.**

The prior session built a sieve because, at each moment, adding one check at the new sink was the path of least resistance. You make the doctrine inescapable the instant *"add a row to the registry"* costs less than *"add a guard at a site,"* and scaffolding a chokepoint-with-oracle costs less than scattering a check. Three layers, none sufficient alone:

1. **Coherence** — claims, coverage, the boundary ratchet, totality anchoring: makes the doctrine *visible, anchored, and non-rotting*. Necessary, never sufficient — a forker can write a faithful spec for a sieve and go green.
2. **Typed-capability discipline** — makes the chokepoint *un-routable-around*, language-enforced.
3. **Generative scaffolding** — `scaffold boundary` emits the *whole* shape (invariant + red boundary claim + chokepoint/oracle TODOs) so you **can't ship a half-boundary**. The gradient flip made real.

> **Inference is the energy. Coherence is the cone. The work is to make the convergent move the cheap move — so the abundance of inference, currently what produces the sludge, becomes the very thing that produces the order.**

## 7. The process doctrine (how the work itself was run)

The *process* exhibited the same restoring force as the code:

- **Blind adversarial review as the perturbation generator.** *"Code-review the entire project with blind subagents — if what we have is solid, it should be obvious from the outside without context."* External agents with no shared prior distinguish real structure from a story you've told yourself. Caveat: blind reviewers sharing an *injected* prior falsely converge — ground-truth every converging claim, strip shared priors for independent reconstruction.
- **Bake-offs in worktrees**, where the value was sometimes *negative feedback* — the process **expelled an over-engineering before it landed**, not merely selected a winner.
- **The shift in finding-class is the scoreboard.** Findings moved from *"the boundary is leaking now"* to *"a future forker could get this new latch wrong."* The second class is the *price of extensibility*, not a regression — the review literally could not find a present leak because the chokepoint structurally forbids one.
- **One declarative home for docs, too.** *"CLAUDE.md should be generated by Coherence, not a source of constant rot."* The map is derived from the territory, or it lies.

## The doctrine in one breath

> A recurring bug is a structural question answered at call sites. Convert it: one declarative home (data, not convention) → derive every gate → enforce at the chokepoint all paths cross → fail closed → assert totality so the absence of holes is *checked*, not hoped → make the boundary un-routable in the type system, not just documented → keep spec, structure, and history converged, and make the convergent move the cheapest one available. Entropy is the divergence of intent, structure, and evolution; inference is the energy that, aimed through that cone, falls toward order instead of sludge.

## Source provenance

Distilled from the June 15–21, 2026 commit arc (`b0c2667` … the convention-detector / injection-lint / trust-atlas / manifold-enshrinement coda) and the session transcripts in which it was articulated. Related repo docs that are partial approximations of this whole: `project-docs/active/self-enforcing-declarations.md`, `project-docs/active/write-class-policy.md`, `project-docs/data-is-destiny.md`, and the `## why` blocks across the `*.spec.md` tree.
