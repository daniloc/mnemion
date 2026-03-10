---
slug: schema-evolution
title: "Schema Evolution"
---
# Schema Evolution

Objects are created through `propose_change` / `apply_change`. This is a two-step process: propose validates and returns a preview; apply commits the change to SQLite and the index.

## Naming conventions
- Object names: kebab-case (e.g. `research-threads`, `daily-notes`)
- Field names: snake_case (e.g. `due_date`, `source_url`)
- Objects starting with `_` are kernel/system objects (e.g. `_plugins`, `_skills`, `_system_docs`)

## Field types
`text`, `number`, `integer`, `boolean`, `datetime`

## Kernel columns (auto-provided, never define these)
`id`, `created_at`, `updated_at`, `archived_at`

Every object gets these automatically. Do not include them in `propose_change` field lists.

## When to create a new object vs. add fields
- New object: the data represents a distinct concept with its own lifecycle
- Add field: the data extends an existing concept (e.g. adding `priority` to `tasks`)

## When to evolve schema
- When the work demands a new shape. Don't pre-create objects speculatively.
- When existing fields can't represent what's needed. Add fields rather than overloading existing ones.
- When the human says "track X" or "I need to remember Y" — that's a schema evolution signal.

## Archiving vs. deletion
{{PRODUCT_NAME}} never deletes. `archive` sets `archived_at`, excluding the record from queries. The data persists for history and recovery.
