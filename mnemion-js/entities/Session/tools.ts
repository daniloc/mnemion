// Tool metadata — single source of truth for MCP registration and frontend display.
//
// session.ts imports these for McpServer.tool() calls.
// /api/tools serves them to the web frontend.
//
// @why Tool metadata lives once here as the SSOT feeding both McpServer.tool()
// registration and the /api/tools frontend, so the agent-facing surface can't
// drift between the protocol and the UI. New capability comes from patterns and
// entries, not new tools — the set stays deliberately small.

import { URI_SCHEME, uri } from "../../shared/core/constants";

export interface ToolMeta {
  name: string;
  description: string;
  when: string; // human-readable guidance for when to use
}

export const TOOLS: ToolMeta[] = [
  {
    name: "prime",
    description: `Use this to help the user by recalling everything relevant to the current conversation. Pass conversational context and get back the most relevant entries across all patterns, ranked by semantic similarity. Each result includes the full entry, its URI, and any linked entries one hop away.

Write 1-3 natural sentences describing the current conversational focus. Embedding-based retrieval responds better to descriptive language than keyword lists.

Relevance is weighted at read time: entries superseded by a newer entry (a "supersedes" link, or any relation declaring the supersession behavior) are demoted and annotated with superseded_by — prefer the superseding entry as current truth. Patterns with a memory policy half-life decay in recall weight when neither updated nor recalled (raw_similarity shows the unweighted score). A maintenance field appears when a cleanup pass is overdue — offer it to the human.`,
    when: "First action on connect. When topics shift. When you need to recall what's relevant.",
  },
  {
    name: "mutate",
    description: `Use this to help the user persist knowledge, decisions, and context that should survive beyond this conversation. Create, update, patch, or archive entries — one tool for all writes.

Single: pass pattern + operation (create|update|patch|archive|unarchive) + data.
Batch: pass operation "batch" + data as array of [{pattern, operation, data}, ...] — atomic all-or-nothing, max 100 ops. Combine multiple writes into one call.

Patch: edit a text facet without sending the entire value. Pass {id, facet, match, replacement} — match must appear exactly once in the facet. Token-efficient for large entries.

Update supports optimistic locking: include the version field from a prior read to detect conflicts across concurrent surfaces.

Overlap advisories: creating an entry that is semantically very similar to an existing one (or duplicates an exclusive facet declared in the pattern's memory policy) returns possible_overlap in the response. Advisory only — the entry is still created. When the new entry replaces an old one, link supersession: mutate(pattern: "link", data: {source: "pattern/new_id", target: "pattern/old_id", label: "supersedes"}). Superseded entries are demoted in prime, annotated everywhere, never hidden.

Links: mutate(pattern: "link", data: {source: "pattern/id", target: "pattern/id", label}). On create, _relate: {"<relation or inverse>": "pattern/id" | ["pattern/id", …]} writes the new entry's links in the same transaction (a required relation must be given this way; any link refusal rolls the entry back). In a batch, {pattern: "link" | "unlink", data} items need no operation, and required/containment rules are judged on the batch's end state: move a required link by archiving the old one and linking the new one in one batch; archive a container together with (or after moving) its members. A container with active members can't be archived on its own. The label must name a declared relation — the vocabulary is ${uri("relations")} (kernel defaults: supersedes, references, depends-on, derived-from, part-of; references is the generic link). A relation's inverse name is accepted and stored canonically. An undeclared label is refused with the relations available for that pattern pair; declare a new one with propose_change type declare_relation. Links are immutable — to move one, archive it and link again. Unlink: mutate(pattern: "unlink", data: {source, target, label?}) — pass label when the pair carries several relations.

Large content: to write content too large for MCP parameters, create an _access_tokens entry with {scope: "upload", constraints: {target_pattern, target_id, target_facet, mode}}. Returns a single-use token (15-min expiry). POST content to /upload/{token} via HTTP. Resolve ${uri("_system/instance")} for the full upload URL.

Files (PDF/image/binary): create a _documents entry {title, description?, tags?} — the response carries a single-use upload_url; POST the file bytes there (up to 25 MB, stored in R2). Served at /f/{id}; visibility defaults to private (making it public/unlisted is consent-gated). See ${uri("_system/http-io")}.

Clipboards (validated job-dispatch forms): if a pattern is bound by a _clipboards row, a create/update on it is a SUBMISSION. A malformed submission is REJECTED with submission:"rejected" + a violations:[{facet,message}] list naming EVERY problem at once (regex, range, length, cross-field, composite uniqueness) — fix them all and resubmit. An accepted submission returns submission:"accepted" + progress:{complete, conditions:[{metric, current, target, satisfied}]}, so a fanout of agents each filling the same clipboard learns the running tally and when to stop. Patch is refused on clipboard-bound patterns (use update — it re-validates the whole row). Define a clipboard by creating a _clipboards entry (consent-gated, since it governs writes to a shared dataset; see its schema).

Entries limited to ~1 MB each.`,
    when: "Any write. Batch multiple writes into one call for atomicity.",
  },
  {
    name: "query",
    description: `Use this to help the user find specific entries, or to analyze a dataset by computing over its rows. Read from a pattern with filtering, facet projection, sorting, and limits (max 1,000 rows). Use count_only for efficient counts without fetching entries.

Filter syntax: each filter is "field<op>value". Operators: = != > < >= <= ~ |=
- = != > < >= <= : standard comparisons
- ~ : LIKE substring match (e.g. title~urgent)
- |= : in any of (e.g. id|=1,3,7) — comma-separated values, useful for batched lookups

Aggregation (the analysis verb — compute over rows instead of fetching them): pass group_by and/or aggregate.
- group_by: comma-separated facets. Bucket a datetime facet by calendar period with "facet:unit" (unit = day|week|month|year), e.g. group_by: "created_at:month".
- aggregate: array of {fn, facet?, as?} where fn is count|sum|avg|min|max. count without a facet is COUNT(*).
- Example: group_by "category" with aggregate [{fn:"sum",facet:"amount",as:"total"}] returns one row per category with its total. Filters apply before grouping; sort accepts any output name.`,
    when: "Reading entries with specific filters. Checking counts. Aggregating a dataset (totals/averages/counts, grouped or time-bucketed). Use id|=1,2,3 for batched multi-id lookups.",
  },
  {
    name: "search",
    description: "Use this to help the user find something when you don't know which pattern it's in. Cross-pattern full-text search across all text facets. Returns matching entries with matched facet names.",
    when: "Finding entries by content when you don't know which pattern they're in.",
  },
  {
    name: "resolve",
    description: `Use this to help the user read specific resources, fetch web content, or access system documentation. Accepts ${URI_SCHEME}:// addresses and https:// URLs. Returns linked entries one hop deep for entry URIs — one item per link, each with direction ("out": this entry is the source; "in": the target) and relation (the relation's name read from this entry's side, e.g. depends-on out, required-by in).

Valid URIs:
- ${uri("index")} — master index (orientation, what patterns exist)
- ${uri("relations")} — the relation vocabulary: every label a link may carry, with inverse, meaning, allowed patterns, cardinality and behaviors
- ${uri("schema/{pattern}")} — facet definitions for a pattern
- ${uri("entry/{pattern}/{id}")} — a single entry
- ${uri("history")} — schema change log (supports ?limit=N)
- ${uri("stale")} — entries past their staleness horizon, for maintenance review (supports ?days=N)
- ${uri("_system/")} — list all system docs
- ${uri("_system/{slug}")} — read a system doc (tools, schema-evolution, skills, index-guide, conventions)
- ${uri("_system/{slug}/default")} — read original seed version
- ${uri("mutation")} — mutation audit log (supports ?limit=N). Use for diagnostics and integrity checks.
- ${uri("mutation/{pattern}")} — mutations filtered to one pattern

Web URLs: use this to help the user read web pages and social threads. Pass any https:// URL to fetch and cache the content.
- Bluesky threads (bsky.app/profile/*/post/* or at://*/app.bsky.feed.post/* at-uris) are fetched via AT Protocol API — no scraping needed. Quoted posts, image embeds (with alt text), external links, and video are surfaced inline. Append ?depth=N (0-100, default 6) to control how many levels of nested replies/subtrees are returned — raise it to pull a whole conversation.
- Other URLs use Cloudflare Browser Rendering (requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN secrets).
- Cached content appears in prime results for future recall.
- Stale cache returned if re-fetch fails (a re-fetch that comes back empty never overwrites a good snapshot).
- Retention: pass retain: true to pin a resolved snapshot indefinitely — always served, never re-fetched or garbage-collected — until you resolve it again with retain: false. Otherwise content is served from cache until its TTL, then re-fetched on next access.

Federation: use this to help the user access content on other hives.
- ${URI_SCHEME}://host.example.com/path → GET https://host.example.com/o/path
- Private access: append ?token=<auth_code> for Bearer authentication
- Public responses are cached at the Cloudflare edge`,
    when: "Following URIs from prime results. Reading system docs. Cross-hive federation. Reading web pages and social threads.",
  },
  {
    name: "propose_change",
    description: `Use this to help the user evolve the structure of their hive. Propose a structural change — validates and returns a preview without committing.

Supports: create_pattern (with facets), add_facet (to existing pattern), drop_facet (remove a facet and its data), set_sharing (entry-level HTTP visibility), set_options, set_doctrine, set_memory_policy, set_class, set_facet_format (how a facet's value renders in the web app — pass facet + format), archive_pattern (refused while a containment relation's members in other patterns still link in), unarchive_pattern, declare_relation, amend_relation, retire_relation (the link vocabulary).
Facets hold values, never connections: connect entries with relations (declare_relation, then link, or _relate on create) — reference/foreign-key facets are retired.
Pattern/facet names: lowercase, a-z/0-9/hyphens/underscores, max 64 chars. Max 64 facets per pattern.

pattern_class (create_pattern / set_class): "knowledge" is the default — prose recalled by meaning, the texture prime, decay, and supersession are built for. Choose "dataset" for structured records meant to be aggregated by query (measurements, logs, expenses, survey responses, time-series). Dataset patterns enforce facet types and required fields on write (a number facet rejects "banana"), and opt out of the memory machinery: they're not embedded, never surface in prime, and never appear in the stale view. Use set_class to convert an existing pattern (affects future writes and recall; existing rows are untouched).

set_sharing: use this to help the user control HTTP access to individual entries at /o/entry/{pattern}/{id}.
- "public": openly readable, edge-cached
- "unlisted": readable with valid auth code token (anyone-with-the-link)
- "private": not served (removes sharing)

set_memory_policy: per-pattern recall hygiene, pass policy: {half_life_days?, conflict_check?, exclusive_facets?} (null clears).
- half_life_days: prime relevance halves per half-life an entry goes untouched and unrecalled (decay affects ranking only, never data). Journals want short half-lives; axioms want none.
- conflict_check: "annotate" (default) surfaces possible_overlap advisories on create; "off" disables.
- exclusive_facets: facets where one active entry per value is expected — duplicates get a supersession advisory.
Propose policies when a pattern reveals its nature (fast-staling entries, repeated near-duplicates) and let the human ratify.

Relations (the vocabulary of link labels, ${uri("relations")}): prefer a kernel default (supersedes, references, depends-on, derived-from, part-of); declare one only when a connection means something none of them says.
- declare_relation: name (kebab-case, immutable), inverse (how it reads from the target; the "<name>-inverse" form is reserved for the legacy migration), description (≥120 chars: what it asserts, when to prefer it over its nearest neighbour, one example), source and target (pattern lists or ["*"]; _documents/_web_cache allowed as targets), cardinality ("one"|"many", default many), behaviors (subset of: supersession, acyclic, containment), required (true: every active entry of the — explicitly listed — source patterns must hold one; creates then carry it in _relate).
- Derived relations: declare_relation with chain: ["step-1", "step-2", …] (≥2 stored relations that compose) and no source/target/cardinality/behaviors/required. Computed at read time (resolve lists them with derived: true), never written.
- amend_relation: name + any of description, inverse, behaviors, cardinality, required. A legacy relation stays legacy until both its debts are paid (legacy_debt: placeholder description, generated inverse). Kernel defaults can't be amended.
- retire_relation: name. Refused while active links use it, or while a chain uses it as a step.
If existing data would violate a declare or amend (an entry lacking a now-required link, a second link under cardinality one, a cycle under acyclic) or a retire, the preview lists it in preview.violations and apply is refused until it is fixed.

drop_facet: pattern_name + facet. preview.non_null_values counts the rows (active and archived) holding a value — the data the drop loses. Refused while anything names the facet (a memory policy, a view, a publication, a clipboard, an ingress endpoint, a live upload token — preview.facet_references lists them; apply re-checks), for kernel patterns and kernel columns, a pattern's only facet, and reference (links) facets. Reverting it (apply_change revert_history_id) restores the whole hive to just before the drop.`,
    when: "Before any structural change. Returns a preview diff without committing.",
  },
  {
    name: "apply_change",
    description: `Use this to help the user commit a proposed change, or recover from mistakes via point-in-time restore.

For apply: pass change_id from propose_change.
For revert: pass revert_history_id (from ${uri("history")}). Restores ALL data (not just schema) to the state before that change — destructive, requires confirmation.`,
    when: "After reviewing a propose_change preview. Accepts the change_id from the proposal.",
  },
  {
    name: "render",
    description: "Render a rich UI view of the hive in MCP-Apps-capable clients (falls back to text elsewhere). view=\"patterns\": a table of every pattern and its entry count. view=\"entries\" with pattern=<name>: a table of that pattern's entries (most recent first; long text truncated).",
    when: "When the host supports MCP Apps and a visual table beats prose — browsing patterns, scanning a dataset's rows.",
  },
];
