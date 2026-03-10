---
slug: tools
title: "Tool Strategy"
---
# Tool Strategy

{{PRODUCT_NAME}} has six tools. They never grow — new capabilities come from patterns and entries, not new tools.

See `{{uri:_system/conventions}}` for vocabulary (pattern, entry, facet, link) and how it maps to code terms.

## resolve
Read anything by `{{URI_PREFIX}}` URI. The URI scheme is the API.
- `{{uri:index}}` — master index. Read this first.
- `{{uri:schema/{object}}}` — facet definitions for a pattern
- `{{uri:records/{object}/{id}}}` — a single entry
- `{{uri:history}}` — recent schema changes (supports `?limit=N`)
- `{{uri:_system/{slug}}}` — system documentation (you're reading one now)
- `{{uri:_system/}}` — list all system docs
- `{{uri:mutations}}` — audit log of all data mutations (supports `?limit=N`)
- `{{uri:mutations/{object}}}` — audit log filtered to one pattern

## query
Filtered, sorted, paginated reads from a single pattern.
- `filter`: array of expressions like `status=active`, `priority>3`, `title~keyword`
- `fields`: comma-separated facet projection (default: all)
- `sort`: facet name, prefix `-` for descending (e.g. `-updated_at`)
- `count_only`: return count without entries — use this before large queries
- Max 1,000 rows per query (limit is silently clamped).

## search
Cross-pattern full-text search across all text facets. Use when you don't know which pattern holds what you need.

## mutate
Create, update, or archive entries. One tool for all writes.
- `create`: provide facet values, kernel columns (id, timestamps) are auto-set
- `update`: provide `id` + facets to change. Include `version` for optimistic locking (prevents lost updates when multiple surfaces write concurrently).
- `archive`: provide `id` only — soft-deletes, never destroys data
- `batch`: pass an array of {object, operation, data} for atomic all-or-nothing execution (max 100 ops)

Entries are limited to ~1 MB each.

## propose_change / apply_change
Two-step schema evolution. Propose validates and previews. Apply commits.
- `create_object`: new pattern with facets (max 64 facets per pattern)
- `add_field`: add facets to an existing pattern
- `add_convention`: add a convention to the index
- Facets support `references` for links to other patterns.
- `apply_change` also supports `revert_history_id` for point-in-time rollback via Cloudflare PITR (30-day window). This is destructive — restores all data, not just schema.

Pattern names: lowercase, start with letter, a-z/0-9/hyphens/underscores, max 64 chars. Facet names: same rules.

Schema changes are permanent and logged in `{{uri:history}}`. Propose first, review the preview, then apply.

## Large content uploads

When content is too large for MCP tool parameters (e.g. research results, file contents), use the upload token flow:

1. Mint a token: `mutate({ object: "_upload_tokens", operation: "create", data: { target_object, target_id, target_field, mode } })`
2. POST content: `curl -X POST https://<host>/upload/<token> -d @file.txt`

Properties:
- `mode`: `replace` (default) overwrites the facet, `append` concatenates to existing content
- Token expires after 15 minutes and is single-use
- Target pattern, entry, and facet are validated at mint time; facet must be `text` type
- The token IS the auth — no other credentials needed (capability URL pattern)
- Same 1 MB entry limit applies

## HTTP I/O

{{PRODUCT_NAME}} can expose data over plain HTTP and accept inbound data from webhooks. These are configured as entries, not code. See `{{uri:_system/http-io}}` for full details.

- **Egress** (`_outputs`): serve content at `GET /o/{path}`
- **Ingress** (`_inputs`): accept POST data at `POST /i/{path}`, create entries in a target pattern

Both are managed via `mutate` on the respective kernel patterns.

## When to use what
- Know exactly what you want → `resolve` with a URI
- Need filtered/sorted data → `query`
- Exploring, don't know where something is → `search`
- Writing data → `mutate`
- Writing large text content → upload token flow (mint via `mutate`, POST via HTTP)
- Serving content over HTTP → create `_outputs` entries
- Receiving webhooks/POST data → create `_inputs` entries
- Changing structure → `propose_change` then `apply_change`
- Reviewing data history → `resolve` with `{{uri:mutations}}`
