---
slug: tools
title: "Tool Strategy"
---
# Tool Strategy

{{PRODUCT_NAME}} has six tools. They never grow — new capabilities come from schema and records, not new tools.

## resolve
Read anything by `{{URI_PREFIX}}` URI. The URI scheme is the API.
- `{{uri:index}}` — master index. Read this first.
- `{{uri:schema/{object}}}` — field definitions for an object
- `{{uri:records/{object}/{id}}}` — a single record
- `{{uri:history}}` — recent schema changes (supports `?limit=N`)
- `{{uri:_system/{slug}}}` — system documentation (you're reading one now)
- `{{uri:_system/}}` — list all system docs
- `{{uri:mutations}}` — audit log of all data mutations (supports `?limit=N`)
- `{{uri:mutations/{object}}}` — audit log filtered to one object

## query
Filtered, sorted, paginated reads from a single object.
- `filter`: array of expressions like `status=active`, `priority>3`, `title~keyword`
- `fields`: comma-separated projection (default: all)
- `sort`: field name, prefix `-` for descending (e.g. `-updated_at`)
- `count_only`: return count without records — use this before large queries
- Max 1,000 rows per query (limit is silently clamped).

## search
Cross-object full-text search across all text fields. Use when you don't know which object holds what you need.

## mutate
Create, update, or archive records. One tool for all writes.
- `create`: provide field values, kernel columns (id, timestamps) are auto-set
- `update`: provide `id` + fields to change. Include `version` for optimistic locking (prevents lost updates when multiple surfaces write concurrently).
- `archive`: provide `id` only — soft-deletes, never destroys data
- `batch`: pass an array of {object, operation, data} for atomic all-or-nothing execution (max 100 ops)

Records are limited to ~1 MB each.

## propose_change / apply_change
Two-step schema evolution. Propose validates and previews. Apply commits.
- `create_object`: new object with fields (max 64 fields per object)
- `add_field`: add fields to an existing object
- `add_convention`: add a convention to the index
- Fields support `references` for foreign keys to other objects.
- `apply_change` also supports `revert_history_id` for point-in-time rollback via Cloudflare PITR (30-day window). This is destructive — restores all data, not just schema.

Object names: lowercase, start with letter, a-z/0-9/hyphens/underscores, max 64 chars. Field names: same rules.

Schema changes are permanent and logged in `{{uri:history}}`. Propose first, review the preview, then apply.

## Large content uploads

When content is too large for MCP tool parameters (e.g. research results, file contents), use the upload token flow:

1. Mint a token: `mutate({ object: "_upload_tokens", operation: "create", data: { target_object, target_id, target_field, mode } })`
2. POST content: `curl -X POST https://<host>/upload/<token> -d @file.txt`

Properties:
- `mode`: `replace` (default) overwrites the field, `append` concatenates to existing content
- Token expires after 15 minutes and is single-use
- Target object, record, and field are validated at mint time; field must be `text` type
- The token IS the auth — no other credentials needed (capability URL pattern)
- Same 1 MB record limit applies

## HTTP I/O

{{PRODUCT_NAME}} can expose data over plain HTTP and accept inbound data from webhooks. These are configured as records, not code. See `{{uri:_system/http-io}}` for full details.

- **Egress** (`_outputs`): serve content at `GET /o/{path}`
- **Ingress** (`_inputs`): accept POST data at `POST /i/{path}`, create records in a target object

Both are managed via `mutate` on the respective kernel objects.

## When to use what
- Know exactly what you want → `resolve` with a URI
- Need filtered/sorted data → `query`
- Exploring, don't know where something is → `search`
- Writing data → `mutate`
- Writing large text content → upload token flow (mint via `mutate`, POST via HTTP)
- Serving content over HTTP → create `_outputs` records
- Receiving webhooks/POST data → create `_inputs` records
- Changing structure → `propose_change` then `apply_change`
- Reviewing data history → `resolve` with `{{uri:mutations}}`
