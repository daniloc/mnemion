import { McpAgent } from "agents/mcp";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HiveDO } from "./hive";
import { PRODUCT_NAME, URI_SCHEME, uri, HIVE_ID } from "./constants";
import { TOOLS } from "./tools";

// === Types ===

interface Env {
  MNEMION_HIVE: DurableObjectNamespace<HiveDO>;
  DOCUMENTS?: R2Bucket;  // optional — present only when R2 is enabled + bound
}

interface AuthProps {
  // Which hive (Durable Object) this session reads/writes. Stable per deploy.
  hiveId?: string;
  // Which member this session acts as — the authenticated person's label.
  actor?: string;
  // Retained for backward compatibility; mirrors `actor`.
  userId?: string;
  [key: string]: unknown;
}

function toolDesc(name: string): string {
  return TOOLS.find(t => t.name === name)!.description;
}

// Patterns whose create/update must pass an explicit confirmation round-trip
// before the agent can commit — the human-consent boundary. Keyed by pattern,
// valued by the message shown on the first (unconfirmed) call.
const CONSENT_GATED: Record<string, string> = {
  _system_docs:
    "System docs affect all future agent sessions. Confirm this edit will make future runs more effective. Call mutate again with the same arguments to proceed.",
  _federation_hosts:
    "Adding a federation host is a standing grant: resolve() will send this hive's access tokens to that host whenever it fetches a mnemion:// URI there. Only proceed if the human explicitly approved federating with this host. Call mutate again with the same arguments to proceed.",
  _shared:
    "Sharing an entry publishes it over HTTP at /o/entry/{pattern}/{id} (public = readable by anyone and edge-cached; unlisted = readable by anyone with an access token). Only proceed if the human approved publishing this entry. Call mutate again with the same arguments to proceed.",
  _publications:
    "A publication serves LIVE query results over HTTP at /p/{path} — every current and future entry the query matches (public = readable by anyone and edge-cached; unlisted = readable by anyone with an access token). Only proceed if the human explicitly approved publishing this data. Call mutate again with the same arguments to proceed.",
  _documents:
    "Making this document non-private serves its file over HTTP at /f/{id} (public = readable by anyone and edge-cached; unlisted = readable by anyone with an access token). Only proceed if the human approved publishing this file. Call mutate again with the same arguments to proceed.",
  _members:
    "Adding a member grants another person standing access to this shared hive — everything in it becomes readable and writable by them. Only proceed if the human explicitly chose to share this hive with this person. Call mutate again with the same arguments to proceed.",
  _access_tokens:
    "Creating a passkey-registration token mints a one-time setup link: whoever opens it can register their own passkey and gain member access to this hive. Only proceed if the human is deliberately inviting this person. Call mutate again with the same arguments to proceed.",
};

// Whether a write to a consent-gated pattern actually needs the round-trip.
// Most gated patterns always do; _documents only when it exposes a file
// (non-private visibility) — creating/uploading a private document is benign.
// patch can't be inspected for its resulting visibility, so it always trips
// (and is rejected outright on the single path).
function consentRequired(pattern: string, operation: string | undefined, dataObj: any): boolean {
  if (!CONSENT_GATED[pattern]) return false;
  if (pattern === "_documents") {
    if (operation === "patch") return true;
    const vis = dataObj?.visibility;
    return vis === "public" || vis === "unlisted";
  }
  // Most token creation is benign and ungated — only a passkey-registration
  // ("register" scoped) token is a standing grant of member access, so only that
  // trips the round-trip. (patch is force-tripped upstream for any gated pattern.)
  if (pattern === "_access_tokens") {
    if (operation === "patch") return true;
    return dataObj?.scope === "register";
  }
  return true;
}

// === SessionDO: MCP protocol handler, proxies data to HiveDO ===

export class SessionDO extends McpAgent<Env, unknown, AuthProps> {
  server = new McpServer(
    { name: URI_SCHEME, version: "0.5.0" },
    {
      instructions: `${PRODUCT_NAME} is persistent shared memory. Call prime with your conversational context as your first action — it returns the hive charter, relevant entries, and linked context in one call.

Key capabilities:
- prime: pass conversational context, get back charter + semantically relevant entries + linked entries. Your universal onramp.
- mutate: create, update, archive. Supports batch (array of ops, atomic). Optimistic locking via version field.
- propose_change / apply_change: schema evolution. Supports revert via PITR (30-day window).
- resolve: read by ${URI_SCHEME}:// URI. Returns linked entries one hop deep.
- query: filtered reads. search: cross-pattern full-text.
- ${uri("_system/")} has detailed reference docs if needed.
- ${uri("_system/instance")} has this instance's hostname and endpoint URLs.

Note: tools may need to be loaded before first use. If a tool call fails, load it and retry.`,
    },
  );

  private getHive(): DurableObjectStub<HiveDO> {
    // The hive's location is independent of who authenticated — one shared
    // store per deploy. The member (actor) lives in props.actor, separate from
    // the store's identity.
    const id = this.env.MNEMION_HIVE.idFromName(this.props?.hiveId ?? HIVE_ID);
    return this.env.MNEMION_HIVE.get(id);
  }

  async init() {
    const hive = this.getHive();

    // === Inject working memory into instructions ===
    const recentJson = await hive.getRecentActivity(10);
    const recent = JSON.parse(recentJson) as { pattern: string; id: number; summary: string; updated_at: string }[];

    if (recent.length > 0) {
      const lines = recent.map(r =>
        `- ${r.pattern}/${r.id}: ${r.summary || "(no preview)"}`,
      ).join("\n");
      const briefing = `=== Working Memory ===\n${lines}\n\n`;
      const base = (this.server as any)._instructions ?? "";
      (this.server as any)._instructions = briefing + base;
    }

    // === Inject maintenance status into instructions ===
    // (Also rides the prime response — web clients often never read instructions.)
    try {
      const status = JSON.parse(await hive.getMaintenanceStatus()) as {
        days_since_last_pass: number | null; interval_days: number; overdue: boolean;
      };
      if (status.overdue) {
        const age = status.days_since_last_pass != null ? `${status.days_since_last_pass} days ago` : "never";
        const section = `=== Maintenance ===\nLast memory maintenance pass: ${age} (interval: ${status.interval_days} days). Consider offering the owner a cleanup pass: review ${uri("stale")}, propose supersessions, archives, and memory policies, apply what they ratify, then record the pass in _maintenance_passes. See ${uri("_system/memory-maintenance")}.\n\n`;
        const base = (this.server as any)._instructions ?? "";
        (this.server as any)._instructions = section + base;
      }
    } catch { /* best-effort */ }

    // === Capability status: document storage needs R2 ===
    // When R2 isn't enabled, _documents entries can be created but file upload
    // fails — surface that up front so the agent can flag it to the human.
    if (!this.env.DOCUMENTS) {
      const section = `=== Document storage unavailable ===\nCloudflare R2 is not enabled on this instance, so the document store (the _documents pattern and /f file endpoints) cannot store files — creating a _documents entry works, but uploads fail. If the human wants to store files (PDFs, images), tell them: enable R2 in the Cloudflare dashboard (Storage & databases → R2), then run \`npm run enable-documents\` and redeploy. Everything else works without R2.\n\n`;
      const base = (this.server as any)._instructions ?? "";
      (this.server as any)._instructions = section + base;
    }

    // === Resources (stable, cacheable, subscribable) ===

    this.server.resource(
      "index",
      uri("index"),
      { description: "Master index. Complete orientation to what exists and what matters.", mimeType: "application/json" },
      async (u) => {
        const result = await hive.getIndex();
        return {
          contents: [{ uri: u.href, text: result, mimeType: "application/json" }],
        };
      }
    );

    this.server.resource(
      "schema",
      new ResourceTemplate(uri("schema/{pattern_name}"), {
        list: async () => {
          const names = await hive.listPatterns();
          return {
            resources: names.map((name) => ({
              uri: uri(`schema/${name}`),
              name: `${name} schema`,
              description: `Facet definitions for ${name}`,
              mimeType: "application/json",
            })),
          };
        },
      }),
      { description: "Facet definitions for a pattern", mimeType: "application/json" },
      async (u, { pattern_name }) => {
        const result = await hive.getSchema(pattern_name as string);
        const parsed = JSON.parse(result);
        if (parsed.error) {
          throw new Error(parsed.message);
        }
        return {
          contents: [{ uri: u.href, text: result, mimeType: "application/json" }],
        };
      }
    );

    this.server.resource(
      "history",
      uri("history"),
      { description: "Recent schema evolution history", mimeType: "application/json" },
      async (u) => {
        const result = await hive.getHistory(20);
        return {
          contents: [{ uri: u.href, text: result, mimeType: "application/json" }],
        };
      }
    );

    this.server.resource(
      "stale",
      uri("stale"),
      { description: "Entries past their staleness horizon — neither updated nor recalled recently. Read-only review surface for maintenance passes.", mimeType: "application/json" },
      async (u) => {
        const result = await hive.getStaleEntries();
        return {
          contents: [{ uri: u.href, text: result, mimeType: "application/json" }],
        };
      }
    );

    this.server.resource(
      "entry",
      new ResourceTemplate(uri("entry/{pattern}/{id}"), {
        list: undefined, // Entries are too numerous to enumerate
      }),
      { description: "Individual entry by pattern and ID", mimeType: "application/json" },
      async (u, { pattern, id }) => {
        const result = await hive.getEntry(pattern as string, Number(id));
        const parsed = JSON.parse(result);
        if (parsed.error) {
          throw new Error(parsed.message);
        }
        return {
          contents: [{ uri: u.href, text: result, mimeType: "application/json" }],
        };
      }
    );

    // === Tools ===

    // resolve — the universal reader. One tool, the URI is the API.
    this.server.tool(
      "resolve",
      toolDesc("resolve"),
      {
        uri: z.string().describe(`A ${URI_SCHEME}:// URI, an https:// URL, or an at:// Bluesky at-uri to fetch web content. Examples: ${URI_SCHEME}://entry/notes/1, https://bsky.app/profile/user/post/abc, at://did:plc:xyz/app.bsky.feed.post/abc`),
        // Some clients (e.g. Claude.ai) stringify booleans — accept "true"/"false" too.
        retain: z.union([z.boolean(), z.enum(["true", "false"])]).optional().describe("For web URLs only: true pins the cached snapshot for indefinite retention (always served, never re-fetched or GC'd); false releases it back to normal TTL. Omit to leave retention unchanged."),
      },
      async ({ uri: resolveUri, retain }) => {
        const retainNorm = retain === undefined ? undefined : (retain === true || retain === "true");
        const result = await hive.resolve(resolveUri, retainNorm);
        const parsed = JSON.parse(result);
        if (parsed.error) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: parsed.message }],
          };
        }
        return {
          content: [{ type: "text" as const, text: result }],
        };
      }
    );

    this.server.tool(
      "propose_change",
      toolDesc("propose_change"),
      {
        description: z.string().describe("Natural language description of the change"),
        change: z.object({
          type: z.enum(["create_pattern", "add_facet", "set_sharing", "set_options", "set_doctrine", "set_memory_policy", "set_class", "archive_pattern", "unarchive_pattern"]).describe("Type of structural change"),
          pattern_name: z.string().optional().describe("Target pattern name"),
          pattern_description: z.string().optional().describe("Purpose of the pattern (for create_pattern)"),
          pattern_class: z.enum(["knowledge", "dataset"]).optional().describe('Pattern class (for create_pattern/set_class). "knowledge" (default): prose recalled by meaning via prime. "dataset": structured records with enforced types, aggregated by query — excluded from prime/decay/stale.'),
          doctrine: z.string().optional().describe("How this pattern should be used — required for create_pattern"),
          facets: z.array(z.object({
            name: z.string(),
            type: z.enum(["text", "number", "integer", "boolean", "datetime", "select"]),
            required: z.boolean().default(false),
            default_value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
            options: z.array(z.string()).optional().describe("Allowed values (required for select type)"),
            links: z.object({
              pattern: z.string().describe("Linked pattern name"),
              facet: z.string().default("id").describe("Linked facet (default: id)"),
            }).optional().describe("Foreign key link to another pattern"),
          })).optional().describe("Facets to create (for create_pattern or add_facet)"),
          facet_name: z.string().optional().describe("Target facet name (for set_options)"),
          options: z.array(z.string()).optional().describe("Allowed values (for set_options)"),
          entry_id: z.number().optional().describe("Entry ID (for set_sharing)"),
          visibility: z.enum(["public", "unlisted", "private"]).optional().describe("Sharing visibility (for set_sharing)"),
          policy: z.object({
            half_life_days: z.number().positive().nullable().optional().describe("Decay half-life in days for prime recall; null = no decay (default)"),
            conflict_check: z.enum(["annotate", "off"]).optional().describe("Write-time semantic overlap advisory on create (default: annotate)"),
            exclusive_facets: z.array(z.string()).optional().describe("Facets where only one active entry per value should exist — duplicates get a supersession advisory"),
          }).nullable().optional().describe("Memory policy (for set_memory_policy; null clears the policy)"),
        }),
      },
      async ({ description, change }) => {
        const result = await hive.proposeChange(description, JSON.stringify(change));
        const parsed = JSON.parse(result);
        if (parsed.error) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: parsed.message }],
          };
        }
        return {
          content: [{ type: "text" as const, text: result }],
        };
      }
    );

    this.server.tool(
      "apply_change",
      toolDesc("apply_change"),
      {
        change_id: z.string().optional().describe("The change_id returned by propose_change"),
        revert_history_id: z.number().optional().describe(`Schema history ID to revert to (from ${uri("history")}). Restores entire DO state via PITR.`),
      },
      async ({ change_id, revert_history_id }) => {
        // Revert mode
        if (revert_history_id != null) {
          const confirmKey = `revert:${revert_history_id}`;
          if (!(await hive.checkAndArmConsent(confirmKey))) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  confirmation_required: true,
                  message: "PITR revert restores ALL data (not just schema) to the state before this change. This is destructive and cannot be undone. Call apply_change again with the same revert_history_id to proceed.",
                  revert_history_id,
                }, null, 2),
              }],
            };
          }

          const result = await hive.revertChange(revert_history_id);
          const parsed = JSON.parse(result);
          if (parsed.error) {
            return {
              isError: true as const,
              content: [{ type: "text" as const, text: parsed.message }],
            };
          }
          return {
            content: [{ type: "text" as const, text: result }],
          };
        }

        // Apply mode
        if (!change_id) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: "Either change_id or revert_history_id is required" }],
          };
        }

        // Consent boundary: publishing an entry (set_sharing to public/unlisted)
        // exposes private data over HTTP at /o/entry/{pattern}/{id}. Like adding
        // a federation host, this must pass an explicit confirmation round-trip
        // so an agent acting on prompt-injected content can't silently exfiltrate
        // the owner's memory by flipping an entry's visibility.
        const specJson = await hive.getPendingChange(change_id);
        if (specJson) {
          let spec: any = null;
          try { spec = JSON.parse(specJson); } catch { /* not gated if unparseable */ }
          // evolution.ts defaults an omitted visibility to "public", so treat a
          // missing visibility as public here too — otherwise an unconfirmed
          // publish slips through.
          const effectiveVis = spec?.visibility ?? "public";
          if (spec && spec.type === "set_sharing" && effectiveVis !== "private") {
            const confirmKey = `sharing:${change_id}`;
            if (!(await hive.checkAndArmConsent(confirmKey))) {
              const exposure = effectiveVis === "public"
                ? "readable by anyone (and edge-cached)"
                : "readable by anyone holding an access token";
              return {
                content: [{
                  type: "text" as const,
                  text: JSON.stringify({
                    confirmation_required: true,
                    message: `Applying this change makes ${spec.pattern_name ?? "this entry"}#${spec.entry_id ?? "?"} ${effectiveVis} — ${exposure} over HTTP. Only proceed if the human approved publishing this entry. Call apply_change again with the same change_id to proceed.`,
                    change_id,
                  }, null, 2),
                }],
              };
            }
          }
        }

        const result = await hive.applyChange(change_id);
        const parsed = JSON.parse(result);
        if (parsed.error) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: parsed.message }],
          };
        }

        // Notify clients that structural resources have changed
        this.server.sendResourceListChanged();
        try {
          await this.server.server.sendResourceUpdated({ uri: uri("index") });
          await this.server.server.sendResourceUpdated({ uri: uri("history") });
          // A change targets one pattern — notify just its schema resource
          // (the apply result no longer carries the full index).
          if (parsed.pattern_name) {
            await this.server.server.sendResourceUpdated({ uri: uri(`schema/${parsed.pattern_name}`) });
          }
        } catch {
          // Client may not support subscriptions — notifications are best-effort
        }

        return {
          content: [{ type: "text" as const, text: result }],
        };
      }
    );

    this.server.tool(
      "query",
      toolDesc("query"),
      {
        pattern: z.string().describe("Pattern name to query"),
        filter: z.array(z.string()).optional().describe("Filter expressions: facet=value, facet>value, facet~text (contains)"),
        facets: z.string().optional().describe("Comma-separated facet names to return (default: all)"),
        sort: z.string().optional().describe("Facet to sort by, or an aggregate output name. Prefix with - for descending (e.g. -created_at)"),
        limit: z.number().optional().describe("Max entries to return (default: 100)"),
        count_only: z.boolean().optional().describe("If true, return only the count matching the filters, not the entries"),
        group_by: z.string().optional().describe('Aggregate: comma-separated facets to group by. Bucket a datetime facet with "facet:unit" where unit is day|week|month|year (e.g. "created_at:month").'),
        aggregate: z.array(z.object({
          fn: z.enum(["count", "sum", "avg", "min", "max"]),
          facet: z.string().optional().describe("Facet to aggregate (omit for count → COUNT(*))"),
          as: z.string().optional().describe("Output name for this measure (default: fn or fn_facet)"),
        })).optional().describe("Aggregate measures computed over the rows. Combine with group_by, e.g. [{fn:'sum',facet:'amount'},{fn:'avg',facet:'amount'}]. Either group_by or aggregate switches query into aggregation mode."),
      },
      async ({ pattern, filter, facets, sort, limit, count_only, group_by, aggregate }) => {
        const result = await hive.query(
          pattern,
          filter ? JSON.stringify(filter) : "",
          facets ?? "",
          sort ?? "",
          limit ?? 100,
          count_only ?? false,
          group_by ?? "",
          aggregate ? JSON.stringify(aggregate) : ""
        );
        const parsed = JSON.parse(result);
        if (parsed.error) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: parsed.message }],
          };
        }
        return {
          content: [{ type: "text" as const, text: result }],
        };
      }
    );

    this.server.tool(
      "search",
      toolDesc("search"),
      {
        term: z.string().describe("Search term to find across all text facets"),
        patterns: z.array(z.string()).optional().describe("Limit search to these pattern names (default: all patterns)"),
        limit: z.number().optional().describe("Max total results (default: 20)"),
      },
      async ({ term, patterns, limit }) => {
        const result = await hive.search(
          term,
          patterns ? JSON.stringify(patterns) : "",
          limit ?? 20
        );
        const parsed = JSON.parse(result);
        if (parsed.error) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: parsed.message }],
          };
        }
        return {
          content: [{ type: "text" as const, text: result }],
        };
      }
    );

    this.server.tool(
      "prime",
      toolDesc("prime"),
      {
        context: z.string().describe("What you're thinking about — conversational context, a question, a topic. The cue that activates relevant memories."),
        patterns: z.array(z.string()).optional().describe("Limit priming to these patterns (default: all)"),
        limit: z.number().optional().describe("Max results (default: 10, max: 20)"),
      },
      async ({ context, patterns, limit }) => {
        const result = await hive.prime(
          context,
          patterns ? JSON.stringify(patterns) : "",
          limit ?? 10
        );
        return {
          content: [{ type: "text" as const, text: result }],
        };
      }
    );

    this.server.tool(
      "mutate",
      toolDesc("mutate"),
      {
        pattern: z.string().optional().describe("Pattern name (for single operation; ignored for batch)"),
        operation: z.enum(["create", "update", "archive", "unarchive", "patch", "batch"]).optional().describe("create, update, archive, unarchive, patch, or batch. Optional for shortcuts (e.g. pattern: \"fragment\" implies create)."),
        data: z.union([
          z.record(z.string(), z.unknown()).describe("For single ops: {facet: value, ...}. For update: include version for optimistic locking. For patch: {id, facet, match, replacement}."),
          z.array(z.object({
            pattern: z.string(),
            operation: z.enum(["create", "update", "archive", "unarchive", "patch"]),
            data: z.record(z.string(), z.unknown()),
          })).describe("For batch: array of {pattern, operation, data} items."),
        ]),
      },
      async ({ pattern, operation, data }) => {
        // Batch mode
        if (operation === "batch") {
          // Accept both native arrays and JSON-stringified arrays (Claude.ai sends strings)
          let batchData = data;
          if (typeof batchData === "string") {
            try { batchData = JSON.parse(batchData); } catch { /* fall through to validation */ }
          }
          if (!Array.isArray(batchData)) {
            return {
              isError: true as const,
              content: [{ type: "text" as const, text: "For batch operations, data must be an array of {pattern, operation, data} items." }],
            };
          }
          // Consent-gated patterns can't ride along in a batch — that would skip
          // the confirmation round-trip (and patch would also skip validation).
          // Force any escalating change through a single mutate; only archive
          // (removal/de-escalation) is allowed inside a batch.
          const gated = batchData.find((op: any) =>
            op && consentRequired(op.pattern, op.operation, op.data) && op.operation !== "archive");
          if (gated) {
            return {
              isError: true as const,
              content: [{ type: "text" as const, text: `"${gated.pattern}" requires explicit confirmation and cannot be modified inside a batch. Submit it as a single mutate.` }],
            };
          }
          const result = await hive.batchMutate(JSON.stringify(batchData));
          const parsed = JSON.parse(result);
          if (parsed.error) {
            return {
              isError: true as const,
              content: [{ type: "text" as const, text: parsed.message }],
            };
          }
          return {
            content: [{ type: "text" as const, text: result }],
          };
        }

        // Single mode — parse stringified data if needed (Claude.ai sends strings)
        let singleData = data;
        if (typeof singleData === "string") {
          try { singleData = JSON.parse(singleData); } catch { /* fall through */ }
        }
        // Resolve operation from shortcut if omitted
        let resolvedOp: string | undefined = operation;
        if (!resolvedOp && pattern) {
          const { expandShortcut } = await import("./kernel");
          const shortcut = expandShortcut(pattern);
          if (shortcut) resolvedOp = shortcut.operation;
        }

        if (!pattern || !resolvedOp || !singleData || typeof singleData !== "object" || Array.isArray(singleData)) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: "For single operations, pass pattern, operation (create|update|archive), and data (object). For batch, pass operation 'batch' with data as array." }],
          };
        }

        // Confirmation gate for consent-boundary patterns (system docs,
        // federation allow-list, entry sharing).
        if (CONSENT_GATED[pattern]) {
          // patch is rejected outright: it edits a text facet directly, skipping
          // the kernel validation hooks (e.g. isBlockedFederationHost) AND the
          // confirmation round-trip — an agent could patch _federation_hosts.host
          // from an approved host to an attacker host and leak the token. These
          // patterns must go through create/update.
          if (resolvedOp === "patch") {
            return {
              isError: true as const,
              content: [{ type: "text" as const, text: `"${pattern}" cannot be modified with patch (it would bypass validation and confirmation). Use create or update.` }],
            };
          }
          // Escalating ops (create/update/unarchive) require a round-trip; the
          // first call returns confirmation_required and the agent must re-issue
          // the identical call to commit. archive (removal) is de-escalation and
          // is allowed without one.
          if ((resolvedOp === "create" || resolvedOp === "update" || resolvedOp === "unarchive")
              && consentRequired(pattern, resolvedOp, singleData)) {
            const confirmKey = `consent:${pattern}:${resolvedOp}:${JSON.stringify(singleData)}`;
            if (!(await hive.checkAndArmConsent(confirmKey))) {
              return {
                content: [{
                  type: "text" as const,
                  text: JSON.stringify({
                    confirmation_required: true,
                    message: CONSENT_GATED[pattern],
                    pattern,
                    operation: resolvedOp,
                    data: singleData,
                  }, null, 2),
                }],
              };
            }
          }
        }

        const result = await hive.mutate(pattern, resolvedOp, JSON.stringify(singleData));
        const parsed = JSON.parse(result);
        if (parsed.error) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: parsed.message }],
          };
        }
        return {
          content: [{ type: "text" as const, text: result }],
        };
      }
    );

  }
}
