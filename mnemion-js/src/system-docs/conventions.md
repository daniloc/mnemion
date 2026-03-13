---
slug: conventions
title: "Conventions"
---
# Conventions

## Vocabulary

{{PRODUCT_NAME}} uses biological vocabulary for its concepts:

| Term | In code | Meaning |
|------|---------|---------|
| **Hive** | instance | The whole {{PRODUCT_NAME}} store — all your patterns, entries, and configuration |
| **Pattern** | object | An organizing structure that defines the shape of data |
| **Entry** | record | An instance within a pattern |
| **Facet** | field | A dimension of an entry |
| **Link** | reference | A connection between entries across patterns |

Tool parameters and URIs use the code terms (`object`, `fields`, `records/{object}/{id}`).

## URI scheme
All {{PRODUCT_NAME}} data is addressable via `{{URI_PREFIX}}` URIs:
- `{{uri:index}}` — the master index
- `{{uri:schema/{object}}}` — facet definitions for a pattern
- `{{uri:records/{object}/{id}}}` — individual entry
- `{{uri:history}}` — schema change log
- `{{uri:_system/{slug}}}` — system documentation

## The index
The index is the single source of truth for what exists in your hive. Read it first in any new session. It contains:
- The hive charter (identity, purpose, principles)
- All patterns with descriptions, doctrines, and facet lists
- Active entry counts
- Guidance text

## Charter
The `_charter` kernel pattern holds the hive's identity as key-value pairs (e.g. owner, purpose, principles). Charter entries are surfaced to every agent on connection via MCP instructions. Use `mutate` on `_charter` to set charter values.

## Visibility model
Entries can be `public` or `private`. This controls marketplace distribution:
- Private: only accessible via authenticated marketplace
- Public: accessible to anyone via public marketplace

## Archiving
`archive` is the only destructive operation, and it's soft — sets `archived_at` timestamp. Archived entries are excluded from queries but never deleted. Recovery is always possible.

## Kernel patterns
Patterns prefixed with `_` are system patterns managed by the kernel:
- `_outputs` — HTTP egress endpoints (see `{{uri:_system/http-io}}`)
- `_inputs` — HTTP ingress endpoints (see `{{uri:_system/http-io}}`)
- `_access_tokens` — unified access tokens with scoped permissions (see `{{uri:_system/remote-access}}`)
- `_shared` — entry-level sharing for HTTP access
- `_plugins`, `_skills` — marketplace content (created on demand)
- `_system_docs` — these documents

Kernel patterns follow the same query/mutate interface as user patterns.

## System docs
System docs (like this one) are editable via `mutate`. Each has a `default_content` facet preserving the original seed. To restore a doc, set `content` to null — resolve will fall back to `default_content`.

Edits to `_system_docs` require confirmation because they affect all future agent sessions.
