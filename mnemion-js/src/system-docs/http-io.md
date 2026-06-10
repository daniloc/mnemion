---
slug: http-io
title: "HTTP I/O"
---
# HTTP I/O

{{PRODUCT_NAME}} can serve content and accept inbound data over plain HTTP. No MCP client needed — just a URL.

## Egress: `_outputs`

Create an entry in `_outputs` to serve content at a public URL.

```
mutate _outputs create { "path": "hello", "content": "<h1>Hello</h1>", "mime_type": "text/html" }
```

The content is now available at `GET /o/hello`.

### Facets
- `path` (required) — URL path segment (no leading slash). Must be unique among active entries.
- `content` (required) — the response body
- `mime_type` — Content-Type header (default: `text/plain`)
- `visibility` — `public` (default) or `private`. Private outputs require a valid auth code as bearer token.

### Updating content
`mutate _outputs update { "id": 1, "version": 0, "content": "new content" }`

### Freeing a path
Archive the entry. The path becomes available for a new entry immediately.

## Publications: `_publications`

Where `_outputs` serves static content you wrote, a publication serves a **live projection of a pattern** — the query runs at request time, so the page is never stale. This is the hive's publication surface: status pages, feeds, reading lists, public knowledge bases.

```
mutate _publications create {
  "path": "now",
  "title": "What I'm working on",
  "source_pattern": "tasks",
  "filters": "[\"status=in-progress\"]",
  "format": "html"
}
```

The projection is now served at `GET /p/now`, re-derived from current entries on every request (edge-cached ~60s when public).

**Publishing requires explicit human approval** — creating a publication serves every current AND future entry the query matches. The mutate call requires a confirmation round-trip.

### Facets
- `path` (required) — URL path segment, unique among active publications
- `source_pattern` (required) — pattern to project; user patterns only (kernel patterns are never publishable)
- `format` (required) — `html`, `rss`, `json`, or `markdown` (markdown ships YAML frontmatter: title, path, source_pattern, generated_at, count)
- `title` — page/feed title (defaults to path)
- `filters` — JSON array of query filter strings, e.g. `["status=done", "title~urgent"]`
- `facets` — comma-separated projection (default: all)
- `sort` — sort facet, `-` prefix for descending (default `-updated_at`)
- `limit` — max entries (default 50)
- `template` — per-entry template seam: `{{facet}}` placeholders plus `{{_label}}`, `{{_uri}}`, `{{_id}}`, `{{_updated_at}}`. Template text passes through raw (write markup if you like); substituted values are HTML-escaped in html/rss output. No conditionals or loops.
- `css` — appended after the default styles in html output (the override seam)
- `visibility` — `public` (default), `unlisted` (requires bearer token with `read:publication:{path}` scope), or `private` (staged, not served)
- `include_superseded` — publications exclude superseded entries by default; set true to include them

### Current truth by default
Entries targeted by an active `supersedes` link are dropped from publications unless `include_superseded` is set — public projections show what's current, not what was replaced.

## Documents: `_documents`

A document is a file whose **bytes live in R2**, with a `_documents` entry holding the metadata. Use it for PDFs, images, and anything binary or larger than the 1 MB entry limit. The entry is the evolvable knowledge layer; the file is immutable truth it points at — link documents to other entries like any pattern.

> **Requires R2.** File storage depends on Cloudflare R2, which is optional. If it isn't enabled on this instance, creating a `_documents` entry still works but the response carries a `documents_note` saying uploads are unavailable, and `POST /f` returns 503. Everything else in Mnemion works without R2.

> **Search:** a document's metadata (title, description, tags) is searchable via `search` and surfaces in `prime` like any entry — but the file's *contents* are not yet extracted or indexed. Give documents descriptive titles/tags and link them to text entries so they're findable through their neighbors.

Two-step upload:

```
mutate _documents create { "title": "Q3 report", "description": "...", "tags": "finance,2026" }
```

The create response includes a single-use `upload_url`. POST the file bytes there:

```
curl -X POST --data-binary @report.pdf -H "Content-Type: application/pdf" <upload_url>
```

The file is now stored and served at `GET /f/{id}`.

### Facets
- `title` (required) — display name; used as the download filename
- `description`, `tags` — your metadata, free-form
- `visibility` — `private` (default, not served), `unlisted` (token), or `public`
- `content_type`, `size`, `r2_key`, `stored_at` — **system-managed**; filled on upload, never set them yourself

### Upload tokens
Creating a document auto-mints a `document`-scoped access token bound to that entry — single-use, 15-minute TTL, returned as `upload_url`. Tokens are only mintable through an authenticated `mutate`, so only you can authorize a file write. Upload tokens can never target a kernel pattern.

### Serving and visibility
`GET /f/{id}` streams the file with its stored `Content-Type`. Add `?download=1` for an attachment disposition. Visibility gates access exactly like shared entries: `private` → 404, `unlisted` → requires a bearer token with `read:document:{id}` scope, `public` → open and edge-cached. **Making a document non-private is consent-gated** — creating/uploading a private file is friction-free; publishing one requires a confirmation round-trip.

### Lifecycle
Files cap at 25 MB. Archiving a document entry deletes both the metadata and the R2 object. Documents don't yet surface in `prime` (text extraction is a future capability) — link them to text entries so they're reachable through their neighbors.

## Ingress: `_inputs`

Create an entry in `_inputs` to accept POST data and automatically create entries in a target pattern.

```
mutate _inputs create {
  "path": "webhook",
  "target_object": "events",
  "field_mapping": "{\"title\": \"data.title | truncate 100\", \"source\": \"$header.X-Source | default \\\"unknown\\\"\", \"payload\": \"$body\"}"
}
```

Now `POST /i/webhook` with a JSON body creates an entry in `events`.

### Facets
- `path` (required) — URL path segment. Must be unique among active entries.
- `target_object` (required) — which pattern to create entries in (must exist)
- `field_mapping` — JSON mapping target facets to transform expressions (see below)
- `body_field` — simple mode: store the raw POST body in this single facet
- `visibility` — `public` (default) or `private`

Use `field_mapping` OR `body_field`, not both. If neither is set, the raw body is stored as `body` on the target.

### Transform DSL (field_mapping)

The mapping value is a JSON object where keys are target facet names and values are transform expressions.

**Resolvers** (left side of pipe):
- `data.title` — dot-path into the JSON body
- `$body` — the raw POST body as a string
- `$header.X-Name` — request header (case-insensitive)
- `$query.param` — query parameter from the URL
- `$now` — current ISO 8601 timestamp
- `"literal"` — a quoted literal string

**Transforms** (pipe-separated, applied left to right):
- `truncate N` — limit to N characters
- `lower` / `upper` — case conversion
- `default "value"` — fallback if null/undefined
- `json` — parse a JSON string into an object
- `join ", "` — join an array with separator

**Example**: `data.tags | join ", " | truncate 200`

### Visibility and auth
- `public` inputs accept POST from anyone (webhook use case)
- `private` inputs require a bearer token (auth code) in the Authorization header

## Path reuse

Archiving an `_outputs`, `_inputs`, or `_publications` entry frees its path for reuse. Active (non-archived) paths must be unique within each kind.

## Use cases

- **Publications**: now pages, RSS feeds from any pattern, public reading lists, knowledge bases, dashboards — anything that should track live data
- **Egress**: static content, badge endpoints, hand-built pages
- **Ingress**: GitHub webhooks, form submissions, IoT data, inter-service messaging
