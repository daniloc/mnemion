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
`text`, `number`, `integer`, `boolean`, `datetime`

## Kernel columns (auto-provided, never define these)
`id`, `created_at`, `updated_at`, `archived_at`

Every pattern gets these automatically. Do not include them in `propose_change` facet lists.

## When to create a new pattern vs. add facets
- New pattern: the data represents a distinct concept with its own lifecycle
- Add facets: the data extends an existing concept (e.g. adding `priority` to `tasks`)

## When to evolve schema
- When the work demands a new shape. Don't pre-create patterns speculatively.
- When existing facets can't represent what's needed. Add facets rather than overloading existing ones.
- When the human says "track X" or "I need to remember Y" — that's a schema evolution signal.

## Archiving vs. deletion
{{PRODUCT_NAME}} never deletes. `archive` sets `archived_at`, excluding the entry from queries. The data persists for history and recovery.
