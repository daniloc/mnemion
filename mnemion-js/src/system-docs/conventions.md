---
slug: conventions
title: "Conventions"
---
# Conventions

## URI scheme
All {{PRODUCT_NAME}} data is addressable via `{{URI_PREFIX}}` URIs:
- `{{uri:index}}` — the master index
- `{{uri:schema/{object}}}` — object field definitions
- `{{uri:records/{object}/{id}}}` — individual record
- `{{uri:history}}` — schema change log
- `{{uri:_system/{slug}}}` — system documentation

## The index
The index is the single source of truth for what exists. Read it first in any new session. It contains:
- All objects with descriptions and field lists
- Active record counts
- Conventions established for this instance
- Guidance text

## Visibility model
Records can be `public` or `private`. This controls marketplace distribution:
- Private: only accessible via authenticated marketplace
- Public: accessible to anyone via public marketplace

## Archiving
`archive` is the only destructive operation, and it's soft — sets `archived_at` timestamp. Archived records are excluded from queries but never deleted. Recovery is always possible.

## Kernel objects
Objects prefixed with `_` are system objects managed by the kernel:
- `_outputs` — HTTP egress endpoints (see `{{uri:_system/http-io}}`)
- `_inputs` — HTTP ingress endpoints (see `{{uri:_system/http-io}}`)
- `_auth_codes` — one-time auth codes for remote agents (see `{{uri:_system/remote-access}}`)
- `_marketplace_tokens` — scoped access tokens for marketplace
- `_upload_tokens` — temporary capability tokens for large content uploads
- `_plugins`, `_skills` — marketplace content (created on demand)
- `_system_docs` — these documents

Kernel objects follow the same query/mutate interface as user objects.

## System docs
System docs (like this one) are editable via `mutate`. Each has a `default_content` field preserving the original seed. To restore a doc, set `content` to null — resolve will fall back to `default_content`.

Edits to `_system_docs` require confirmation because they affect all future agent sessions.
