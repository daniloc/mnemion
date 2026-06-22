# Upstreaming the coherence meta-tooling

Status: proposal. Target: `github:daniloc/coherence` (the harness this repo pins).

## The problem

Three coherence-shaped tools live as repo-local scripts in `mnemion-js/scripts/`,
not in the harness:

| script | lines | role | state it owns |
| --- | --- | --- | --- |
| `atlas.mjs` | ~380 | derives the trust atlas (charts + tiered transition maps) from the `## works when` boundary claims | — (pure derivation) |
| `conventions.mjs` | ~206 | convention-vs-contract detector + growth ratchet | `conventions-baseline.json` |
| `injection-lint.mjs` | ~116 | raw-SQL/HTML interpolation ratchet | `injection-baseline.json` |

All three **re-parse the spec tree and/or `graph.json` by hand**. That is a hidden
coupling to harness output: the harness already builds that graph internally, and
any change to its claim grammar or JSON shape can silently break a sidecar with no
test catching it. The atlas in particular is *pure derivation from boundary claims*
— the same input `coherence verify` already consumes — yet it lives as a 380-line
parallel parser.

This is the sprawl the project's own doctrine warns about, one level up: the
coherence apparatus is itself enforced by a set of conventions (run these scripts,
keep these baselines) rather than by one tool.

## The proposal

Promote the three to first-class harness subcommands, so they share the harness's
graph build, claim parser, and `--check`/`--update-baseline` conventions:

- **`coherence atlas`** — render the trust atlas (`atlas.md`) from the boundary
  claims; `--check` is the drift gate. Inputs it needs that the spec doesn't yet
  carry as first-class fields: the **chart** a chokepoint moves *from → to*, and
  its **tier**. Today `atlas.mjs` infers these from a curated map. Upstreaming
  means adding two optional claim fields — e.g.
  `boundary "<n>" at <chk> via test "<o>" from <chartA> to <chartB>` — so the atlas
  derives with no sidecar map. The chart vocabulary (`owner-trusted`,
  `served-untrusted`, `agent-mcp`, `public-egress`, `federated`, `storage`) becomes
  a small declared table in the root spec.
- **`coherence conventions`** — the guard-vs-contract detector + ratchet, baseline
  managed by the harness. The guard-verb lexicon and the curated seed move into
  config. Output gains the standing-debt view this branch added (P4).
- **`coherence lint-injection`** (or a generic `coherence lint-sinks`) — the
  interpolation-surface ratchet, with the sink contexts (sql-ident, html-value) as
  config.

## Why upstream rather than keep local

1. **One version pin, one parser.** The sidecars track harness internals informally;
   as subcommands they move with the harness and break loudly (its own tests) if the
   graph shape changes.
2. **Baselines become a harness concern** — `--update-baseline` / drift semantics are
   identical across all three today; the harness already implements exactly this for
   `docs --check`. Don't reimplement it three more times per consuming repo.
3. **Every coherence consumer inherits them.** The trust atlas and the
   convention/sink ratchets aren't mnemion-specific ideas; they're the natural
   companions to the boundary ratchet the harness already ships.
4. **Closes the meta-gap.** The harness gains the affordances that let it police its
   *own* doctrine, instead of each project re-deriving them.

## Companion: the `## why` lint (P3)

Same home, same input. The harness already parses both `## why` prose and the
boundary claims. A coverage check should **flag a `## why` sentence that names a
chokepoint or oracle symbol already anchored in a claim** alongside an oracle-verb
("iterates", "totality", "fails the build") — i.e. prose restating derivable
mechanism instead of carrying the non-derivable rationale. See
`project-docs/archived/self-enforcing-declarations.md` ("The `## why` discipline").
This belongs upstream precisely because it correlates two things the harness already
holds; a repo-local version would be a fourth sidecar re-parsing the spec tree.

## Migration shape (non-breaking)

1. Land the subcommands in the harness behind the existing config; keep the scripts as
   thin shims that call them, so CI keeps working through one release.
2. Add the optional claim fields (chart/tier) — atlas falls back to "untiered" when
   absent, so no spec is forced to change on day one.
3. Once the harness release is pinned, delete the sidecars and their baselines (the
   harness owns the baselines), and point the `*:check` npm scripts at the subcommands.

Until that lands, the scripts stay — but treat them as **debt to retire**, not the
end state.
