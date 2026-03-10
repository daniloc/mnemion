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
    { name: URI_SCHEME, version: "0.4.0" },
    {
      instructions: `${PRODUCT_NAME} is persistent shared memory. Read ${uri("_system/tools")} before your first action for full capability reference.

Key capabilities agents commonly miss:
- mutate accepts a batch parameter — an array of {object, operation, data} for atomic all-or-nothing execution (max 100 ops). Use it to combine multiple writes into one call.
- Update operations support optimistic locking via the version field. Include version from a prior read to prevent lost writes across concurrent surfaces.
- Fields support foreign key references to other objects. Use the references parameter in propose_change.
- ${uri("mutations")} is an audit log for diagnostics. Use it instead of querying records to verify data integrity.
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
      new ResourceTemplate(uri("schema/{object_name}"), {
        list: async () => {
          const names = await store.listObjects();
          return {
            resources: names.map((name) => ({
              uri: uri(`schema/${name}`),
              name: `${name} schema`,
              description: `Field definitions for ${name}`,
              mimeType: "application/json",
            })),
          };
        },
      }),
      { description: "Full field definitions for an object", mimeType: "application/json" },
      async (u, { object_name }) => {
        const result = await store.getSchema(object_name as string);
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
      "record",
      new ResourceTemplate(uri("records/{object}/{id}"), {
        list: undefined, // Records are too numerous to enumerate
      }),
      { description: "Individual record by object and ID", mimeType: "application/json" },
      async (u, { object, id }) => {
        const result = await store.getRecord(object as string, Number(id));
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
- ${uri("index")} — master index (orientation, what objects exist)
- ${uri("schema/{object}")} — field definitions for an object
- ${uri("records/{object}/{id}")} — a single record
- ${uri("history")} — schema change log (supports ?limit=N)
- ${uri("_system/")} — list all system docs
- ${uri("_system/{slug}")} — read a system doc (tools, schema-evolution, skills, conventions, index-guide)
- ${uri("_system/{slug}/default")} — read original seed version
- ${uri("mutations")} — mutation audit log (supports ?limit=N). Use for diagnostics and integrity checks.
- ${uri("mutations/{object}")} — mutations filtered to one object`,
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

Supports: create_object (with fields), add_field (to existing object), add_convention.
Fields can declare foreign key references to other objects via the references parameter.
Object/field names: lowercase, a-z/0-9/hyphens/underscores, max 64 chars. Max 64 fields per object.`,
      {
        description: z.string().describe("Natural language description of the change"),
        change: z.object({
          type: z.enum(["create_object", "add_field", "add_convention"]).describe("Type of structural change"),
          object_name: z.string().optional().describe("Target object name (for create_object and add_field)"),
          object_description: z.string().optional().describe("Purpose of the object (for create_object)"),
          fields: z.array(z.object({
            name: z.string(),
            type: z.enum(["text", "number", "integer", "boolean", "datetime"]),
            required: z.boolean().default(false),
            default_value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
            references: z.object({
              object: z.string().describe("Referenced object name"),
              field: z.string().default("id").describe("Referenced field (default: id)"),
            }).optional().describe("Foreign key reference to another object"),
          })).optional().describe("Fields to create (for create_object or add_field)"),
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
          if (parsed.index?.objects) {
            for (const obj of parsed.index.objects) {
              await this.server.server.sendResourceUpdated({ uri: uri(`schema/${obj.name}`) });
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
      "Read records from an object. Supports filtering, field projection, sorting, limits (max 1,000 rows). Use count_only for efficient counts without fetching records.",
      {
        object: z.string().describe("Object name to query"),
        filter: z.array(z.string()).optional().describe("Filter expressions: field=value, field>value, field~text (contains)"),
        fields: z.string().optional().describe("Comma-separated field names to return (default: all)"),
        sort: z.string().optional().describe("Field to sort by. Prefix with - for descending (e.g. -created_at)"),
        limit: z.number().optional().describe("Max records to return (default: 100)"),
        count_only: z.boolean().optional().describe("If true, return only the count matching the filters, not the records"),
      },
      async ({ object, filter, fields, sort, limit, count_only }) => {
        const result = await store.query(
          object,
          filter ? JSON.stringify(filter) : "",
          fields ?? "",
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
      "Cross-object full-text search. Searches all text fields across all objects (or specified objects) for a term. Returns matching records with matched field names.",
      {
        term: z.string().describe("Search term to find across all text fields"),
        objects: z.array(z.string()).optional().describe("Limit search to these object names (default: all objects)"),
        limit: z.number().optional().describe("Max total results (default: 20)"),
      },
      async ({ term, objects, limit }) => {
        const result = await store.search(
          term,
          objects ? JSON.stringify(objects) : "",
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
      `Create, update, or archive records. One tool for all writes.

Single: pass object + operation (create|update|archive) + data.
Batch: pass operation "batch" + data as array of [{object, operation, data}, ...] — atomic all-or-nothing, max 100 ops. Combine multiple writes into one call.

Update supports optimistic locking: include the version field from a prior read to detect conflicts across concurrent surfaces.

Large content: to write content too large for MCP parameters, create an _upload_tokens record with {target_object, target_id, target_field, mode}. Returns a single-use token (15-min expiry). POST content to /upload/{token} via HTTP.

Records limited to ~1 MB each.`,
      {
        object: z.string().optional().describe("Object name (for single operation; ignored for batch)"),
        operation: z.enum(["create", "update", "archive", "batch"]).describe("create, update, archive, or batch. For batch: data is an array of {object, operation, data} items."),
        data: z.union([
          z.record(z.string(), z.unknown()).describe("For single ops: {field: value, ...}. For update: include version for optimistic locking."),
          z.array(z.object({
            object: z.string(),
            operation: z.enum(["create", "update", "archive"]),
            data: z.record(z.string(), z.unknown()),
          })).describe("For batch: array of {object, operation, data} items."),
        ]),
      },
      async ({ object, operation, data }) => {
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
              content: [{ type: "text" as const, text: "For batch operations, data must be an array of {object, operation, data} items." }],
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
        if (!object || !operation || !singleData || typeof singleData !== "object" || Array.isArray(singleData)) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: "For single operations, pass object, operation (create|update|archive), and data (object). For batch, pass operation 'batch' with data as array." }],
          };
        }

        // Confirmation gate for system docs
        if (object === "_system_docs" && (operation === "update" || operation === "create")) {
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
                  object,
                  operation,
                  data: singleData,
                }, null, 2),
              }],
            };
          }
          this.confirmed.delete(confirmKey);
        }

        const result = await store.mutate(object, operation, JSON.stringify(singleData));
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
