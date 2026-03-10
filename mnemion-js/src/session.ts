import { McpAgent } from "agents/mcp";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { StoreDO } from "./store";
import { PRODUCT_NAME, URI_SCHEME, uri } from "./constants";

// === Types ===

interface Env {
  MNEMION_STORE: DurableObjectNamespace<StoreDO>;
}

interface AuthProps {
  userId: string;
  [key: string]: unknown;
}

// === SessionDO: MCP protocol handler, proxies data to StoreDO ===

export class SessionDO extends McpAgent<Env, unknown, AuthProps> {
  server = new McpServer(
    { name: URI_SCHEME, version: "0.5.0" },
    {
      instructions: `${PRODUCT_NAME} is persistent shared memory. Read ${uri("_system/tools")} before your first action for full capability reference.

Key capabilities agents commonly miss:
- mutate accepts a batch parameter — an array of {pattern, operation, data} for atomic all-or-nothing execution (max 100 ops). Use it to combine multiple writes into one call.
- Update operations support optimistic locking via the version field. Include version from a prior read to prevent lost updates when multiple surfaces write concurrently.
- Facets support foreign key links to other patterns. Use the links parameter in propose_change.
- ${uri("mutation")} is an audit log for diagnostics. Use it instead of querying entries to verify data integrity.
- For large content that exceeds MCP parameter limits, mint an upload token via mutate on _upload_tokens, then POST content to /upload/{token} via HTTP.
- apply_change supports revert_history_id for point-in-time rollback via Cloudflare PITR (30-day window).`,
    },
  );

  private confirmed = new Set<string>();

  private getStore(): DurableObjectStub<StoreDO> {
    const userId = this.props?.userId ?? "anonymous";
    const id = this.env.MNEMION_STORE.idFromName(`user:${userId}`);
    return this.env.MNEMION_STORE.get(id);
  }

  async init() {
    const store = this.getStore();

    // === Resources (stable, cacheable, subscribable) ===

    this.server.resource(
      "index",
      uri("index"),
      { description: "Master index. Complete orientation to what exists and what matters.", mimeType: "application/json" },
      async (u) => {
        const result = await store.getIndex();
        return {
          contents: [{ uri: u.href, text: result, mimeType: "application/json" }],
        };
      }
    );

    this.server.resource(
      "schema",
      new ResourceTemplate(uri("schema/{pattern_name}"), {
        list: async () => {
          const names = await store.listPatterns();
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
        const result = await store.getSchema(pattern_name as string);
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
        const result = await store.getHistory(20);
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
        const result = await store.getEntry(pattern as string, Number(id));
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
      `Read anything by its ${URI_SCHEME}:// address. The URI scheme is the API.

IMPORTANT: Start every session by reading ${uri("_system/tools")} for full capability reference.

Valid URIs:
- ${uri("index")} — master index (orientation, what patterns exist)
- ${uri("schema/{pattern}")} — facet definitions for a pattern
- ${uri("entry/{pattern}/{id}")} — a single entry
- ${uri("history")} — schema change log (supports ?limit=N)
- ${uri("_system/")} — list all system docs
- ${uri("_system/{slug}")} — read a system doc (tools, schema-evolution, skills, conventions, index-guide)
- ${uri("_system/{slug}/default")} — read original seed version
- ${uri("mutation")} — mutation audit log (supports ?limit=N). Use for diagnostics and integrity checks.
- ${uri("mutation/{pattern}")} — mutations filtered to one pattern`,
      {
        uri: z.string().describe(`A ${URI_SCHEME}:// URI to resolve`),
      },
      async ({ uri: resolveUri }) => {
        const result = await store.resolve(resolveUri);
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
      `Propose a structural change. Validates and returns a preview of the index after the change. Does not commit.

Supports: create_pattern (with facets), add_facet (to existing pattern), add_convention.
Facets can declare foreign key links to other patterns via the links parameter.
Pattern/facet names: lowercase, a-z/0-9/hyphens/underscores, max 64 chars. Max 64 facets per pattern.`,
      {
        description: z.string().describe("Natural language description of the change"),
        change: z.object({
          type: z.enum(["create_pattern", "add_facet", "add_convention"]).describe("Type of structural change"),
          pattern_name: z.string().optional().describe("Target pattern name (for create_pattern and add_facet)"),
          pattern_description: z.string().optional().describe("Purpose of the pattern (for create_pattern)"),
          facets: z.array(z.object({
            name: z.string(),
            type: z.enum(["text", "number", "integer", "boolean", "datetime"]),
            required: z.boolean().default(false),
            default_value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
            links: z.object({
              pattern: z.string().describe("Linked pattern name"),
              facet: z.string().default("id").describe("Linked facet (default: id)"),
            }).optional().describe("Foreign key link to another pattern"),
          })).optional().describe("Facets to create (for create_pattern or add_facet)"),
          convention: z.string().optional().describe("Convention text (for add_convention)"),
        }),
      },
      async ({ description, change }) => {
        const result = await store.proposeChange(description, JSON.stringify(change));
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
      `Commit a previously proposed change, or revert to a past state via Cloudflare PITR (30-day window).

For apply: pass change_id from propose_change.
For revert: pass revert_history_id (from ${uri("history")}). Restores ALL data (not just schema) to the state before that change — destructive, requires confirmation.`,
      {
        change_id: z.string().optional().describe("The change_id returned by propose_change"),
        revert_history_id: z.number().optional().describe(`Schema history ID to revert to (from ${uri("history")}). Restores entire DO state via PITR.`),
      },
      async ({ change_id, revert_history_id }) => {
        // Revert mode
        if (revert_history_id != null) {
          const confirmKey = `revert:${revert_history_id}`;
          if (!this.confirmed.has(confirmKey)) {
            this.confirmed.add(confirmKey);
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
          this.confirmed.delete(confirmKey);

          const result = await store.revertChange(revert_history_id);
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

        const result = await store.applyChange(change_id);
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
          if (parsed.index?.patterns) {
            for (const pat of parsed.index.patterns) {
              await this.server.server.sendResourceUpdated({ uri: uri(`schema/${pat.name}`) });
            }
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
      "Read entries from a pattern. Supports filtering, facet projection, sorting, limits (max 1,000 rows). Use count_only for efficient counts without fetching entries.",
      {
        pattern: z.string().describe("Pattern name to query"),
        filter: z.array(z.string()).optional().describe("Filter expressions: facet=value, facet>value, facet~text (contains)"),
        facets: z.string().optional().describe("Comma-separated facet names to return (default: all)"),
        sort: z.string().optional().describe("Facet to sort by. Prefix with - for descending (e.g. -created_at)"),
        limit: z.number().optional().describe("Max entries to return (default: 100)"),
        count_only: z.boolean().optional().describe("If true, return only the count matching the filters, not the entries"),
      },
      async ({ pattern, filter, facets, sort, limit, count_only }) => {
        const result = await store.query(
          pattern,
          filter ? JSON.stringify(filter) : "",
          facets ?? "",
          sort ?? "",
          limit ?? 100,
          count_only ?? false
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
      "Cross-pattern full-text search. Searches all text facets across all patterns (or specified patterns) for a term. Returns matching entries with matched facet names.",
      {
        term: z.string().describe("Search term to find across all text facets"),
        patterns: z.array(z.string()).optional().describe("Limit search to these pattern names (default: all patterns)"),
        limit: z.number().optional().describe("Max total results (default: 20)"),
      },
      async ({ term, patterns, limit }) => {
        const result = await store.search(
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
      "mutate",
      `Create, update, or archive entries. One tool for all writes.

Single: pass pattern + operation (create|update|archive) + data.
Batch: pass operation "batch" + data as array of [{pattern, operation, data}, ...] — atomic all-or-nothing, max 100 ops. Combine multiple writes into one call.

Update supports optimistic locking: include the version field from a prior read to detect conflicts across concurrent surfaces.

Large content: to write content too large for MCP parameters, create an _upload_tokens entry with {target_pattern, target_id, target_facet, mode}. Returns a single-use token (15-min expiry). POST content to /upload/{token} via HTTP.

Entries limited to ~1 MB each.`,
      {
        pattern: z.string().optional().describe("Pattern name (for single operation; ignored for batch)"),
        operation: z.enum(["create", "update", "archive", "batch"]).describe("create, update, archive, or batch. For batch: data is an array of {pattern, operation, data} items."),
        data: z.union([
          z.record(z.string(), z.unknown()).describe("For single ops: {facet: value, ...}. For update: include version for optimistic locking."),
          z.array(z.object({
            pattern: z.string(),
            operation: z.enum(["create", "update", "archive"]),
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
          const result = await store.batchMutate(JSON.stringify(batchData));
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
        if (!pattern || !operation || !singleData || typeof singleData !== "object" || Array.isArray(singleData)) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: "For single operations, pass pattern, operation (create|update|archive), and data (object). For batch, pass operation 'batch' with data as array." }],
          };
        }

        // Confirmation gate for system docs
        if (pattern === "_system_docs" && (operation === "update" || operation === "create")) {
          const confirmKey = `_system_docs_confirmed:${JSON.stringify(singleData)}`;
          const alreadyConfirmed = this.confirmed.has(confirmKey);

          if (!alreadyConfirmed) {
            this.confirmed.add(confirmKey);
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  confirmation_required: true,
                  message: "System docs affect all future agent sessions. Confirm this edit will make future runs more effective. Call mutate again with the same arguments to proceed.",
                  pattern,
                  operation,
                  data: singleData,
                }, null, 2),
              }],
            };
          }
          this.confirmed.delete(confirmKey);
        }

        const result = await store.mutate(pattern, operation, JSON.stringify(singleData));
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
