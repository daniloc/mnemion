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

Archiving an `_outputs` or `_inputs` entry frees its path for reuse. Active (non-archived) paths must be unique.

## Use cases

- **Egress**: status pages, JSON APIs, public content, badge endpoints
- **Ingress**: GitHub webhooks, form submissions, IoT data, inter-service messaging
