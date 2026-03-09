import { DurableObject } from "cloudflare:workers";

// === Types ===

export interface CambiumIndex {
  version: number;
  updated_at: string;
  objects: IndexObjectEntry[];
  conventions: string[];
  guidance: string;
}

export interface IndexObjectEntry {
  name: string;
  description: string;
  fields: IndexFieldEntry[];
  record_count: number;
}

export interface IndexFieldEntry {
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

const KERNEL_COLUMNS = new Set(["id", "created_at", "updated_at", "archived_at"]);

// === CambiumStore: per-user data storage ===

export class CambiumStore extends DurableObject {
  private get db() {
    return this.ctx.storage.sql;
  }

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ensureTables();
    });
  }

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

    // Marketplace tokens (kernel table — always exists)
    this.db.exec(`CREATE TABLE IF NOT EXISTS "_marketplace_tokens" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL,
      "token" TEXT NOT NULL UNIQUE DEFAULT (hex(randomblob(16))),
      "scope" TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT
    )`);

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

    // Ensure _marketplace_tokens is registered in the index
    const index = this.getCurrentIndex();
    if (!index.objects.some((o) => o.name === "_marketplace_tokens")) {
      index.objects.push({
        name: "_marketplace_tokens",
        description: "Scoped access tokens for private marketplace delivery. Token auto-generated on create.",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "token", type: "text", required: false },
          { name: "scope", type: "text", required: false },
        ],
        record_count: 0,
      });
      index.version += 1;
      index.updated_at = new Date().toISOString();
      this.db.exec("UPDATE _index SET data = ? WHERE id = 1", JSON.stringify(index));
    }
  }

  // === RPC methods (called from CambiumSession) ===

  async getIndex(): Promise<string> {
    const row = this.db.exec(
      "SELECT data FROM _index WHERE id = 1"
    ).one() as { data: string };
    const index: CambiumIndex = JSON.parse(row.data);

    for (const obj of index.objects) {
      try {
        const r = this.db.exec(
          `SELECT COUNT(*) as count FROM "${obj.name}" WHERE archived_at IS NULL`
        ).one() as { count: number };
        obj.record_count = r.count;
      } catch {
        obj.record_count = 0;
      }
    }

    return JSON.stringify(index, null, 2);
  }

  async proposeChange(description: string, changeJson: string): Promise<string> {
    const change = JSON.parse(changeJson);
    const currentIndex = this.getCurrentIndex();
    const preview = structuredClone(currentIndex);

    switch (change.type) {
      case "create_object": {
        if (!change.object_name)
          return this.errorJson("object_name is required for create_object");
        if (!change.fields?.length)
          return this.errorJson("At least one field is required for create_object");
        if (currentIndex.objects.some((o: IndexObjectEntry) => o.name === change.object_name))
          return this.errorJson(`Object "${change.object_name}" already exists`);
        for (const f of change.fields) {
          if (!SQLITE_TYPE_MAP[f.type])
            return this.errorJson(`Unknown field type: ${f.type}`);
          if (KERNEL_COLUMNS.has(f.name))
            return this.errorJson(`Field "${f.name}" is a kernel-provided column and cannot be defined by the user`);
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
          return this.errorJson("object_name is required for add_field");
        if (!change.fields?.length)
          return this.errorJson("At least one field is required for add_field");
        const obj = preview.objects.find((o: IndexObjectEntry) => o.name === change.object_name);
        if (!obj)
          return this.errorJson(`Object "${change.object_name}" does not exist`);
        for (const f of change.fields) {
          if (KERNEL_COLUMNS.has(f.name))
            return this.errorJson(`Field "${f.name}" is a kernel-provided column and cannot be defined by the user`);
          if (obj.fields.some((existing: IndexFieldEntry) => existing.name === f.name))
            return this.errorJson(`Field "${f.name}" already exists on "${change.object_name}"`);
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
          return this.errorJson("convention is required for add_convention");
        preview.conventions.push(change.convention);
        break;
      }
    }

    const changeId = crypto.randomUUID();
    this.db.exec(
      "INSERT INTO _pending_changes (id, description, change_spec, preview_index) VALUES (?, ?, ?, ?)",
      changeId,
      description,
      JSON.stringify(change),
      JSON.stringify(preview)
    );

    return JSON.stringify({
      change_id: changeId,
      description,
      preview_index: preview,
      message: "Change proposed. Call apply_change with this change_id to commit.",
    }, null, 2);
  }

  async applyChange(changeId: string): Promise<string> {
    const rows = this.db.exec(
      "SELECT * FROM _pending_changes WHERE id = ?",
      changeId
    ).toArray() as any[];

    if (rows.length === 0)
      return this.errorJson(`No pending change found with id: ${changeId}`);

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
          break;
      }

      previewIndex.updated_at = new Date().toISOString();
      previewIndex.version += 1;

      // Update guidance if it still has the empty-instance text
      if (previewIndex.guidance.includes("No objects exist yet") && previewIndex.objects.length > 0) {
        previewIndex.guidance = "Cambium is active. Read cambium://index for orientation, then query and mutate to work with data.";
      }

      this.db.exec(
        "UPDATE _index SET data = ? WHERE id = 1",
        JSON.stringify(previewIndex)
      );

      this.db.exec(
        "INSERT INTO _schema_history (description, change_type, change_detail) VALUES (?, ?, ?)",
        pending.description,
        change.type,
        pending.change_spec
      );

      this.db.exec("DELETE FROM _pending_changes WHERE id = ?", changeId);

      return JSON.stringify({
        applied: true,
        description: pending.description,
        index: previewIndex,
      }, null, 2);
    } catch (err: any) {
      return this.errorJson(`Failed to apply change: ${err.message}`);
    }
  }

  // === Resource RPC methods ===

  async getSchema(objectName: string): Promise<string> {
    const index = this.getCurrentIndex();
    const obj = index.objects.find((o) => o.name === objectName);
    if (!obj) return this.errorJson(`Object "${objectName}" does not exist`);

    return JSON.stringify({
      object: obj.name,
      description: obj.description,
      fields: obj.fields,
      kernel_columns: ["id", "created_at", "updated_at", "archived_at"],
    }, null, 2);
  }

  async getHistory(limit: number): Promise<string> {
    const rows = this.db.exec(
      "SELECT * FROM _schema_history ORDER BY id DESC LIMIT ?",
      limit
    ).toArray();
    return JSON.stringify({ history: rows, count: rows.length }, null, 2);
  }

  async getRecord(objectName: string, recordId: number): Promise<string> {
    const index = this.getCurrentIndex();
    const obj = index.objects.find((o) => o.name === objectName);
    if (!obj) return this.errorJson(`Object "${objectName}" does not exist`);

    try {
      const rows = this.db.exec(
        `SELECT * FROM "${objectName}" WHERE id = ?`,
        recordId
      ).toArray();
      if (rows.length === 0) return this.errorJson(`Record ${recordId} not found in "${objectName}"`);
      return JSON.stringify({ object: objectName, record: rows[0] }, null, 2);
    } catch (err: any) {
      return this.errorJson(`Failed to read record: ${err.message}`);
    }
  }

  async listObjects(): Promise<string[]> {
    const index = this.getCurrentIndex();
    return index.objects.map((o) => o.name);
  }

  // === Data operations ===

  async query(objectName: string, filterJson: string, fields: string, sortField: string, limit: number, countOnly: boolean): Promise<string> {
    const index = this.getCurrentIndex();
    const obj = index.objects.find((o) => o.name === objectName);
    if (!obj) return this.errorJson(`Object "${objectName}" does not exist`);

    // Count-only mode: return count without records
    if (countOnly) {
      let countSql = `SELECT COUNT(*) as count FROM "${objectName}" WHERE archived_at IS NULL`;
      const countBindings: (string | number)[] = [];
      if (filterJson) {
        const filters: string[] = JSON.parse(filterJson);
        for (const expr of filters) {
          const match = expr.match(/^(\w+)(=|!=|>|<|>=|<=|~)(.+)$/);
          if (!match) return this.errorJson(`Invalid filter expression: ${expr}`);
          const [, field, op, value] = match;
          if (op === "~") {
            countSql += ` AND "${field}" LIKE ?`;
            countBindings.push(`%${value}%`);
          } else {
            countSql += ` AND "${field}" ${op} ?`;
            countBindings.push(value);
          }
        }
      }
      try {
        const r = this.db.exec(countSql, ...countBindings).one() as { count: number };
        return JSON.stringify({ object: objectName, count: r.count }, null, 2);
      } catch (err: any) {
        return this.errorJson(`Query failed: ${err.message}`);
      }
    }

    let sql = `SELECT`;

    // Projection
    if (fields) {
      const requested = fields.split(",").map((f) => f.trim());
      // Always include id
      if (!requested.includes("id")) requested.unshift("id");
      sql += ` ${requested.map((f) => `"${f}"`).join(", ")}`;
    } else {
      sql += ` *`;
    }

    sql += ` FROM "${objectName}" WHERE archived_at IS NULL`;

    // Filters: field=value, field>value, field<value, field~text
    const bindings: (string | number)[] = [];
    if (filterJson) {
      const filters: string[] = JSON.parse(filterJson);
      for (const expr of filters) {
        const match = expr.match(/^(\w+)(=|!=|>|<|>=|<=|~)(.+)$/);
        if (!match) return this.errorJson(`Invalid filter expression: ${expr}`);
        const [, field, op, value] = match;
        if (op === "~") {
          sql += ` AND "${field}" LIKE ?`;
          bindings.push(`%${value}%`);
        } else {
          sql += ` AND "${field}" ${op} ?`;
          bindings.push(value);
        }
      }
    }

    if (sortField) {
      const desc = sortField.startsWith("-");
      const col = desc ? sortField.slice(1) : sortField;
      sql += ` ORDER BY "${col}" ${desc ? "DESC" : "ASC"}`;
    }

    sql += ` LIMIT ${limit || 100}`;

    try {
      const rows = this.db.exec(sql, ...bindings).toArray();
      return JSON.stringify({ object: objectName, records: rows, count: rows.length }, null, 2);
    } catch (err: any) {
      return this.errorJson(`Query failed: ${err.message}`);
    }
  }

  async mutate(objectName: string, operation: string, dataJson: string): Promise<string> {
    const index = this.getCurrentIndex();
    const obj = index.objects.find((o) => o.name === objectName);
    if (!obj) return this.errorJson(`Object "${objectName}" does not exist`);

    const data = JSON.parse(dataJson);

    try {
      switch (operation) {
        case "create": {
          const fields = Object.keys(data).filter((k) => !KERNEL_COLUMNS.has(k));
          const cols = fields.map((f) => `"${f}"`).join(", ");
          const placeholders = fields.map(() => "?").join(", ");
          const values = fields.map((f) => data[f]);

          this.db.exec(
            `INSERT INTO "${objectName}" (${cols}) VALUES (${placeholders})`,
            ...values
          );

          // Get the inserted row
          const row = this.db.exec(
            `SELECT * FROM "${objectName}" WHERE id = last_insert_rowid()`
          ).one();

          return JSON.stringify({ operation: "create", object: objectName, record: row }, null, 2);
        }

        case "update": {
          if (!data.id) return this.errorJson("id is required for update");
          const fields = Object.keys(data).filter((k) => k !== "id" && !["created_at", "archived_at"].includes(k));
          if (fields.length === 0) return this.errorJson("No fields to update");

          const sets = fields.map((f) => `"${f}" = ?`).join(", ");
          const values = fields.map((f) => data[f]);
          values.push(data.id);

          this.db.exec(
            `UPDATE "${objectName}" SET ${sets}, updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL`,
            ...values
          );

          const row = this.db.exec(
            `SELECT * FROM "${objectName}" WHERE id = ?`,
            data.id
          ).one();

          return JSON.stringify({ operation: "update", object: objectName, record: row }, null, 2);
        }

        case "archive": {
          if (!data.id) return this.errorJson("id is required for archive");
          this.db.exec(
            `UPDATE "${objectName}" SET archived_at = datetime('now') WHERE id = ? AND archived_at IS NULL`,
            data.id
          );

          return JSON.stringify({ operation: "archive", object: objectName, id: data.id }, null, 2);
        }

        default:
          return this.errorJson(`Unknown operation: ${operation}. Use create, update, or archive.`);
      }
    } catch (err: any) {
      return this.errorJson(`Mutate failed: ${err.message}`);
    }
  }

  // === URI resolution ===

  async resolve(uri: string): Promise<string> {
    // Parse cambium:// URIs
    const match = uri.match(/^cambium:\/\/(.+)$/);
    if (!match) return this.errorJson(`Invalid URI scheme. Expected cambium:// URI, got: ${uri}`);

    const path = match[1];

    // cambium://index
    if (path === "index") {
      return this.getIndex();
    }

    // cambium://history or cambium://history?limit=N
    if (path === "history" || path.startsWith("history?")) {
      const params = new URLSearchParams(path.split("?")[1] || "");
      const limit = Number(params.get("limit")) || 20;
      return this.getHistory(limit);
    }

    // cambium://schema/{object_name}
    const schemaMatch = path.match(/^schema\/(.+)$/);
    if (schemaMatch) {
      return this.getSchema(schemaMatch[1]);
    }

    // cambium://records/{object}/{id}
    const recordMatch = path.match(/^records\/([^/]+)\/(.+)$/);
    if (recordMatch) {
      return this.getRecord(recordMatch[1], Number(recordMatch[2]));
    }

    return this.errorJson(`Unknown URI: ${uri}. Valid patterns: cambium://index, cambium://schema/{object}, cambium://records/{object}/{id}, cambium://history`);
  }

  // === Cross-object search ===

  async search(term: string, objectsJson: string, limit: number): Promise<string> {
    const index = this.getCurrentIndex();
    const targetObjects = objectsJson
      ? JSON.parse(objectsJson) as string[]
      : index.objects.map((o) => o.name);

    const results: { object: string; record: any; matched_fields: string[] }[] = [];

    for (const objName of targetObjects) {
      const obj = index.objects.find((o) => o.name === objName);
      if (!obj) continue;

      // Search all text-type fields
      const textFields = obj.fields
        .filter((f) => f.type === "text")
        .map((f) => f.name);
      if (textFields.length === 0) continue;

      const conditions = textFields.map((f) => `"${f}" LIKE ?`).join(" OR ");
      const bindings = textFields.map(() => `%${term}%`);

      try {
        const rows = this.db.exec(
          `SELECT * FROM "${objName}" WHERE archived_at IS NULL AND (${conditions}) LIMIT ?`,
          ...bindings,
          limit
        ).toArray();

        for (const row of rows) {
          const matched = textFields.filter((f) => {
            const val = (row as any)[f];
            return typeof val === "string" && val.toLowerCase().includes(term.toLowerCase());
          });
          results.push({ object: objName, record: row, matched_fields: matched });
        }
      } catch {
        // Skip objects that error (e.g., table doesn't exist yet)
      }

      if (results.length >= limit) break;
    }

    return JSON.stringify({
      term,
      results: results.slice(0, limit),
      count: Math.min(results.length, limit),
    }, null, 2);
  }

  // === Marketplace ===

  async getMarketplaceDataForToken(token: string): Promise<string> {
    try {
      const rows = this.db.exec(
        `SELECT * FROM "_marketplace_tokens" WHERE token = ? AND archived_at IS NULL`,
        token
      ).toArray() as any[];
      if (rows.length === 0) {
        return JSON.stringify({ error: true, message: "Invalid token" });
      }
      const scope = rows[0].scope ? JSON.parse(rows[0].scope) as string[] : null;
      return this.getMarketplaceDataScoped(scope);
    } catch {
      return JSON.stringify({ error: true, message: "Token validation failed" });
    }
  }

  async getMarketplaceDataPublic(): Promise<string> {
    return this.getMarketplaceDataScoped(null, true);
  }

  private getMarketplaceDataScoped(pluginNames: string[] | null, publicOnly: boolean = false): string {
    const index = this.getCurrentIndex();
    const hasPlugins = index.objects.some((o) => o.name === "_plugins");
    const hasSkills = index.objects.some((o) => o.name === "_skills");

    if (!hasPlugins || !hasSkills) {
      return JSON.stringify({ plugins: [] });
    }

    try {
      let pluginSql = `SELECT * FROM "_plugins" WHERE archived_at IS NULL`;
      const bindings: any[] = [];
      if (publicOnly) pluginSql += ` AND visibility = 'public'`;
      if (pluginNames) {
        pluginSql += ` AND name IN (${pluginNames.map(() => "?").join(", ")})`;
        bindings.push(...pluginNames);
      }
      const plugins = this.db.exec(pluginSql, ...bindings).toArray() as any[];

      const result = [];
      for (const plugin of plugins) {
        let skillSql = `SELECT * FROM "_skills" WHERE plugin_id = ? AND archived_at IS NULL`;
        const skillBindings: any[] = [plugin.id];
        if (publicOnly) skillSql += ` AND visibility = 'public'`;
        const skills = this.db.exec(skillSql, ...skillBindings).toArray();

        // For public: skip plugin if any skill is private (partial exposure)
        if (publicOnly) {
          const total = this.db.exec(
            `SELECT COUNT(*) as count FROM "_skills" WHERE plugin_id = ? AND archived_at IS NULL`,
            plugin.id
          ).one() as { count: number };
          if (total.count !== skills.length) continue;
        }

        result.push({ ...plugin, skills });
      }
      return JSON.stringify({ plugins: result });
    } catch {
      return JSON.stringify({ plugins: [] });
    }
  }

  // === Helpers ===

  private getCurrentIndex(): CambiumIndex {
    const row = this.db.exec(
      "SELECT data FROM _index WHERE id = 1"
    ).one() as { data: string };
    return JSON.parse(row.data);
  }

  private errorJson(message: string): string {
    return JSON.stringify({ error: true, message });
  }
}
