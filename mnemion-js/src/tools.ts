// Tool metadata — single source of truth for MCP registration and frontend display.
//
// session.ts imports these for McpServer.tool() calls.
// /api/tools serves them to the web frontend.

import { URI_SCHEME, uri } from "./constants";

export interface ToolMeta {
  name: string;
  description: string;
  when: string; // human-readable guidance for when to use
}

export const TOOLS: ToolMeta[] = [
  {
    name: "prime",
    description: `Use this to help the user by recalling everything relevant to the current conversation. Pass conversational context and get back the most relevant entries across all patterns, ranked by semantic similarity. Each result includes the full entry, its URI, and any linked entries one hop away.

Write 1-3 natural sentences describing the current conversational focus. Embedding-based retrieval responds better to descriptive language than keyword lists.`,
    when: "First action on connect. When topics shift. When you need to recall what's relevant.",
  },
  {
    name: "mutate",
    description: `Use this to help the user persist knowledge, decisions, and context that should survive beyond this conversation. Create, update, patch, or archive entries — one tool for all writes.

Single: pass pattern + operation (create|update|patch|archive|unarchive) + data.
Batch: pass operation "batch" + data as array of [{pattern, operation, data}, ...] — atomic all-or-nothing, max 100 ops. Combine multiple writes into one call.

Patch: edit a text facet without sending the entire value. Pass {id, facet, match, replacement} — match must appear exactly once in the facet. Token-efficient for large entries.

Update supports optimistic locking: include the version field from a prior read to detect conflicts across concurrent surfaces.

Large content: to write content too large for MCP parameters, create an _access_tokens entry with {scope: "upload", constraints: {target_pattern, target_id, target_facet, mode}}. Returns a single-use token (15-min expiry). POST content to /upload/{token} via HTTP. Resolve ${uri("_system/instance")} for the full upload URL.

Entries limited to ~1 MB each.`,
    when: "Any write. Batch multiple writes into one call for atomicity.",
  },
  {
    name: "query",
    description: `Use this to help the user find specific entries. Read from a pattern with filtering, facet projection, sorting, and limits (max 1,000 rows). Use count_only for efficient counts without fetching entries.

Filter syntax: each filter is "field<op>value". Operators: = != > < >= <= ~ |=
- = != > < >= <= : standard comparisons
- ~ : LIKE substring match (e.g. title~urgent)
- |= : in any of (e.g. id|=1,3,7) — comma-separated values, useful for batched lookups`,
    when: "Reading entries with specific filters. Checking counts without fetching data. Use id|=1,2,3 for batched multi-id lookups.",
  },
  {
    name: "search",
    description: "Use this to help the user find something when you don't know which pattern it's in. Cross-pattern full-text search across all text facets. Returns matching entries with matched facet names.",
    when: "Finding entries by content when you don't know which pattern they're in.",
  },
  {
    name: "resolve",
    description: `Use this to help the user read specific resources, fetch web content, or access system documentation. Accepts ${URI_SCHEME}:// addresses and https:// URLs. Returns linked entries one hop deep for entry URIs.

Valid URIs:
- ${uri("index")} — master index (orientation, what patterns exist)
- ${uri("schema/{pattern}")} — facet definitions for a pattern
- ${uri("entry/{pattern}/{id}")} — a single entry
- ${uri("history")} — schema change log (supports ?limit=N)
- ${uri("_system/")} — list all system docs
- ${uri("_system/{slug}")} — read a system doc (tools, schema-evolution, skills, index-guide, conventions)
- ${uri("_system/{slug}/default")} — read original seed version
- ${uri("mutation")} — mutation audit log (supports ?limit=N). Use for diagnostics and integrity checks.
- ${uri("mutation/{pattern}")} — mutations filtered to one pattern

Web URLs: use this to help the user read web pages and social threads. Pass any https:// URL to fetch and cache the content.
- Bluesky threads (bsky.app/profile/*/post/* or at://*/app.bsky.feed.post/* at-uris) are fetched via AT Protocol API — no scraping needed. Quoted posts, image embeds (with alt text), external links, and video are surfaced inline. Append ?depth=N (0-100, default 6) to control how many levels of nested replies/subtrees are returned — raise it to pull a whole conversation.
- Other URLs use Cloudflare Browser Rendering (requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN secrets).
- Cached content appears in prime results for future recall.
- Stale cache returned if re-fetch fails.

Federation: use this to help the user access content on other hives.
- ${URI_SCHEME}://host.example.com/path → GET https://host.example.com/o/path
- Private access: append ?token=<auth_code> for Bearer authentication
- Public responses are cached at the Cloudflare edge`,
    when: "Following URIs from prime results. Reading system docs. Cross-hive federation. Reading web pages and social threads.",
  },
  {
    name: "propose_change",
    description: `Use this to help the user evolve the structure of their hive. Propose a structural change — validates and returns a preview without committing.

Supports: create_pattern (with facets), add_facet (to existing pattern), set_sharing (entry-level HTTP visibility), set_options, set_doctrine, archive_pattern, unarchive_pattern.
Facets can declare foreign key links to other patterns via the links parameter.
Pattern/facet names: lowercase, a-z/0-9/hyphens/underscores, max 64 chars. Max 64 facets per pattern.

set_sharing: use this to help the user control HTTP access to individual entries at /o/entry/{pattern}/{id}.
- "public": openly readable, edge-cached
- "unlisted": readable with valid auth code token (anyone-with-the-link)
- "private": not served (removes sharing)`,
    when: "Before any structural change. Returns a preview diff without committing.",
  },
  {
    name: "apply_change",
    description: `Use this to help the user commit a proposed change, or recover from mistakes via point-in-time restore.

For apply: pass change_id from propose_change.
For revert: pass revert_history_id (from ${uri("history")}). Restores ALL data (not just schema) to the state before that change — destructive, requires confirmation.`,
    when: "After reviewing a propose_change preview. Accepts the change_id from the proposal.",
  },
];
