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
    description: `Auto-associative priming. Pass conversational context and get back the most relevant entries across all patterns, ranked by semantic similarity. Each result includes the full entry, its URI, and any linked entries one hop away.

Use prime when starting a session, changing topics, or whenever you need to recall what's relevant to the current conversation. It replaces the pattern of reading the index then querying — instead, describe what you're thinking about and the hive activates.`,
    when: "First action on connect. When topics shift. When you need to recall what's relevant.",
  },
  {
    name: "mutate",
    description: `Create, update, or archive entries. One tool for all writes.

Single: pass pattern + operation (create|update|archive) + data.
Batch: pass operation "batch" + data as array of [{pattern, operation, data}, ...] — atomic all-or-nothing, max 100 ops. Combine multiple writes into one call.

Update supports optimistic locking: include the version field from a prior read to detect conflicts across concurrent surfaces.

Large content: to write content too large for MCP parameters, create an _access_tokens entry with {scope: "upload", constraints: {target_pattern, target_id, target_facet, mode}}. Returns a single-use token (15-min expiry). POST content to /upload/{token} via HTTP.

Entries limited to ~1 MB each.`,
    when: "Any write. Batch multiple writes into one call for atomicity.",
  },
  {
    name: "query",
    description: "Read entries from a pattern. Supports filtering, facet projection, sorting, limits (max 1,000 rows). Use count_only for efficient counts without fetching entries.",
    when: "Reading entries with specific filters. Checking counts without fetching data.",
  },
  {
    name: "search",
    description: "Cross-pattern full-text search. Searches all text facets across all patterns (or specified patterns) for a term. Returns matching entries with matched facet names.",
    when: "Finding entries by content when you don't know which pattern they're in.",
  },
  {
    name: "resolve",
    description: `Read anything by its ${URI_SCHEME}:// address or https:// URL. Returns linked entries one hop deep for entry URIs.

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

Web URLs: pass any https:// URL to fetch and cache web content.
- Bluesky threads (bsky.app/profile/*/post/*) are fetched via AT Protocol API — no scraping needed.
- Other URLs use Cloudflare Browser Rendering (requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN secrets).
- Cached content appears in prime results for future recall.
- Stale cache returned if re-fetch fails.

Federation: foreign hive URIs resolve over HTTP.
- ${URI_SCHEME}://host.example.com/path → GET https://host.example.com/o/path
- Private access: append ?token=<auth_code> for Bearer authentication
- Public responses are cached at the Cloudflare edge`,
    when: "Following URIs from prime results. Reading system docs. Cross-hive federation. Reading web pages and social threads.",
  },
  {
    name: "propose_change",
    description: `Propose a structural change. Validates and returns a preview of the index after the change. Does not commit.

Supports: create_pattern (with facets), add_facet (to existing pattern), set_sharing (entry-level HTTP visibility), set_options, set_doctrine, archive_pattern, unarchive_pattern.
Facets can declare foreign key links to other patterns via the links parameter.
Pattern/facet names: lowercase, a-z/0-9/hyphens/underscores, max 64 chars. Max 64 facets per pattern.

set_sharing: control HTTP access to individual entries at /o/entry/{pattern}/{id}.
- "public": openly readable, edge-cached
- "unlisted": readable with valid auth code token (anyone-with-the-link)
- "private": not served (removes sharing)`,
    when: "Before any structural change. Returns a preview diff without committing.",
  },
  {
    name: "apply_change",
    description: `Commit a previously proposed change, or revert to a past state via Cloudflare PITR (30-day window).

For apply: pass change_id from propose_change.
For revert: pass revert_history_id (from ${uri("history")}). Restores ALL data (not just schema) to the state before that change — destructive, requires confirmation.`,
    when: "After reviewing a propose_change preview. Accepts the change_id from the proposal.",
  },
];
