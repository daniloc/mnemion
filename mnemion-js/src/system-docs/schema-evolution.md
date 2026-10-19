---
slug: schema-evolution
title: "Schema Evolution"
---
# Schema Evolution

Patterns are created through `propose_change` / `apply_change`. This is a two-step process: propose validates and returns a preview; apply commits the change to SQLite and the index.

## Naming conventions
- Pattern names: kebab-case (e.g. `research-threads`, `daily-notes`)
- Facet names: snake_case (e.g. `due_date`, `source_url`)
- Patterns starting with `_` are kernel/system patterns (e.g. `_plugins`, `_skills`, `_system_docs`)

## Facet types
`text`, `number`, `integer`, `boolean`, `datetime`, `select`

`select` requires an `options` array of allowed string values. Mutation validates against the list.

## Kernel columns (auto-provided, never define these)
`id`, `created_at`, `updated_at`, `archived_at`

Every pattern gets these automatically. Do not include them in `propose_change` facet lists.

## Doctrine (required)
Every pattern has a `doctrine` — a statement of how the pattern should be used. Doctrine is required on `create_pattern`. It tells agents when and how to create entries, what invariants to maintain, and what to avoid. Read the doctrine before writing to any pattern.

## When to create a new pattern vs. add facets
- New pattern: the data represents a distinct concept with its own lifecycle
- Add facets: the data extends an existing concept (e.g. adding `priority` to `tasks`)

## When to evolve schema
- When the work demands a new shape. Don't pre-create patterns speculatively.
- When existing facets can't represent what's needed. Add facets rather than overloading existing ones.
- When the human says "track X" or "I need to remember Y" — that's a schema evolution signal.

## Archiving vs. deletion
{{PRODUCT_NAME}} never deletes. `archive` sets `archived_at`, excluding the entry from queries. The data persists for history and recovery.

## Decommissioning a pattern

When a pattern is no longer needed, decommission it cleanly:

1. **Export**: download the pattern as a zip from `https://{host}/export/{pattern}` (requires session login). The zip contains `_pattern.yml` (schema, doctrine, facets, links) and one markdown file per entry with YAML frontmatter.
2. **Archive**: `propose_change` with `archive_pattern` + `apply_change`. The pattern disappears from the index. Entries remain in SQLite for 30 days, then GC drops the table.

Always export before archiving — there is no undo after GC. The export is the pattern's portable archive, readable by humans and reimportable by future agents.

## Links between entries

Use the `_links` pattern instead of storing IDs in text fields. A link's label names a **declared relation**, and relations are schema: declared, evolved and enforced like patterns and facets. The vocabulary is `{{uri:relations}}` (also the index's `relations` key) — each relation's name, inverse, description, the patterns it joins, its cardinality and behaviors.

- **Link**: `mutate(pattern: "link", data: {source: "tasks/6", target: "goals/9", label: "references"})`
- **Inverse wording**: `label: "referenced-by"` with source and target swapped writes the same link; it is stored in canonical direction.
- **Unlink**: `mutate(pattern: "unlink", data: {source: "tasks/6", target: "goals/9", label: "references"})`. `label` is optional when the pair carries one link; when it carries several, unlink refuses and names them.

Kernel defaults every hive has: `supersedes` (the target is replaced current truth), `references` (the honest generic link — use it when nothing more specific fits), `depends-on`, `derived-from` (provenance) and `part-of` (hierarchy). The last four are acyclic.

The write is checked at one chokepoint: an undeclared label is refused, and the refusal lists the relations declared for that pair of patterns. The relation must admit both patterns, endpoints must exist and be active, one pair carries each relation at most once, cardinality `one` allows a single link per source entry, and an `acyclic` relation refuses a link that would close a cycle. Kernel patterns are never link sources; `_documents` and `_web_cache` may be targets, and a link protects its target from garbage collection.

Links are immutable: endpoints and relation never change after create. To move or relabel a link, archive it and create a new one. Unarchiving re-runs every check.

Archiving an entry (or a pattern) leaves its links in place but dormant: reads stop showing them, they still count toward uniqueness and cardinality (and a dormant link still closes a cycle), and they come back unchanged when the entry is unarchived. A link is removed only when an endpoint is gone for good.

A link protects its target from garbage collection: a linked `_web_cache` snapshot is never collected, and an archived pattern that an active link from outside it still points into is not dropped after its 30 days — it stays archived, its links dormant, until those links are archived. Links internal to the pattern don't protect it.

Reading: `resolve` lists linked entries one per link, each with `direction` (`out` — this entry is the source; `in` — the target) and `relation`, the name read from this entry's side (`depends-on` out, `required-by` in).

## Evolving the relation vocabulary

Prefer a kernel default. Declare a relation when a connection means something none of them says — and in an analytical pattern the kind of connection often *is* the content.

- **`declare_relation`**: `name` (kebab-case, immutable), `inverse`, `description` (at least 120 characters: what it asserts, when to use it rather than its nearest neighbour, one example in canonical direction), `source` and `target` (pattern lists, or `["*"]` for any user pattern; `_documents`/`_web_cache` allowed as targets), `cardinality` (`one` | `many`, default `many`), `behaviors` (a subset of the palette).
- **`amend_relation`**: `name` plus any of `description`, `inverse`, `behaviors`, `cardinality`. Kernel defaults can't be amended.
- **`retire_relation`**: `name`. Refused while active links use it.

Behavior palette: `supersession` (the target is demoted as replaced — see the memory-maintenance doc) and `acyclic` (no cycles). A behavior is declared, never coded: the engine performs each one at a single place.

Explicit `null` is refused for every field — omit a field to leave it out; `null` never means "use the default" or "clear it".

If existing links would violate an amend (a second link from one source under cardinality `one`, a cycle under `acyclic`) or a retire, the proposal lists them in `preview.violations` and `apply_change` is refused until they are archived or moved — it re-checks against the data at apply time.

**Legacy relations.** Labels in use before the registry were declared automatically, flagged `legacy`, with a placeholder description; their patterns were inferred from usage. Pay the debt down with `amend_relation` and a real description — that clears the flag. Cycles that pre-registry data already holds across an acyclic relation are reported at boot and left in place; propose which link to archive and let the owner ratify.
