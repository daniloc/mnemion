> **Archived design document.** Written before implementation, under the project's earlier name *Cambium* (now **Mnemion**). Kept for design rationale only — for current behavior, see the [README](../../README.md) and [CLAUDE.md](../../CLAUDE.md). Where this doc and the shipped code disagree, the code is authoritative.

# Cambium

## Unified memory between agent surfaces and the humans who work with them

Cambium is an MCP server on Cloudflare Workers that provides persistent, evolving shared memory between a human and their AI agents across Claude.ai, Claude Code, the Anthropic API, and a native iOS app.

The schema is not designed in advance. It emerges from use.

The name comes from the living growth layer in a tree: the thin, active tissue between bark and wood where new cells form. Cambium is the layer where shared memory accumulates into structure.

---

## The problem

Every conversation with an AI agent starts cold. The agent has no memory of what was decided yesterday, what's being tracked, or what matters. Humans compensate by repeating themselves, pasting context, maintaining notes. This tax compounds across surfaces — what's known in Claude.ai is invisible to Claude Code is invisible to the iOS app.

Cambium eliminates the cold start by giving every agent session access to a shared, persistent substrate and the tools to read, write, search, and reshape that substrate.

---

## The thesis

The structure of the organism is an index of the performance we can expect of it.

A PIM whose schema is designed upfront will perform according to the designer's imagination. A PIM whose schema evolves through use will perform according to the actual demands of the work. These are different things.

Cambium provides memory clay — minimal, flexible primitives that the agent and human rework at will. The schema that emerges from a month of use encodes discoveries about what actually matters in this specific working relationship. Those structural discoveries are the real product, not the tool that houses them.

This also means Cambium is portable in a deeper sense than data portability. Someone who forks the project starts with the same clay and grows a different organism, because their work makes different demands. The growth mechanism transfers even when the growth doesn't.

---

## Design principles

**Progressive disclosure from zero.** A new agent session orients itself with a single tool call returning a compact index. Deeper detail is available on request. Token efficiency is structural, not aspirational.

**Schema evolution is the primary capability, not an admin operation.** Creating and reshaping objects is as natural as creating records. The agent proposes, previews, and applies structural changes mid-conversation.

**The index is the organism's self-description.** It contains not just structure but intent — why each object exists, how to interact with it, what matters right now. It's the first thing an agent reads and the artifact that makes schema legible across sessions and surfaces.

**No prescribed schema.** Cambium ships empty. The first conversation creates the first object based on what actually needs to happen. Examples in this document are illustrative, never normative.

**Agent-ergonomic surfaces.** Tools are named and shaped for LLM consumption. Responses include just enough context for the agent to decide what to do next.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│              Cloudflare Worker                        │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │  @cloudflare/workers-oauth-provider              │ │
│  │  OAuth 2.1 + PKCE gateway                        │ │
│  │  (DCR for Claude surfaces, pre-reg for iOS)      │ │
│  └────────┬──────────────────┬─────────────────────┘ │
│           │                  │                        │
│  ┌────────▼──────┐  ┌───────▼───────────┐           │
│  │  /mcp          │  │  /api/*            │           │
│  │  McpAgent      │  │  REST (Hono)       │           │
│  │  Streamable    │  │  iOS app           │           │
│  │  HTTP          │  │  webhooks          │           │
│  └───────┬───────┘  └────────┬──────────┘           │
│          └──────────┬────────┘                       │
│          ┌──────────▼──────────┐                     │
│          │  CambiumDO           │                     │
│          │  Durable Object      │                     │
│          │  SQLite (10GB)       │                     │
│          │  per-user state      │                     │
│          └─────────────────────┘                     │
└─────────────────────────────────────────────────────┘
```

**One Worker. Two interfaces. One storage layer.**

The MCP interface (`/mcp`) serves Claude.ai, Claude Code, and API-based agents via Streamable HTTP. The REST interface (`/api/*`) serves the iOS app and any future clients. Both pass through the same OAuth gateway and operate on the same Durable Object.

### Technology choices

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Compute | Cloudflare Workers | Edge, zero cold start, DO binding |
| State | Durable Objects + SQLite | Zero-latency co-located storage, 10GB/DO, full SQL |
| Auth | `workers-oauth-provider` | MCP-required OAuth 2.1, handles DCR for Claude surfaces |
| MCP | `agents` npm package (McpAgent) | Stateful sessions, auto-hibernation, DO lifecycle |
| HTTP | Hono | Ultralight, web-standard, Workers-native |
| Identity | Third-party IdP | Delegate identity entirely, Worker proxies the flow |

### Per-user isolation

Each authenticated user gets their own Durable Object, identified by stable user ID from the IdP. Complete data isolation, independent schema evolution, zero contention.

---

## The primitives

Cambium has exactly two built-in structures: the **index** and the **schema history**. Everything else is created through use.

### The index

The index is a single document stored in the `_index` table. It's read first in every session. It describes whatever currently exists — objects, their purposes, interaction patterns, current state — in a compact, token-efficient format that gives the agent a complete operational picture.

The index is **not** auto-generated from table metadata. It's a curated document that the schema evolution tools maintain. This is critical: the index carries *intent and guidance*, not just structure. A table's columns tell you what fields exist; the index tells you *why the object exists, how the agent should use it, and what matters right now.*

When Cambium is fresh, the index looks like this:

```json
{
  "version": 0,
  "updated_at": "2026-03-08T...",
  "objects": [],
  "conventions": [],
  "guidance": "This is a new Cambium instance. No objects exist yet. Create what the work demands."
}
```

As objects are created, the index grows entries for each. Each entry is authored by the agent during schema evolution — the human approves, refines, or overrides.

### Schema history

The `_schema_history` table records every structural change: object created, field added, field modified, index updated. Each entry includes a timestamp, description of the change, and which session initiated it. This table is the narrative of how the organism grew.

---

## Tool surface

Eight tools. That's the entire MCP surface. They operate on any object of any shape.

### Orientation

**`get_index()`** — Returns the master index. First call in every session. The agent's complete orientation to what exists and what matters.

**`get_schema(object)`** — Returns full field definitions, types, constraints for a specific object. Called when the agent needs precise structural knowledge for a query or mutation. Progressive disclosure: the index says *what and why*; the schema says *how at the field level*.

### Data

**`query(object, filter?, fields?, sort?, limit?)`** — Read records. Simple expression filters (`field=value`, `field>value`, `field~term` for full-text). The `fields` parameter controls projection — request only what you need. Returns records plus continuation token.

**`mutate(object, operation, data)`** — Create, update, or archive records. One tool for all writes, disambiguated by `operation`: `create`, `update`, `archive`. Returns the affected record.

**`search(text, objects?)`** — Full-text search across one or all objects. SQLite FTS5. Returns ranked results with snippets and object attribution.

### Schema evolution

**`propose_change(description, change)`** — The agent describes a structural change in natural language and provides the change spec: new object, new field, modify field, new index, add convention. The tool validates, applies to a draft, and returns a preview of what the index would look like after. Does not commit.

**`apply_change(change_id)`** — Commits a previously proposed change. Updates SQLite schema and index atomically. Records in schema history. Emits `notifications/tools/list_changed` if the change affects tool behavior.

**`get_history(limit?)`** — Returns recent schema changes. For understanding how and why the organism evolved.

### What's deliberately absent

No telemetry tool. No linking tool. No tagging system. No hierarchy. No workflow engine.

If any of these matter, the agent and human will grow them through `propose_change` when the need arises. A `tags` array field will emerge on the objects that need it. A `parent_id` will appear when hierarchy matters. A junction table will form when relationships between objects become load-bearing.

These aren't omissions. They're the point. The substrate doesn't presuppose what structure the work will demand.

---

## Design patterns

### 1. The catalog pattern (index-as-orientation)

The index is a compact, self-describing document the agent reads first. Architecturally identical to `llms.txt`, to SKILL.md files, and to the knowledge registry pattern in progressive disclosure MCP research.

The pattern converts a discovery problem into a reading problem. No tool-list inspection, no multi-call discovery loop — one read, complete operational picture.

The index must stay under ~1,000 tokens for a moderately complex instance. Schema evolution tools enforce this by requiring the agent to write *concise* object descriptions. If the index is bloating, that's a signal the organism has grown complex enough to need decomposition — which the agent can propose.

### 2. Tiered progressive disclosure

Three tiers of information density:

- **Index** (always loaded): What exists, why, how much, what's current.
- **Schema** (on demand): Full field definitions for a specific object.
- **Records** (on demand): Actual data, filtered and projected.

Each tier's response includes enough context to decide whether to go deeper, without requiring it.

### 3. Propose/apply two-phase schema evolution

Schema changes are previewed before committing. The agent sees what the index will look like after the change, catches misunderstandings before they're structural, and the human can intervene.

Changes are applied inside `blockConcurrencyWhile()` on the Durable Object — no concurrent reads see a half-migrated state.

### 4. Index-carried guidance

The index includes a `guidance` field: natural-language instructions for how the agent should behave in the current session. This is where session-start behavior gets defined — not in the tool surface, not in hardcoded logic, but in the index itself, editable by the human or agent at any time.

The guidance evolves with the work, not with the code.

### 5. Convention accumulation

The index includes a `conventions` array — rules the working relationship has established. These aren't enforced in code initially; they're documented norms that the agent follows. If a convention proves load-bearing enough, it can be promoted to a database constraint through schema evolution.

This mirrors how human teams work: conventions start as agreements and only become policy when they need enforcement.

### 6. MCP `notifications/tools/list_changed`

After schema evolution, the server emits this signal so long-lived clients (Claude Code) know to re-read the index. Short-lived sessions (Claude.ai per-message) naturally re-read on the next turn.

### 7. Opaque tokens, not JWTs

The Worker is both auth server and resource server. Opaque tokens in KV are simpler, instantly revocable, and don't leak claims. `workers-oauth-provider` handles this.

---

## What day one looks like

You deploy Cambium. You connect it to Claude.ai as a connector and to Claude Code in your config. The index is empty.

In your first conversation, you say something like: "I have a few things I need to track." The agent reads the empty index, recognizes nothing exists yet, and proposes the first object. Maybe it's called `items`. Maybe it's called `tasks`. Maybe it's something nobody has named yet. The agent proposes, you refine, it commits.

By the end of the first week, there might be three objects, or one, or seven. Some will have fields the agent added after discovering they were needed. The conventions list will have a few entries. The guidance will reflect whatever operational rhythm emerged.

None of this was designed. All of it was grown.

---

## Open questions

**Index authorship.** When the agent proposes a schema change, it also drafts the index entry. How much should the human be in the loop on index prose? Too much friction kills the evolution speed. Too little risks an index that doesn't communicate well to future sessions.

**Cross-object queries.** The primitives support foreign key fields, but `query` currently operates on one object at a time. If joins become necessary, should that capability be always available or emerge only when relationships exist?

**Index size management.** As the organism grows, the index grows. When it exceeds the ~1,000 token target, what's the right decomposition? This should emerge from use rather than being designed now.

**Guidance vs. convention boundary.** Guidance is per-session steering; conventions are durable norms. The line between them may need to be discovered through use.

**Backup and portability.** Durable Object SQLite supports 30-day point-in-time recovery. Periodic export to R2 provides a portable SQLite file. The index + schema history together are a complete blueprint for reconstructing the organism elsewhere.

**Multi-agent concurrency.** The single-writer DO model prevents corruption, but simultaneous sessions from different surfaces will queue. For a personal PIM this is fine. For shared use, this needs thought.

---

## Getting started

```bash
npm create cloudflare@latest -- cambium \
  --template=cloudflare/ai/demos/remote-mcp-authless

cd cambium
npm install agents @modelcontextprotocol/sdk hono zod
```

Start authless, layer in `workers-oauth-provider` when ready for multi-surface auth. Deploy. Connect. Start working. See what grows.

# Cambium I/O

## Schema-defined routes for an organism that can sense and act

Cambium's base tools — the eight primitives for orientation, data, search, and schema evolution — are the kernel. They can't be altered. They're the minimum viable nervous system: the organism can remember, recall, and reshape its own structure.

But memory alone is inert. A living system also has I/O — sensory inputs and motor outputs. Cambium I/O extends the schema evolution mechanism to define routes: HTTP endpoints and scheduled triggers that move data into and out of the organism. The agent and human define these routes the same way they define schema objects — through `propose_change` / `apply_change` — and the routes are live immediately.

The I/O surface of the organism is as evolvable as its memory structure.

---

## The principle

Cambium's entire tool surface is schema-defined, with one exception: the base route.

The **base route** is immutable. It exposes the eight MCP tools, the OAuth endpoints, the REST API mirror, and the plugin git endpoint. These are the kernel — the fixed interface that every agent session, iOS app, and Claude Code plugin depends on. They never change because every other capability is built on top of them.

Everything beyond the base route is a **schema-defined route**: an I/O channel that the organism grows because the work demands it. A route definition lives in the `_routes` table alongside schema objects and conventions. It specifies a trigger, a data flow, and a destination. The Worker reads route definitions and binds them dynamically.

---

## Route anatomy

A route definition has three parts:

### Trigger

What causes the route to fire.

- **`http_in`** — An inbound HTTP endpoint. The Worker binds a path (e.g., `/io/github-webhook`) that accepts requests and processes them into records.
- **`record_event`** — Fires when a record is created, updated, or archived on a specified object. The organism reacts to its own state changes.
- **`schedule`** — Fires on a cron schedule using the Durable Object alarm API. The organism acts on a rhythm.
- **`query_condition`** — Fires when a query against an object matches a condition. Checked on a schedule or piggybacked on relevant mutations. The organism notices when something becomes true.

### Transform

What happens to the data between trigger and destination. A transform is a declarative specification — not arbitrary code — that selects fields, reshapes payloads, templates strings, and evaluates simple expressions. Think of it as a projection: the trigger produces raw data, the transform shapes it for the destination.

Transforms are intentionally constrained. They can:

- Select and rename fields from the triggering record or query result
- Template strings with field interpolation (`"Task due: {{title}} by {{due_date}}"`)
- Filter records by field conditions
- Aggregate simple counts and sums
- Compute timestamps and date math
- Concatenate and format text

They cannot:

- Execute arbitrary code
- Make network requests (that's the destination's job)
- Modify Cambium state (use the base tools for that)
- Branch on complex logic

This constraint is the security boundary. Route definitions are authored by the agent through schema evolution, and the human approves them. If transforms could execute arbitrary code, approving a route would require auditing code. With declarative transforms, approving a route means reading a data flow description.

### Destination

Where the transformed data goes.

- **`http_out`** — POST/PUT to an external URL. Headers and auth configurable. This is the general-purpose egress: webhooks, API calls, Slack incoming webhooks, Zapier triggers, anything that accepts HTTP.
- **`record`** — Create or update a record in a Cambium object. The organism writes to its own memory. Useful for ingress routes that receive external data, or for scheduled routes that compute summaries.
- **`notification`** — Push to the iOS app via a notification channel. The organism alerts the human.
- **`queue`** — Write to a Cambium queue (a lightweight object type with FIFO semantics) for later processing. The organism defers work.

---

## Examples as schema definitions

These are illustrative of the shape, not prescriptive of the content.

### Egress: notify on high-priority creation

When a record is created in any object with a `priority` field set to 1, push a notification to the iOS app.

```json
{
  "name": "notify_priority_1",
  "description": "Alert when anything priority 1 is created",
  "trigger": {
    "type": "record_event",
    "event": "create",
    "object": "*",
    "condition": "priority = 1"
  },
  "transform": {
    "title": "Priority 1: {{_object_name}}",
    "body": "{{title}}",
    "metadata": {
      "object": "{{_object_name}}",
      "record_id": "{{id}}"
    }
  },
  "destination": {
    "type": "notification",
    "channel": "alerts"
  }
}
```

### Egress: daily digest

Every morning at 7am ET, query active items due within 48 hours across all objects, format a summary, and POST it to a Slack webhook.

```json
{
  "name": "morning_digest",
  "description": "Daily summary of upcoming due items",
  "trigger": {
    "type": "schedule",
    "cron": "0 12 * * *"
  },
  "transform": {
    "query": {
      "object": "*",
      "filter": "status=active AND due_date <= {{now_plus_48h}}",
      "sort": "due_date asc"
    },
    "template": "*Morning briefing — {{count}} items due soon:*\n{{#each results}}\n• {{title}} ({{_object_name}}) — due {{due_date}}\n{{/each}}"
  },
  "destination": {
    "type": "http_out",
    "url": "{{env.SLACK_WEBHOOK_URL}}",
    "method": "POST",
    "body_template": {
      "text": "{{transformed}}"
    }
  }
}
```

### Ingress: GitHub webhook to record

Accept GitHub webhook payloads on a Cambium endpoint, extract issue data, create records in an `issues` object.

```json
{
  "name": "github_issues_ingest",
  "description": "GitHub issue events become records",
  "trigger": {
    "type": "http_in",
    "path": "/io/github-issues",
    "method": "POST",
    "auth": "hmac_secret",
    "secret_env": "GITHUB_WEBHOOK_SECRET"
  },
  "transform": {
    "condition": "body.action IN (opened, reopened, closed)",
    "fields": {
      "external_id": "body.issue.number",
      "title": "body.issue.title",
      "status": "body.action",
      "url": "body.issue.html_url",
      "labels": "body.issue.labels[].name"
    }
  },
  "destination": {
    "type": "record",
    "object": "issues",
    "operation": "upsert",
    "match_on": "external_id"
  }
}
```

### Internal: summarize and store

Every Sunday, query all records created that week across all objects, compute counts by object, and store the summary as a record in a `weekly_summaries` object.

```json
{
  "name": "weekly_summary",
  "description": "Aggregate weekly activity into a summary record",
  "trigger": {
    "type": "schedule",
    "cron": "0 10 * * 0"
  },
  "transform": {
    "query": {
      "object": "*",
      "filter": "created_at >= {{start_of_week}}",
      "aggregate": "count by _object_name"
    },
    "fields": {
      "week_of": "{{start_of_week}}",
      "breakdown": "{{aggregated}}",
      "total": "{{count}}"
    }
  },
  "destination": {
    "type": "record",
    "object": "weekly_summaries",
    "operation": "create"
  }
}
```

---

## How routes are created

Routes use the same evolution flow as schema objects. The agent calls `propose_change` with a route definition. The tool validates the definition, checks that referenced objects and fields exist, verifies the trigger type is supported, and returns a preview:

> "This route will POST to your Slack webhook every day at 7am ET with a summary of items due within 48 hours. It reads from all objects with `status` and `due_date` fields. Approve?"

The human approves. `apply_change` writes the definition to `_routes`, the Worker binds it, and it's live. The schema history records the route creation like any other structural change.

Routes can be modified, disabled, or removed through the same flow. `propose_change` with a route modification shows the diff. The organism's I/O surface is as mutable as its memory surface.

---

## Implementation on Cloudflare

The implementation is natural on the Workers platform because each primitive maps to a Cloudflare capability:

**`http_in` routes** are Hono routes registered dynamically. On Worker startup (or after `apply_change`), the Worker reads `_routes` from the Durable Object and binds matching path handlers. Inbound requests hit the route handler, which applies the transform and writes to the destination.

**`schedule` routes** use the Durable Object alarm API. Each scheduled route registers an alarm at its next fire time. When the alarm fires, it executes the route's query, applies the transform, and sends to the destination. Then it schedules the next alarm.

**`record_event` routes** are triggered inline during `mutate` operations. After a successful create/update/archive, the Worker checks `_routes` for matching event triggers and executes them. This is synchronous within the DO's single-writer model, so there are no race conditions.

**`http_out` destinations** use the Worker's `fetch()` API. Egress is just an HTTP call. Headers, auth tokens, and URLs can reference environment variables via `{{env.VAR_NAME}}` so secrets stay in Worker config, not in the schema.

**`notification` destinations** require the iOS app to maintain a push subscription (via APNs or a polling endpoint). The route writes to a `_notifications` queue in the DO, and the iOS app polls `/api/notifications` or receives pushes.

---

## Security boundaries

Routes are powerful — they can send data out of the organism to arbitrary URLs. The security model is:

**Human-in-the-loop for creation.** The propose/apply flow means no route is created without the human seeing and approving the definition. The agent can propose a route; it can't silently install one.

**Declarative transforms only.** No arbitrary code execution. The transform language is deliberately limited to field selection, string templating, filtering, and simple aggregation. This means a human can read a route definition and fully understand what it does.

**Secrets in environment, not schema.** URLs and auth tokens can reference `{{env.VAR_NAME}}`. The route definition says *which* secret to use; the secret's value lives in Worker environment config. A schema export or plugin export never contains actual secrets.

**Auth on ingress.** `http_in` routes support HMAC verification, bearer tokens, and IP allowlists. An unauthenticated ingress route can be created but the propose/apply preview will flag it.

**Rate limiting.** Egress routes have configurable rate limits to prevent runaway loops. A `record_event` route that triggers on every mutation could create a cascade; the rate limiter caps execution frequency and logs skipped firings.

---

## Routes as organism I/O

The framing matters: routes are not "integrations" or "automations." They're the organism's sensory and motor system.

An ingress route is a sense organ — the organism perceives something in the external world (a GitHub event, a webhook, an incoming email) and converts it into memory.

An egress route is a limb — the organism takes an action in the external world (sends a notification, posts to Slack, triggers an external workflow) in response to its internal state.

A scheduled route is a heartbeat — the organism acts on a rhythm, independent of any conversation or interaction.

An internal route (record-to-record) is a reflex — the organism responds to its own state changes with further state changes, without needing an agent in the loop.

The agent and human don't wire up integrations. They grow the organism's ability to sense and act, the same way they grow its ability to remember — through schema evolution, one `propose_change` at a time.

---

## Relationship to plugins

Cambium plugins (see `cambium-plugins.md`) seed schema objects. They can also seed routes. A `cambium-plugin-ops` plugin might include a morning digest route and a priority notification route alongside its schema objects. A `cambium-plugin-research` plugin might include a route that ingests RSS feeds into a sources object.

When a plugin seeds routes, the same propose/apply flow applies — the human approves each route at install time. The plugin definition specifies the route shape; the human supplies the secrets (webhook URLs, API keys) via environment config.

When a Cambium instance exports itself as a plugin via the synthetic git repo, route definitions are included in the seed — but with secrets replaced by `{{env.VAR_NAME}}` references. The shape transfers; the credentials don't.

---

## Open questions

**Transform language.** The examples above use a handwave-y template syntax. The actual transform language needs to be specified precisely — expressive enough for real use, constrained enough for security, and readable enough that a human can audit a route definition in 30 seconds. Handlebars-like templating is a starting point but may need extensions for date math, array operations, and conditional formatting.

**Route composition.** Can a route's destination be another route? This enables pipelines: ingest → transform → enrich → store. But it also enables infinite loops. Probably worth allowing with a depth limit and cycle detection rather than prohibiting.

**Error handling.** When an `http_out` destination returns an error, what happens? Options: retry with backoff, log to an `_errors` object, disable the route after N failures, notify the human. Probably all of these, configurable per route.

**Dry run.** Before approving a route, the human should be able to see what it *would* do with current data. "Show me what this morning digest would contain if it fired right now." This is a natural extension of the propose/apply preview.

**Observability.** Routes need a log. Every firing should be recorded: when, what triggered it, what was sent, what response was received. This log is itself a Cambium object (`_route_log`), queryable with the standard tools. The organism can observe its own I/O.