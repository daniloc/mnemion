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

- **Inline on create** (`_relate`): `mutate(pattern: "tasks", operation: "create", data: {title: "Ship capture", _relate: {"belongs-to": "projects/1", "derived-from": ["inbox/42"]}})`. Keys are relation names or inverses, values one `"pattern/id"` or a list. The entry and every link are written in one transaction: any refused link refuses the create and leaves nothing behind. The response carries `links: [{id, source, target, label}]`. `_relate` is accepted only on create.
- **In batches**: `{pattern: "link", data: {…}}` and `{pattern: "unlink", data: {…}}` items expand exactly as single mutates do; their `operation` may be omitted. A refused link rolls the whole batch back.

Kernel defaults every hive has: `supersedes` (the target is replaced current truth), `references` (the honest generic link — use it when nothing more specific fits), `depends-on`, `derived-from` (provenance) and `part-of` (hierarchy, with the `containment` behavior). The last four are acyclic.

The write is checked at one chokepoint: an undeclared label is refused, and the refusal lists the relations declared for that pair of patterns. The relation must admit both patterns, endpoints must exist and be active, one pair carries each relation at most once, cardinality `one` allows a single link per source entry, and an `acyclic` relation refuses a link that would close a cycle. Kernel patterns are never link sources; `_documents` and `_web_cache` may be targets, and a link protects its target from garbage collection.

Links are immutable: endpoints and relation never change after create. To move or relabel a link, archive it and create a new one. Unarchiving re-runs every check.

Archiving an entry (or a pattern) leaves its links in place but dormant: reads stop showing them, they still count toward uniqueness and cardinality (and a dormant link still closes a cycle), and they come back unchanged when the entry is unarchived. A link is removed only when an endpoint is gone for good.

A link protects its target from garbage collection: a linked `_web_cache` snapshot is never collected, and an archived pattern that an active link from outside it still points into is not dropped after its 30 days — it stays archived, its links dormant, until those links are archived. Links internal to the pattern don't protect it.

Reading: `resolve` lists linked entries one per link, each with `direction` (`out` — this entry is the source; `in` — the target) and `relation`, the name read from this entry's side (`depends-on` out, `required-by` in). Derived (chain) relations appear too, flagged `derived: true`.

### Required relations

A relation declared `required: true` (its `source` must be an explicit pattern list, never `*`) means every active entry of those source patterns holds at least one link of it:

- A create in a source pattern must carry the link in `_relate`, or it is refused, naming the relation and target.
- Removing an entry's last link of it (archive or unlink) is refused. To change it, **move** it: archive the old link and create the new one in one batch — required is judged on the batch's end state, so either order works.
- An archived entry is exempt while archived; unarchiving it without the link is refused (unarchive and link in one batch).
- `required: true` can't be set while a source pattern is archived (its entries couldn't be backfilled): unarchive, backfill, then flip. `unarchive_pattern` of a required relation's source lists the entries lacking the link in `preview.violations` and is refused at apply until they're resolved.
- Declaring or amending to `required: true` lists every entry lacking the link in `preview.violations`; apply is refused until they are backfilled. Entries that lack one anyway (older data) are reported at boot, never repaired.

### Containment

A relation with the `containment` behavior says the source is part of the target:

- Archiving a container with active members is refused, naming the members. Archive or move the members first — or in the same batch, in any order. Archived members don't count, and other relations never block.
- `archive_pattern` on a pattern whose entries contain active members from other patterns lists them in `preview.violations` and is refused at apply.
- Unarchiving a member whose container is archived (the entry or its pattern) is refused; unarchive both in one batch. `unarchive_pattern` of a member pattern lists members that would sit under an archived container in `preview.violations`, and `amend_relation` adding `containment` lists existing archived containers with active members — apply is refused while any remain.
- Recall goes upward only: prime follows member → container, never container → members. `resolve` of a container still lists its members, under the inverse name.

### Derived relations

A relation declared with `chain: ["belongs-to", "serves"]` is derived: computed at read time by composing stored relations, never written. It declares only `name`, `inverse` and `description` — its ends are the first step's source and the last step's target. The steps must be at least two active stored relations whose ends compose. Writing a derived name (by link, inverse or `_relate`) is refused, naming the stored steps. `resolve` lists derived connections with `derived: true`, through active links between active entries only. A stored relation that a chain uses can't be retired until the chain is.

## Evolving the relation vocabulary

Prefer a kernel default. Declare a relation when a connection means something none of them says — and in an analytical pattern the kind of connection often *is* the content.

- **`declare_relation`**: `name` (kebab-case, immutable), `inverse` (the `<name>-inverse` form is reserved for the legacy migration), `description` (at least 120 characters: what it asserts, when to use it rather than its nearest neighbour, one example in canonical direction), `source` and `target` (pattern lists, or `["*"]` for any user pattern; `_documents`/`_web_cache` allowed as targets), `cardinality` (`one` | `many`, default `many`), `behaviors` (a subset of the palette), `required` (see above) — or `chain` for a derived relation.
- **`amend_relation`**: `name` plus any of `description`, `inverse`, `behaviors`, `cardinality`, `required`. Kernel defaults can't be amended; a derived relation amends only its description and inverse.
- **`retire_relation`**: `name`. Refused while active links use it, or while a chain uses it as a step.

Behavior palette: `supersession` (the target is demoted as replaced — see the memory-maintenance doc), `acyclic` (no cycles) and `containment` (see above). A behavior is declared, never coded: the engine performs each one at a single place.

Explicit `null` is refused for every field — omit a field to leave it out; `null` never means "use the default" or "clear it".

If existing data would violate a declare or amend (an entry lacking a now-required link, a second link from one source under cardinality `one`, a cycle under `acyclic`) or a retire, the proposal lists it in `preview.violations` and `apply_change` is refused until it is fixed — it re-checks against the data at apply time.

**Legacy relations.** Labels in use before the registry were declared automatically, with a placeholder description and a generated `<name>-inverse`; their patterns were inferred from usage. Legacy status is derived, never stored: `legacy_debt` lists what remains (`placeholder description`, `generated inverse`) and `legacy` is true while either does. Pay both with `amend_relation` — a real description and an owner-chosen inverse, in one amend or two. Cycles that pre-registry data already holds across an acyclic relation are reported at boot and left in place; propose which link to archive and let the owner ratify.

## Dropping a facet

`propose_change(type: "drop_facet", pattern_name, facet)` removes a facet's column and its data. The preview's `non_null_values` counts the rows (active and archived) that hold a value — what the drop loses. Like every applied change it is logged in `{{uri:history}}` with a PITR bookmark captured just *before* it ran. Reverting that row (`apply_change` with `revert_history_id`, a confirmation round-trip) restores the whole hive — data and schema — to the moment before the drop, so anything written since is rolled back too. Where no bookmark could be captured (local dev), revert reports rollback unavailable.

It is refused while anything still names the facet — a memory policy's `exclusive_facets`, a view spec, a publication's filters/facets/sort/template, a clipboard rule, an ingress endpoint's `body_facet` or `facet_mapping`, or a live (unconsumed, unexpired) upload token targeting it. The preview lists them in `preview.facet_references`; remove them first (apply re-checks). It is also refused for kernel patterns and kernel columns, for a pattern's only facet, and for a reference (`links`) facet, which is retired by migrating it to a relation instead.

## Dates

A `datetime` facet stores ISO 8601 in every user pattern, knowledge or dataset: a date-only value ("March 7, 2026") as `YYYY-MM-DD`, anything with a time of day as a full UTC timestamp. Only a full date counts: periods ("2026", "2026-03", "March 2026"), days that don't exist ("2026-02-30") and relative phrases ("next week", "Q2") are refused — resolving a period or phrase to a specific day, against the moment of writing, is the writer's job. The same rule applies to uploads into a datetime facet. Values written before this rule stay as they are until that facet is written again.
