---
slug: index-guide
title: "Reading the Index"
---
# Reading the Index

`{{uri:index}}` is your starting point every session. Here's how to interpret it.

## Structure
```json
{
  "version": 5,
  "updated_at": "2025-...",
  "objects": [...],
  "conventions": [...],
  "guidance": "..."
}
```

Note: The JSON uses code terms (`objects`, `fields`, `record_count`). See `{{uri:_system/conventions}}` for vocabulary.

## Patterns (`objects` array)
Each item describes a pattern in the hive:
- `name`: the pattern identifier (used in queries and URIs)
- `description`: what this pattern holds and why
- `fields`: array of {name, type, required, default} — the pattern's facets
- `record_count`: current active (non-archived) entries

Use `record_count` to gauge activity. Zero-count patterns may be unused or newly created.

## Conventions
Established rules and guidance:
- Naming conventions
- Workflow rules
- Domain-specific guidance

Conventions are added via `propose_change` with type `add_convention`.

## Guidance
Free-text orientation. On a fresh hive: "No objects exist yet." After schema creation: "{{PRODUCT_NAME}} is active."

The guidance evolves as the hive grows. It's a one-liner for fast orientation.

## What to do after reading the index
1. Scan patterns and entry counts for orientation
2. If you need details on a pattern's facets, resolve `{{uri:schema/{name}}}`
3. Query patterns with recent activity (`sort=-updated_at`, `limit=5`)
4. Check conventions for any rules to follow
