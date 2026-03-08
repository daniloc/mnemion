import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// === Types ===

interface CambiumIndex {
  version: number;
  updated_at: string;
  objects: IndexObjectEntry[];
  conventions: string[];
  guidance: string;
}

interface IndexObjectEntry {
  name: string;
  description: string;
  fields: IndexFieldEntry[];
  record_count: number;
}

interface IndexFieldEntry {
  name: string;
  type: string;
  required: boolean;
  default?: string | number | boolean | null;
}

// === Constants ===

const SQLITE_TYPE_MAP: Record<string, string> = {
  text: "TEXT",
  number: "REAL",
  integer: "INTEGER",
  boolean: "INTEGER",
  datetime: "TEXT",
};

// === Server ===

export class CambiumServer extends McpAgent {
  server = new McpServer({
    name: "cambium",
    version: "0.1.0",
  });

  private get db() {
    return this.ctx.storage.sql;
  }

  async init() {
    this.ensureTables();

    // --- get_index ---
    this.server.tool(
      "get_index",
      "Returns the master index. First call in every session. Complete orientation to what exists and what matters.",
      {},
      async () => {
        const index = this.getIndex();

        // Enrich with live record counts
        for (const obj of index.objects) {
          try {
            const row = this.db.exec(
              `SELECT COUNT(*) as count FROM "${obj.name}" WHERE archived_at IS NULL`
            ).one() as { count: number };
            obj.record_count = row.count;
          } catch {
            obj.record_count = 0;
          }
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(index, null, 2) }],
        };
      }
    );

    // --- propose_change ---
    this.server.tool(
      "propose_change",
      "Propose a structural change. Validates and returns a preview of the index after the change. Does not commit.",
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
          })).optional().describe("Fields to create (for create_object or add_field)"),
          convention: z.string().optional().describe("Convention text (for add_convention)"),
        }),
      },
      async ({ description, change }) => {
        return this.handleProposeChange(description, change);
      }
    );

    // --- apply_change ---
    this.server.tool(
      "apply_change",
      "Commit a previously proposed change. Updates SQLite schema and index atomically.",
      {
        change_id: z.string().describe("The change_id returned by propose_change"),
      },
      async ({ change_id }) => {
        return this.handleApplyChange(change_id);
      }
    );
  }

  // === Database ===

  private ensureTables() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS _index (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    )`);

    this.db.exec(`CREATE TABLE IF NOT EXISTS _schema_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      change_type TEXT NOT NULL,
      change_detail TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    this.db.exec(`CREATE TABLE IF NOT EXISTS _pending_changes (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      change_spec TEXT NOT NULL,
      preview_index TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    // Seed empty index if none exists
    const rows = this.db.exec("SELECT data FROM _index WHERE id = 1").toArray();
    if (rows.length === 0) {
      const emptyIndex: CambiumIndex = {
        version: 0,
        updated_at: new Date().toISOString(),
        objects: [],
        conventions: [],
        guidance:
          "This is a new Cambium instance. No objects exist yet. Create what the work demands.",
      };
      this.db.exec(
        "INSERT INTO _index (id, data) VALUES (1, ?)",
        JSON.stringify(emptyIndex)
      );
    }
  }

  private getIndex(): CambiumIndex {
    const row = this.db.exec(
      "SELECT data FROM _index WHERE id = 1"
    ).one() as { data: string };
    return JSON.parse(row.data);
  }

  private saveIndex(index: CambiumIndex) {
    index.updated_at = new Date().toISOString();
    index.version += 1;
    this.db.exec(
      "UPDATE _index SET data = ? WHERE id = 1",
      JSON.stringify(index)
    );
  }

  // === Tool handlers ===

  private handleProposeChange(description: string, change: any) {
    const currentIndex = this.getIndex();
    const preview = structuredClone(currentIndex);

    switch (change.type) {
      case "create_object": {
        if (!change.object_name)
          return this.error("object_name is required for create_object");
        if (!change.fields?.length)
          return this.error("At least one field is required for create_object");
        if (currentIndex.objects.some((o) => o.name === change.object_name))
          return this.error(`Object "${change.object_name}" already exists`);

        for (const f of change.fields) {
          if (!SQLITE_TYPE_MAP[f.type])
            return this.error(`Unknown field type: ${f.type}`);
        }

        preview.objects.push({
          name: change.object_name,
          description: change.object_description || "",
          fields: change.fields.map((f: any) => ({
            name: f.name,
            type: f.type,
            required: f.required ?? false,
            default: f.default_value ?? null,
          })),
          record_count: 0,
        });
        break;
      }

      case "add_field": {
        if (!change.object_name)
          return this.error("object_name is required for add_field");
        if (!change.fields?.length)
          return this.error("At least one field is required for add_field");

        const obj = preview.objects.find(
          (o) => o.name === change.object_name
        );
        if (!obj)
          return this.error(`Object "${change.object_name}" does not exist`);

        for (const f of change.fields) {
          if (obj.fields.some((existing) => existing.name === f.name))
            return this.error(
              `Field "${f.name}" already exists on "${change.object_name}"`
            );
          obj.fields.push({
            name: f.name,
            type: f.type,
            required: f.required ?? false,
            default: f.default_value ?? null,
          });
        }
        break;
      }

      case "add_convention": {
        if (!change.convention)
          return this.error("convention is required for add_convention");
        preview.conventions.push(change.convention);
        break;
      }
    }

    // Store pending change
    const changeId = crypto.randomUUID();
    this.db.exec(
      "INSERT INTO _pending_changes (id, description, change_spec, preview_index) VALUES (?, ?, ?, ?)",
      changeId,
      description,
      JSON.stringify(change),
      JSON.stringify(preview)
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              change_id: changeId,
              description,
              preview_index: preview,
              message:
                "Change proposed. Call apply_change with this change_id to commit.",
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private handleApplyChange(changeId: string) {
    const rows = this.db.exec(
      "SELECT * FROM _pending_changes WHERE id = ?",
      changeId
    ).toArray() as any[];

    if (rows.length === 0)
      return this.error(`No pending change found with id: ${changeId}`);

    const pending = rows[0];
    const change = JSON.parse(pending.change_spec);
    const previewIndex = JSON.parse(pending.preview_index) as CambiumIndex;

    try {
      switch (change.type) {
        case "create_object": {
          const fieldDefs = change.fields.map((f: any) => {
            let col = `"${f.name}" ${SQLITE_TYPE_MAP[f.type]}`;
            if (f.required) col += " NOT NULL";
            if (f.default_value != null) {
              col +=
                typeof f.default_value === "string"
                  ? ` DEFAULT '${f.default_value}'`
                  : ` DEFAULT ${f.default_value}`;
            }
            return col;
          });

          this.db.exec(`CREATE TABLE "${change.object_name}" (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ${fieldDefs.join(",\n            ")},
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            archived_at TEXT
          )`);
          break;
        }

        case "add_field": {
          for (const f of change.fields) {
            let ddl = `ALTER TABLE "${change.object_name}" ADD COLUMN "${f.name}" ${SQLITE_TYPE_MAP[f.type]}`;
            if (f.default_value != null) {
              ddl +=
                typeof f.default_value === "string"
                  ? ` DEFAULT '${f.default_value}'`
                  : ` DEFAULT ${f.default_value}`;
            }
            this.db.exec(ddl);
          }
          break;
        }

        case "add_convention":
          // Index-only change, no DDL
          break;
      }

      // Commit: update index, record history, clear pending
      this.saveIndex(previewIndex);

      this.db.exec(
        "INSERT INTO _schema_history (description, change_type, change_detail) VALUES (?, ?, ?)",
        pending.description,
        change.type,
        pending.change_spec
      );

      this.db.exec("DELETE FROM _pending_changes WHERE id = ?", changeId);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                applied: true,
                description: pending.description,
                index: previewIndex,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: any) {
      return this.error(`Failed to apply change: ${err.message}`);
    }
  }

  private error(message: string) {
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: message }],
    };
  }
}

export default CambiumServer.serve("/mcp");
