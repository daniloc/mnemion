import { McpAgent } from "agents/mcp";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HiveDO } from "./hive";
import { PRODUCT_NAME, URI_SCHEME, uri } from "./constants";
import { TOOLS } from "./tools";

// === Types ===

interface Env {
  MNEMION_HIVE: DurableObjectNamespace<HiveDO>;
}

interface AuthProps {
  userId: string;
  [key: string]: unknown;
}

function toolDesc(name: string): string {
  return TOOLS.find(t => t.name === name)!.description;
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
- ${uri("_system/")} has detailed reference docs if needed.`,
    },
  );

  private confirmed = new Set<string>();

  private getHive(): DurableObjectStub<HiveDO> {
    const userId = this.props?.userId ?? "anonymous";
    const id = this.env.MNEMION_HIVE.idFromName(`user:${userId}`);
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
        uri: z.string().describe(`A ${URI_SCHEME}:// URI — local or foreign (e.g. ${URI_SCHEME}://other.host.dev/path)`),
      },
      async ({ uri: resolveUri }) => {
        const result = await hive.resolve(resolveUri);
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
          type: z.enum(["create_pattern", "add_facet", "set_sharing", "set_options", "set_doctrine", "archive_pattern", "unarchive_pattern"]).describe("Type of structural change"),
          pattern_name: z.string().optional().describe("Target pattern name"),
          pattern_description: z.string().optional().describe("Purpose of the pattern (for create_pattern)"),
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
      toolDesc("query"),
      {
        pattern: z.string().describe("Pattern name to query"),
        filter: z.array(z.string()).optional().describe("Filter expressions: facet=value, facet>value, facet~text (contains)"),
        facets: z.string().optional().describe("Comma-separated facet names to return (default: all)"),
        sort: z.string().optional().describe("Facet to sort by. Prefix with - for descending (e.g. -created_at)"),
        limit: z.number().optional().describe("Max entries to return (default: 100)"),
        count_only: z.boolean().optional().describe("If true, return only the count matching the filters, not the entries"),
      },
      async ({ pattern, filter, facets, sort, limit, count_only }) => {
        const result = await hive.query(
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
        limit: z.number().optional().describe("Max results (default: 5, max: 20)"),
      },
      async ({ context, patterns, limit }) => {
        const result = await hive.prime(
          context,
          patterns ? JSON.stringify(patterns) : "",
          limit ?? 5
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

        const result = await hive.mutate(pattern, operation, JSON.stringify(singleData));
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
