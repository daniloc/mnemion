---
slug: memory-maintenance
title: "Memory Maintenance"
---
# Memory Maintenance

A hive that only accumulates eventually whispers stale things back. {{PRODUCT_NAME}} manages this with four read-time-derived mechanisms — nothing is auto-deleted, nothing decays in storage, and every consequence is computed fresh from stored truth.

## Supersession

When an entry replaces another — a decision reversed, a fact updated, a plan abandoned for a better one — link them instead of editing history:

```
mutate(pattern: "link", data: {source: "decisions/41", target: "decisions/23", label: "supersedes"})
```

Source supersedes target. The old entry is never hidden: query, search, and resolve still return it, annotated with `superseded_by`. Prime demotes superseded entries heavily so current truth outranks replaced truth, but the chain stays navigable — the history of how understanding evolved is often the valuable part.

Cross-pattern supersession is legitimate (a decision can supersede a note). Archive the link to undo it.

## Memory policy

Each pattern can carry a memory policy, set through schema evolution:

```
propose_change(type: "set_memory_policy", pattern_name: "journal", policy: {half_life_days: 30})
```

Policy fields (all optional):
- `half_life_days` — decay half-life for prime relevance. After one half-life untouched, an entry's recall weight halves. `null` (default) = no decay. Journals want short half-lives; axioms want none.
- `conflict_check` — `"annotate"` (default) or `"off"`. When on, creating an entry that's semantically very similar to an existing one returns a `possible_overlap` advisory in the mutate response. Advisory only — never blocks.
- `exclusive_facets` — facet names where only one active entry per value should exist (e.g. `["topic"]` in a decisions pattern). Creating a duplicate returns a `possible_overlap` advisory suggesting supersession.

**Propose, don't impose.** When a pattern reveals its nature — entries that go stale fast, repeated near-duplicates — propose a policy and let the human ratify it. Defaults are deliberately conservative: conflict surfacing on, decay off.

## Decay

Decay affects recall ranking only. Prime's relevance is `similarity × decay(last_touch, half_life)` where `last_touch` is the later of the entry's last update and its last prime hit — being recalled keeps an entry fresh (rehearsal). Faded entries never vanish; they stop volunteering themselves. Query and search are unaffected.

## The stale view

`resolve("{{uri:stale}}")` (optionally `{{uri:stale}}?days=N`) lists entries that haven't been touched or recalled past their pattern's staleness horizon (3× half-life, or 90 days for patterns without one). Superseded entries are flagged. This is a read-only review surface — archiving is always a deliberate act.

## The maintenance pass

When connecting, you may see how long it's been since the last maintenance pass (default interval: 14 days; the human can set charter key `maintenance_interval_days`). When it's overdue, offer the human a cleanup pass — as a focused conversation or a subagent:

1. Review `{{uri:stale}}` and recent `possible_overlap` advisories.
2. Propose supersession links for replaced facts, archival for dead entries, and memory policies for patterns that have revealed their nature.
3. Apply only what the human ratifies.
4. Record the pass: `mutate(pattern: "_maintenance_passes", operation: "create", data: {summary: "what was reviewed and changed"})`.

Never run a destructive cleanup unprompted. The pass is a ritual of curation, not garbage collection.
