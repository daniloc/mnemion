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

## Objects array
Each entry describes an object:
- `name`: the object identifier (used in queries and URIs)
- `description`: what this object holds and why
- `fields`: array of {name, type, required, default} — the object's schema
- `record_count`: current active (non-archived) records

Use `record_count` to gauge activity. Zero-count objects may be unused or newly created.

## Conventions
Text entries the human or agent has established:
- Naming patterns
- Workflow rules
- Domain-specific guidance

Conventions are added via `propose_change` with type `add_convention`.

## Guidance
Free-text orientation. On a fresh instance: "No objects exist yet." After schema creation: "{{PRODUCT_NAME}} is active."

The guidance evolves as the instance grows. It's a one-liner for fast orientation.

## What to do after reading the index
1. Scan objects and record counts for orientation
2. If you need details on an object's fields, resolve `{{uri:schema/{name}}}`
3. Query objects with recent activity (`sort=-updated_at`, `limit=5`)
4. Check conventions for any rules to follow
