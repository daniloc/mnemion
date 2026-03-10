import { DurableObject } from "cloudflare:workers";
import { PRODUCT_NAME, URI_SCHEME, URI_PREFIX, uri } from "./constants";
import { evaluateMapping } from "./transform";

// System docs — imported as raw text, placeholders resolved at load time
import toolsRaw from "./system-docs/tools.md";
import schemaEvolutionRaw from "./system-docs/schema-evolution.md";
import skillsRaw from "./system-docs/skills.md";
import conventionsRaw from "./system-docs/conventions.md";
import indexGuideRaw from "./system-docs/index-guide.md";
import remoteAccessRaw from "./system-docs/remote-access.md";
import httpIoRaw from "./system-docs/http-io.md";

// === Types ===

export interface StoreIndex {
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
  references?: string | null;
}

// === Constants ===

const SQLITE_TYPE_MAP: Record<string, string> = {
  text: "TEXT",
  number: "REAL",
  integer: "INTEGER",
  boolean: "INTEGER",
  datetime: "TEXT",
};

// version is intentionally excluded — it may be a user field (e.g. semver on _plugins).
// Kernel version handling is conditional per-table via hasKernelVersion().
const KERNEL_COLUMNS = new Set(["id", "created_at", "updated_at", "archived_at"]);

// === Guardrails ===

const LIMITS = {
  RECORD_BYTES: 1_048_576,    // 1 MB per record
  QUERY_ROWS: 1_000,          // max rows a single query can return
  BATCH_OPS: 100,             // max operations in a single batch mutate
  NAME_MAX_LEN: 64,           // max length for object/field names
  FIELDS_PER_OBJECT: 64,      // max fields on a single object
};

const NAME_RE = /^[a-z][a-z0-9_-]*$/;  // lowercase, starts with letter, allows hyphens/underscores/digits

function validateName(kind: string, name: string): string | null {
  if (!name || name.length > LIMITS.NAME_MAX_LEN) {
    return `${kind} name must be 1–${LIMITS.NAME_MAX_LEN} characters, got ${name?.length ?? 0}`;
  }
  if (!NAME_RE.test(name)) {
    return `${kind} name must be lowercase, start with a letter, and contain only a-z, 0-9, hyphens, underscores. Got: "${name}"`;
  }
  return null;
}

function estimateRecordBytes(data: Record<string, unknown>): number {
  let bytes = 0;
  for (const v of Object.values(data)) {
    if (typeof v === "string") bytes += v.length * 2;  // rough UTF-16 estimate
    else if (typeof v === "number") bytes += 8;
    else if (typeof v === "boolean") bytes += 4;
    else if (v === null || v === undefined) bytes += 0;
    else bytes += JSON.stringify(v).length * 2;
  }
  return bytes;
}

// === System docs: loaded from markdown files ===

/** Resolve {{placeholder}} syntax in system doc markdown. */
function resolveDocPlaceholders(raw: string): string {
  return raw
    .replace(/\{\{PRODUCT_NAME\}\}/g, PRODUCT_NAME)
    .replace(/\{\{URI_SCHEME\}\}/g, URI_SCHEME)
    .replace(/\{\{URI_PREFIX\}\}/g, URI_PREFIX)
    .replace(/\{\{uri:(.*?)\}\}/g, (_, path) => uri(path));
}

/** Parse frontmatter (slug, title) and body from a markdown string. */
function parseDocFile(raw: string): { slug: string; title: string; content: string } {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) throw new Error("System doc missing frontmatter");
  const fm = fmMatch[1];
  const body = resolveDocPlaceholders(fmMatch[2].trimEnd());
  const slug = fm.match(/^slug:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const title = fm.match(/^title:\s*"?([^"\n]+)"?$/m)?.[1]?.trim() ?? "";
  return { slug, title, content: body };
}

const SYSTEM_DOCS_SEED = [
  toolsRaw, schemaEvolutionRaw, skillsRaw, conventionsRaw,
  indexGuideRaw, remoteAccessRaw, httpIoRaw,
].map(parseDocFile);


// === MnemionStore: per-user data storage ===

export class StoreDO extends DurableObject {
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
    // === Normalized schema tables (replacing _index JSON blob) ===

    this.db.exec(`CREATE TABLE IF NOT EXISTS _objects (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT ''
    )`);

    this.db.exec(`CREATE TABLE IF NOT EXISTS _fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      object_name TEXT NOT NULL REFERENCES _objects(name),
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 0,
      default_value TEXT,
      references_object TEXT,
      UNIQUE(object_name, name)
    )`);

    this.db.exec(`CREATE TABLE IF NOT EXISTS _conventions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    this.db.exec(`CREATE TABLE IF NOT EXISTS _meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL DEFAULT 0,
      guidance TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    // === Migrate from _index JSON blob if present ===

    const hasOldIndex = this.db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_index'"
    ).toArray().length > 0;

    if (hasOldIndex) {
      const rows = this.db.exec("SELECT data FROM _index WHERE id = 1").toArray();
      if (rows.length > 0) {
        const index = JSON.parse((rows[0] as any).data) as StoreIndex;

        this.db.exec(
          "INSERT OR IGNORE INTO _meta (id, version, guidance, updated_at) VALUES (1, ?, ?, ?)",
          index.version, index.guidance, index.updated_at
        );

        for (const obj of index.objects) {
          this.db.exec(
            "INSERT OR IGNORE INTO _objects (name, description) VALUES (?, ?)",
            obj.name, obj.description
          );
          for (const f of obj.fields) {
            this.db.exec(
              "INSERT OR IGNORE INTO _fields (object_name, name, type, required, default_value) VALUES (?, ?, ?, ?, ?)",
              obj.name, f.name, f.type, f.required ? 1 : 0,
              f.default != null ? JSON.stringify(f.default) : null
            );
          }
        }

        for (const c of index.conventions) {
          this.db.exec("INSERT INTO _conventions (text) VALUES (?)", c);
        }
      }

      this.db.exec("DROP TABLE _index");
    }

    // === Ensure meta row exists (fresh install) ===

    const metaRows = this.db.exec("SELECT id FROM _meta WHERE id = 1").toArray();
    if (metaRows.length === 0) {
      this.db.exec(
        "INSERT INTO _meta (id, version, guidance) VALUES (1, 0, ?)",
        `This is a new ${PRODUCT_NAME} instance. No objects exist yet. Create what the work demands.`
      );
    }

    // One-time rename fixup: replace stale "Cambium" references in stored data
    this.db.exec(
      "UPDATE _meta SET guidance = ? WHERE id = 1 AND guidance LIKE '%Cambium%'",
      `${PRODUCT_NAME} is active. Read ${uri("index")} for orientation, then query and mutate to work with data.`
    );
    this.db.exec(
      "UPDATE _objects SET description = REPLACE(description, 'Cambium', ?) WHERE description LIKE '%Cambium%'",
      PRODUCT_NAME
    );

    // === Other kernel tables ===

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

    this.db.exec(`CREATE TABLE IF NOT EXISTS "_marketplace_tokens" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL,
      "token" TEXT NOT NULL UNIQUE DEFAULT (hex(randomblob(16))),
      "scope" TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT
    )`);

    this.db.exec(`CREATE TABLE IF NOT EXISTS _passkeys (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      credential_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    // === HTTP I/O endpoints ===

    this.db.exec(`CREATE TABLE IF NOT EXISTS "_outputs" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "path" TEXT NOT NULL,
      "content" TEXT NOT NULL,
      "mime_type" TEXT NOT NULL DEFAULT 'text/plain',
      "visibility" TEXT NOT NULL DEFAULT 'public',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT,
      version INTEGER NOT NULL DEFAULT 0
    )`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "_outputs_path_active" ON "_outputs" ("path") WHERE archived_at IS NULL`);

    this.db.exec(`CREATE TABLE IF NOT EXISTS "_inputs" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "path" TEXT NOT NULL,
      "target_object" TEXT NOT NULL,
      "body_field" TEXT,
      "field_mapping" TEXT,
      "visibility" TEXT NOT NULL DEFAULT 'public',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT,
      version INTEGER NOT NULL DEFAULT 0
    )`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "_inputs_path_active" ON "_inputs" ("path") WHERE archived_at IS NULL`);

    this.db.exec(`CREATE TABLE IF NOT EXISTS "_system_docs" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "slug" TEXT NOT NULL UNIQUE,
      "title" TEXT NOT NULL,
      "content" TEXT,
      "default_content" TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    // Seed system docs (insert new, update default_content on existing)
    for (const doc of SYSTEM_DOCS_SEED) {
      const existing = this.db.exec(
        `SELECT id, default_content FROM "_system_docs" WHERE slug = ?`, doc.slug
      ).toArray() as any[];
      if (existing.length === 0) {
        this.db.exec(
          `INSERT INTO "_system_docs" (slug, title, content, default_content) VALUES (?, ?, ?, ?)`,
          doc.slug, doc.title, doc.content, doc.content
        );
      } else if (existing[0].default_content !== doc.content) {
        // Source changed — update default_content (and content if it was still on the old default)
        const wasDefault = existing[0].default_content === (this.db.exec(
          `SELECT content FROM "_system_docs" WHERE id = ?`, existing[0].id
        ).one() as any)?.content;
        this.db.exec(
          `UPDATE "_system_docs" SET default_content = ?, title = ?${wasDefault ? ', content = ?' : ''}, updated_at = datetime('now') WHERE id = ?`,
          ...(wasDefault
            ? [doc.content, doc.title, doc.content, existing[0].id]
            : [doc.content, doc.title, existing[0].id])
        );
      }
    }

    // === Migrate: add version column to existing user tables ===

    const userObjects = this.db.exec(
      "SELECT name FROM _objects WHERE name NOT LIKE '\\_%' ESCAPE '\\'"
    ).toArray() as any[];
    for (const obj of userObjects) {
      try {
        this.db.exec(`ALTER TABLE "${obj.name}" ADD COLUMN version INTEGER NOT NULL DEFAULT 0`);
      } catch {
        // Column already exists
      }
    }

    // === Migrate: add bookmark column to _schema_history ===

    try {
      this.db.exec(`ALTER TABLE _schema_history ADD COLUMN bookmark TEXT`);
    } catch {
      // Column already exists
    }

    // === Migrate: add references_object column to _fields ===

    try {
      this.db.exec(`ALTER TABLE _fields ADD COLUMN references_object TEXT`);
    } catch {
      // Column already exists
    }

    // === Migrate: rebuild _outputs/_inputs to replace column-level UNIQUE with partial index ===

    for (const table of ["_outputs", "_inputs"]) {
      // Detect old schema by checking sqlite_master for the auto-index created by column-level UNIQUE
      const autoIdx = this.db.exec(
        `SELECT 1 FROM sqlite_master WHERE type='index' AND name LIKE 'sqlite_autoindex_${table}_%'`
      ).toArray();
      if (autoIdx.length > 0) {
        // Auto-index exists → old column-level UNIQUE, needs rebuild
        const cols = table === "_outputs"
          ? `id, "path", "content", "mime_type", "visibility", created_at, updated_at, archived_at`
          : `id, "path", "target_object", "body_field", "field_mapping", "visibility", created_at, updated_at, archived_at`;
        const newCols = table === "_outputs"
          ? `id INTEGER PRIMARY KEY AUTOINCREMENT, "path" TEXT NOT NULL, "content" TEXT NOT NULL, "mime_type" TEXT NOT NULL DEFAULT 'text/plain', "visibility" TEXT NOT NULL DEFAULT 'public', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), archived_at TEXT, version INTEGER NOT NULL DEFAULT 0`
          : `id INTEGER PRIMARY KEY AUTOINCREMENT, "path" TEXT NOT NULL, "target_object" TEXT NOT NULL, "body_field" TEXT, "field_mapping" TEXT, "visibility" TEXT NOT NULL DEFAULT 'public', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), archived_at TEXT, version INTEGER NOT NULL DEFAULT 0`;
        // Also copy version if it exists (may have been added by ALTER TABLE)
        let selectCols = cols;
        try {
          this.db.exec(`SELECT version FROM "${table}" LIMIT 0`);
          selectCols = cols + ", version";
        } catch { /* version column doesn't exist yet */ }
        this.db.exec(`CREATE TABLE "${table}_new" (${newCols})`);
        this.db.exec(`INSERT INTO "${table}_new" (${selectCols}) SELECT ${selectCols} FROM "${table}"`);
        this.db.exec(`DROP TABLE "${table}"`);
        this.db.exec(`ALTER TABLE "${table}_new" RENAME TO "${table}"`);
      }
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "${table}_path_active" ON "${table}" ("path") WHERE archived_at IS NULL`);
    }

    // === Mutation audit log ===

    this.db.exec(`CREATE TABLE IF NOT EXISTS _mutation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      record_id INTEGER,
      operation TEXT NOT NULL,
      old_data TEXT,
      new_data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    // Create audit triggers for all registered user objects
    const allObjects = this.db.exec(
      "SELECT name FROM _objects"
    ).toArray() as any[];
    for (const obj of allObjects) {
      this.ensureAuditTriggers(obj.name);
    }

    // === Auth codes (one-time, for remote agents) ===

    this.db.exec(`CREATE TABLE IF NOT EXISTS "_auth_codes" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "code" TEXT NOT NULL UNIQUE DEFAULT (hex(randomblob(16))),
      "label" TEXT,
      "expires_at" TEXT NOT NULL,
      "consumed_at" TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT
    )`);

    // === Upload tokens ===

    this.db.exec(`CREATE TABLE IF NOT EXISTS "_upload_tokens" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "token" TEXT NOT NULL UNIQUE DEFAULT (hex(randomblob(16))),
      "target_object" TEXT NOT NULL,
      "target_id" INTEGER NOT NULL,
      "target_field" TEXT NOT NULL,
      "mode" TEXT NOT NULL DEFAULT 'replace',
      "expires_at" TEXT NOT NULL,
      "consumed_at" TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT
    )`);

    // === Register kernel tables in normalized schema ===

    this.registerKernelObject("_auth_codes",
      "One-time auth codes for remote agents. Code and expiry auto-generated on create. Single-use — consumed when used to authenticate.",
      [
        { name: "code", type: "text", required: false },
        { name: "label", type: "text", required: false },
        { name: "expires_at", type: "datetime", required: false },
        { name: "consumed_at", type: "datetime", required: false },
      ]
    );

    this.registerKernelObject("_upload_tokens",
      "Temporary capability tokens for large content uploads via HTTP POST. Token and expiry auto-generated on create. Single-use.",
      [
        { name: "token", type: "text", required: false },
        { name: "target_object", type: "text", required: true },
        { name: "target_id", type: "integer", required: true },
        { name: "target_field", type: "text", required: true },
        { name: "mode", type: "text", required: false },
        { name: "expires_at", type: "datetime", required: false },
        { name: "consumed_at", type: "datetime", required: false },
      ]
    );

    this.registerKernelObject("_marketplace_tokens",
      "Scoped access tokens for private marketplace delivery. Token auto-generated on create.",
      [
        { name: "name", type: "text", required: true },
        { name: "token", type: "text", required: false },
        { name: "scope", type: "text", required: false },
      ]
    );

    this.registerKernelObject("_outputs",
      "HTTP egress endpoints. Each record serves content at GET /o/{path}. Public by default.",
      [
        { name: "path", type: "text", required: true },
        { name: "content", type: "text", required: true },
        { name: "mime_type", type: "text", required: false },
        { name: "visibility", type: "text", required: false },
      ]
    );

    this.registerKernelObject("_inputs",
      "HTTP ingress endpoints. Each record accepts POST /i/{path} and creates records in target_object. Supports field_mapping DSL for JSON body transformation.",
      [
        { name: "path", type: "text", required: true },
        { name: "target_object", type: "text", required: true },
        { name: "body_field", type: "text", required: false },
        { name: "field_mapping", type: "text", required: false },
        { name: "visibility", type: "text", required: false },
      ]
    );

    this.registerKernelObject("_system_docs",
      "System documentation for agent orientation. Editable but requires confirmation. Set content to null to restore defaults.",
      [
        { name: "slug", type: "text", required: true },
        { name: "title", type: "text", required: true },
        { name: "content", type: "text", required: false },
        { name: "default_content", type: "text", required: true },
      ]
    );
  }

  private registerKernelObject(
    name: string,
    description: string,
    fields: { name: string; type: string; required: boolean }[]
  ) {
    this.db.exec(
      "INSERT OR IGNORE INTO _objects (name, description) VALUES (?, ?)",
      name, description
    );
    for (const f of fields) {
      this.db.exec(
        "INSERT OR IGNORE INTO _fields (object_name, name, type, required) VALUES (?, ?, ?, ?)",
        name, f.name, f.type, f.required ? 1 : 0
      );
    }
  }

  // === RPC methods (called from MnemionSession) ===

  async getIndex(): Promise<string> {
    const index = this.getCurrentIndex();

    // Enrich with live record counts
    for (const obj of index.objects) {
      try {
        const r = this.db.exec(
          `SELECT COUNT(*) as count FROM "${obj.name}" WHERE archived_at IS NULL`
        ).one() as { count: number };
        obj.record_count = r.count;
      } catch {
        try {
          const r = this.db.exec(
            `SELECT COUNT(*) as count FROM "${obj.name}"`
          ).one() as { count: number };
          obj.record_count = r.count;
        } catch {
          obj.record_count = 0;
        }
      }
    }

    return JSON.stringify({
      ...index,
      system_docs: uri("_system/"),
    }, null, 2);
  }

  async proposeChange(description: string, changeJson: string): Promise<string> {
    const change = JSON.parse(changeJson);
    const currentIndex = this.getCurrentIndex();
    const preview = structuredClone(currentIndex);

    switch (change.type) {
      case "create_object": {
        if (!change.object_name)
          return this.errorJson("object_name is required for create_object");
        const objNameErr = validateName("Object", change.object_name);
        if (objNameErr) return this.errorJson(objNameErr);
        if (!change.fields?.length)
          return this.errorJson("At least one field is required for create_object");
        if (change.fields.length > LIMITS.FIELDS_PER_OBJECT)
          return this.errorJson(`Too many fields: ${change.fields.length} exceeds limit of ${LIMITS.FIELDS_PER_OBJECT}`);
        if (this.objectExists(change.object_name))
          return this.errorJson(`Object "${change.object_name}" already exists`);
        for (const f of change.fields) {
          const fieldNameErr = validateName("Field", f.name);
          if (fieldNameErr) return this.errorJson(fieldNameErr);
          if (!SQLITE_TYPE_MAP[f.type])
            return this.errorJson(`Unknown field type: ${f.type}`);
          if (KERNEL_COLUMNS.has(f.name))
            return this.errorJson(`Field "${f.name}" is a kernel-provided column and cannot be defined by the user`);
          if (f.references && !this.objectExists(f.references.object))
            return this.errorJson(`Referenced object "${f.references.object}" does not exist`);
        }

        preview.objects.push({
          name: change.object_name,
          description: change.object_description || "",
          fields: change.fields.map((f: any) => {
            const field: IndexFieldEntry = {
              name: f.name,
              type: f.type,
              required: f.required ?? false,
              default: f.default_value ?? null,
            };
            if (f.references) field.references = f.references.object;
            return field;
          }),
          record_count: 0,
        });
        break;
      }

      case "add_field": {
        if (!change.object_name)
          return this.errorJson("object_name is required for add_field");
        if (!change.fields?.length)
          return this.errorJson("At least one field is required for add_field");
        if (!this.objectExists(change.object_name))
          return this.errorJson(`Object "${change.object_name}" does not exist`);

        const obj = preview.objects.find((o: IndexObjectEntry) => o.name === change.object_name);
        if (!obj)
          return this.errorJson(`Object "${change.object_name}" does not exist`);

        if (obj.fields.length + change.fields.length > LIMITS.FIELDS_PER_OBJECT)
          return this.errorJson(`Adding ${change.fields.length} fields would exceed the limit of ${LIMITS.FIELDS_PER_OBJECT} fields per object`);

        for (const f of change.fields) {
          const fieldNameErr = validateName("Field", f.name);
          if (fieldNameErr) return this.errorJson(fieldNameErr);
          if (KERNEL_COLUMNS.has(f.name))
            return this.errorJson(`Field "${f.name}" is a kernel-provided column and cannot be defined by the user`);
          if (obj.fields.some((existing: IndexFieldEntry) => existing.name === f.name))
            return this.errorJson(`Field "${f.name}" already exists on "${change.object_name}"`);
          if (f.references && !this.objectExists(f.references.object))
            return this.errorJson(`Referenced object "${f.references.object}" does not exist`);
          const field: IndexFieldEntry = {
            name: f.name,
            type: f.type,
            required: f.required ?? false,
            default: f.default_value ?? null,
          };
          if (f.references) field.references = f.references.object;
          obj.fields.push(field);
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
            if (f.references) {
              col += ` REFERENCES "${f.references.object}"("${f.references.field || 'id'}")`;
            }
            return col;
          });

          const hasUserVersion = change.fields.some((f: any) => f.name === "version");
          const kernelCols = [
            ...(hasUserVersion ? [] : ["version INTEGER NOT NULL DEFAULT 0"]),
            "created_at TEXT NOT NULL DEFAULT (datetime('now'))",
            "updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
            "archived_at TEXT",
          ];
          this.db.exec(`CREATE TABLE "${change.object_name}" (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ${fieldDefs.join(",\n            ")},
            ${kernelCols.join(",\n            ")}
          )`);

          // Register in normalized schema
          this.db.exec(
            "INSERT INTO _objects (name, description) VALUES (?, ?)",
            change.object_name, change.object_description || ""
          );
          for (const f of change.fields) {
            this.db.exec(
              "INSERT INTO _fields (object_name, name, type, required, default_value, references_object) VALUES (?, ?, ?, ?, ?, ?)",
              change.object_name, f.name, f.type, f.required ? 1 : 0,
              f.default_value != null ? JSON.stringify(f.default_value) : null,
              f.references?.object ?? null
            );
          }

          // Create audit triggers for the new table
          this.ensureAuditTriggers(change.object_name);
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
            if (f.references) {
              ddl += ` REFERENCES "${f.references.object}"("${f.references.field || 'id'}")`;
            }
            this.db.exec(ddl);
          }

          // Register fields in normalized schema
          for (const f of change.fields) {
            this.db.exec(
              "INSERT INTO _fields (object_name, name, type, required, default_value, references_object) VALUES (?, ?, ?, ?, ?, ?)",
              change.object_name, f.name, f.type, f.required ? 1 : 0,
              f.default_value != null ? JSON.stringify(f.default_value) : null,
              f.references?.object ?? null
            );
          }

          // Recreate audit triggers (columns changed)
          this.db.exec(`DROP TRIGGER IF EXISTS "_audit_${change.object_name}_insert"`);
          this.db.exec(`DROP TRIGGER IF EXISTS "_audit_${change.object_name}_update"`);
          this.db.exec(`DROP TRIGGER IF EXISTS "_audit_${change.object_name}_delete"`);
          this.ensureAuditTriggers(change.object_name);
          break;
        }

        case "add_convention": {
          this.db.exec("INSERT INTO _conventions (text) VALUES (?)", change.convention);
          break;
        }
      }

      // Update meta
      this.db.exec(
        "UPDATE _meta SET version = version + 1, updated_at = datetime('now')"
      );

      // Update guidance if still has empty-instance text
      const meta = this.db.exec("SELECT guidance FROM _meta WHERE id = 1").one() as { guidance: string };
      if (meta.guidance.includes("No objects exist yet")) {
        const objCount = this.db.exec("SELECT COUNT(*) as count FROM _objects").one() as { count: number };
        if (objCount.count > 0) {
          this.db.exec(
            "UPDATE _meta SET guidance = ?",
            `${PRODUCT_NAME} is active. Read ${uri("index")} for orientation, then query and mutate to work with data.`
          );
        }
      }

      // Log to history with PITR bookmark for rollback
      let bookmark: string | null = null;
      try {
        bookmark = await this.ctx.storage.getCurrentBookmark();
      } catch {
        // PITR not available (local dev)
      }
      this.db.exec(
        "INSERT INTO _schema_history (description, change_type, change_detail, bookmark) VALUES (?, ?, ?, ?)",
        pending.description,
        change.type,
        pending.change_spec,
        bookmark
      );

      this.db.exec("DELETE FROM _pending_changes WHERE id = ?", changeId);

      // Synthesize current index for response
      const currentIndex = this.getCurrentIndex();

      return JSON.stringify({
        applied: true,
        description: pending.description,
        index: currentIndex,
      }, null, 2);
    } catch (err: any) {
      return this.errorJson(`Failed to apply change: ${err.message}`);
    }
  }

  // === Schema rollback via PITR ===

  async revertChange(historyId: number): Promise<string> {
    const rows = this.db.exec(
      "SELECT * FROM _schema_history WHERE id = ?", historyId
    ).toArray() as any[];

    if (rows.length === 0)
      return this.errorJson(`No schema history entry with id: ${historyId}`);

    const entry = rows[0];
    if (!entry.bookmark)
      return this.errorJson("No PITR bookmark stored for this change. Rollback unavailable (change may predate PITR support or was made in local dev).");

    try {
      this.ctx.storage.onNextSessionRestoreBookmark(entry.bookmark);
      this.ctx.abort();
      return JSON.stringify({
        reverted: true,
        description: entry.description,
        message: "PITR restore initiated. The Durable Object will restart at the state before this change. WARNING: This restores ALL data, not just schema.",
      }, null, 2);
    } catch (err: any) {
      return this.errorJson(`Rollback failed: ${err.message}`);
    }
  }

  // === Resource RPC methods ===

  async getSchema(objectName: string): Promise<string> {
    if (!this.objectExists(objectName))
      return this.errorJson(`Object "${objectName}" does not exist`);

    const objRow = this.db.exec(
      "SELECT name, description FROM _objects WHERE name = ?", objectName
    ).one() as { name: string; description: string };

    const fields = this.db.exec(
      "SELECT name, type, required, default_value, references_object FROM _fields WHERE object_name = ? ORDER BY id",
      objectName
    ).toArray() as any[];

    return JSON.stringify({
      object: objRow.name,
      description: objRow.description,
      fields: fields.map((f: any) => {
        const field: any = {
          name: f.name,
          type: f.type,
          required: !!f.required,
          default: f.default_value != null ? JSON.parse(f.default_value) : null,
        };
        if (f.references_object) field.references = f.references_object;
        return field;
      }),
      kernel_columns: ["id", "version", "created_at", "updated_at", "archived_at"],
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
    if (!this.objectExists(objectName))
      return this.errorJson(`Object "${objectName}" does not exist`);

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
    const rows = this.db.exec("SELECT name FROM _objects ORDER BY name").toArray() as any[];
    return rows.map((r: any) => r.name);
  }

  // === Data operations ===

  async query(objectName: string, filterJson: string, fields: string, sortField: string, limit: number, countOnly: boolean): Promise<string> {
    if (!this.objectExists(objectName))
      return this.errorJson(`Object "${objectName}" does not exist`);

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

    const clampedLimit = Math.min(limit || 100, LIMITS.QUERY_ROWS);
    sql += ` LIMIT ${clampedLimit}`;

    try {
      const rows = this.db.exec(sql, ...bindings).toArray();
      return JSON.stringify({ object: objectName, records: rows, count: rows.length }, null, 2);
    } catch (err: any) {
      return this.errorJson(`Query failed: ${err.message}`);
    }
  }

  async mutate(objectName: string, operation: string, dataJson: string): Promise<string> {
    return JSON.stringify(this.executeMutate(objectName, operation, JSON.parse(dataJson)), null, 2);
  }

  async batchMutate(operationsJson: string): Promise<string> {
    const operations = JSON.parse(operationsJson) as { object: string; operation: string; data: any }[];

    if (operations.length > LIMITS.BATCH_OPS) {
      return this.errorJson(`Batch too large: ${operations.length} operations exceeds limit of ${LIMITS.BATCH_OPS}`);
    }

    // Validate all operations before starting transaction
    for (const op of operations) {
      if (!this.objectExists(op.object)) {
        return this.errorJson(`Object "${op.object}" does not exist`);
      }
      if (op.object === "_system_docs" && "default_content" in op.data) {
        return this.errorJson("default_content is immutable. It preserves the original seed for recovery.");
      }
    }

    const results: any[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const op of operations) {
        const result = this.executeMutate(op.object, op.operation, op.data);
        if (result.error) {
          throw new Error(result.message);
        }
        results.push(result);
      }
    });

    return JSON.stringify({ batch: true, results, count: results.length }, null, 2);
  }

  async consumeUpload(token: string, content: string): Promise<string> {
    // Look up the token
    const rows = this.db.exec(
      `SELECT * FROM "_upload_tokens" WHERE token = ? AND archived_at IS NULL`,
      token
    ).toArray() as any[];

    if (rows.length === 0) {
      return this.errorJson("Invalid or expired upload token");
    }

    const upload = rows[0];

    // Check expiry
    if (new Date(upload.expires_at) < new Date()) {
      return this.errorJson("Upload token has expired");
    }

    // Check single-use
    if (upload.consumed_at) {
      return this.errorJson("Upload token has already been used");
    }

    // Check content size
    const contentBytes = new TextEncoder().encode(content).length;
    if (contentBytes > LIMITS.RECORD_BYTES) {
      return this.errorJson(`Content too large: ${Math.round(contentBytes / 1024)}KB exceeds the 1MB limit`);
    }

    // Write content to target
    try {
      if (upload.mode === "append") {
        this.db.exec(
          `UPDATE "${upload.target_object}" SET "${upload.target_field}" = COALESCE("${upload.target_field}", '') || ?, updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL`,
          content, upload.target_id
        );
      } else {
        this.db.exec(
          `UPDATE "${upload.target_object}" SET "${upload.target_field}" = ?, updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL`,
          content, upload.target_id
        );
      }

      // Bump kernel version if applicable (not for user version fields like semver)
      if (this.hasKernelVersion(upload.target_object)) {
        try {
          this.db.exec(
            `UPDATE "${upload.target_object}" SET version = version + 1 WHERE id = ?`,
            upload.target_id
          );
        } catch {
          // No version column — fine
        }
      }
    } catch (err: any) {
      return this.errorJson(`Upload write failed: ${err.message}`);
    }

    // Mark token consumed
    this.db.exec(
      `UPDATE "_upload_tokens" SET consumed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      upload.id
    );

    // Return the updated record
    const record = this.db.exec(
      `SELECT * FROM "${upload.target_object}" WHERE id = ?`,
      upload.target_id
    ).one();

    return JSON.stringify({
      uploaded: true,
      bytes: contentBytes,
      target: { object: upload.target_object, id: upload.target_id, field: upload.target_field },
      mode: upload.mode,
      record,
    }, null, 2);
  }

  private executeMutate(objectName: string, operation: string, data: any): any {
    if (!this.objectExists(objectName))
      return { error: true, message: `Object "${objectName}" does not exist` };

    // Protect default_content on _system_docs
    if (objectName === "_system_docs" && "default_content" in data) {
      return { error: true, message: "default_content is immutable. It preserves the original seed for recovery." };
    }

    // Auth code create: auto-set expiry (default 1 hour, accepts ttl_minutes)
    if (objectName === "_auth_codes" && operation === "create") {
      const ttlMinutes = typeof data.ttl_minutes === "number" ? data.ttl_minutes : 60;
      data.expires_at = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
      delete data.ttl_minutes; // not a stored field
    }

    // Outputs create: validate required fields, set defaults
    if (objectName === "_outputs" && operation === "create") {
      if (!data.path) return { error: true, message: "path is required for _outputs" };
      data.mime_type = data.mime_type || "text/plain";
      data.visibility = data.visibility || "public";
    }

    // Inputs create: validate target_object exists, validate field_mapping JSON
    if (objectName === "_inputs" && operation === "create") {
      if (!data.path) return { error: true, message: "path is required for _inputs" };
      if (!data.target_object) return { error: true, message: "target_object is required for _inputs" };
      if (!this.objectExists(data.target_object)) {
        return { error: true, message: `Target object "${data.target_object}" does not exist` };
      }
      if (data.field_mapping && typeof data.field_mapping === "string") {
        try { JSON.parse(data.field_mapping); } catch {
          return { error: true, message: "field_mapping must be valid JSON" };
        }
      }
      if (data.body_field) {
        const fieldExists = this.db.exec(
          "SELECT 1 FROM _fields WHERE object_name = ? AND name = ?",
          data.target_object, data.body_field
        ).toArray().length > 0;
        if (!fieldExists) {
          return { error: true, message: `Field "${data.body_field}" does not exist on "${data.target_object}"` };
        }
      }
      data.visibility = data.visibility || "public";
    }

    // Record size guard (skip for upload tokens — they're small metadata)
    if (operation === "create" || operation === "update") {
      const size = estimateRecordBytes(data);
      if (size > LIMITS.RECORD_BYTES) {
        return { error: true, message: `Record too large: ~${Math.round(size / 1024)}KB exceeds the 1MB limit` };
      }
    }

    // Upload token create: validate target, set expiry
    if (objectName === "_upload_tokens" && operation === "create") {
      if (!data.target_object || data.target_id == null || !data.target_field) {
        return { error: true, message: "target_object, target_id, and target_field are required" };
      }
      if (!this.objectExists(data.target_object)) {
        return { error: true, message: `Target object "${data.target_object}" does not exist` };
      }
      // Verify the target record exists
      try {
        const row = this.db.exec(
          `SELECT id FROM "${data.target_object}" WHERE id = ? AND archived_at IS NULL`,
          data.target_id
        ).toArray();
        if (row.length === 0) {
          return { error: true, message: `Target record ${data.target_id} not found in "${data.target_object}"` };
        }
      } catch {
        return { error: true, message: `Could not verify target record` };
      }
      // Verify the target field exists
      const fieldRows = this.db.exec(
        "SELECT type FROM _fields WHERE object_name = ? AND name = ?",
        data.target_object, data.target_field
      ).toArray() as any[];
      if (fieldRows.length === 0) {
        return { error: true, message: `Field "${data.target_field}" does not exist on "${data.target_object}"` };
      }
      if (fieldRows[0].type !== "text") {
        return { error: true, message: `Upload target field must be text type, "${data.target_field}" is ${fieldRows[0].type}` };
      }
      // Auto-set expiry (15 minutes) and mode
      data.expires_at = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      data.mode = data.mode || "replace";
      if (!["replace", "append"].includes(data.mode)) {
        return { error: true, message: `Invalid mode "${data.mode}". Use "replace" or "append".` };
      }
      // Strip token if caller tried to set it — it's auto-generated
      delete data.token;
    }

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

          const row = this.db.exec(
            `SELECT * FROM "${objectName}" WHERE id = last_insert_rowid()`
          ).one();

          return { operation: "create", object: objectName, record: row };
        }

        case "update": {
          if (!data.id) return { error: true, message: "id is required for update" };
          const kernelVersion = this.hasKernelVersion(objectName);

          // For kernel version tables: strip version from SET (it auto-increments).
          // For user version tables: include version in SET like any other field.
          const stripCols = ["id", "created_at", "archived_at"];
          if (kernelVersion) stripCols.push("version");
          const fields = Object.keys(data).filter((k) => !stripCols.includes(k));
          if (fields.length === 0) return { error: true, message: "No fields to update" };

          const sets = fields.map((f) => `"${f}" = ?`).join(", ");
          const values = fields.map((f) => data[f]);

          if (kernelVersion) {
            // Kernel version: auto-increment + optional optimistic lock
            let where = `id = ? AND archived_at IS NULL`;
            values.push(data.id);
            if (data.version != null) {
              where += ` AND version = ?`;
              values.push(data.version);
            }

            this.db.exec(
              `UPDATE "${objectName}" SET ${sets}, version = version + 1, updated_at = datetime('now') WHERE ${where}`,
              ...values
            );

            if (data.version != null) {
              const changes = this.db.exec("SELECT changes() as c").one() as { c: number };
              if (changes.c === 0) {
                return { error: true, message: `Version conflict: record ${data.id} in "${objectName}" has been modified. Re-read and retry.` };
              }
            }
          } else {
            // No kernel version: simple update, version is a user field included in SET
            values.push(data.id);
            this.db.exec(
              `UPDATE "${objectName}" SET ${sets}, updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL`,
              ...values
            );
          }

          const row = this.db.exec(
            `SELECT * FROM "${objectName}" WHERE id = ?`,
            data.id
          ).one();

          return { operation: "update", object: objectName, record: row };
        }

        case "archive": {
          if (!data.id) return { error: true, message: "id is required for archive" };
          this.db.exec(
            `UPDATE "${objectName}" SET archived_at = datetime('now') WHERE id = ? AND archived_at IS NULL`,
            data.id
          );

          return { operation: "archive", object: objectName, id: data.id };
        }

        default:
          return { error: true, message: `Unknown operation: ${operation}. Use create, update, or archive.` };
      }
    } catch (err: any) {
      return { error: true, message: `Mutate failed: ${err.message}` };
    }
  }

  // === URI resolution ===

  async resolve(input: string): Promise<string> {
    const match = input.match(new RegExp(`^${URI_SCHEME}://(.+)$`));
    if (!match) return this.errorJson(`Invalid URI scheme. Expected ${URI_PREFIX} URI, got: ${input}`);

    const path = match[1];

    if (path === "index") {
      return this.getIndex();
    }

    if (path === "history" || path.startsWith("history?")) {
      const params = new URLSearchParams(path.split("?")[1] || "");
      const limit = Number(params.get("limit")) || 20;
      return this.getHistory(limit);
    }

    const schemaMatch = path.match(/^schema\/(.+)$/);
    if (schemaMatch) {
      return this.getSchema(schemaMatch[1]);
    }

    const recordMatch = path.match(/^records\/([^/]+)\/(.+)$/);
    if (recordMatch) {
      return this.getRecord(recordMatch[1], Number(recordMatch[2]));
    }

    if (path === "_system/" || path === "_system") {
      return this.getSystemDocList();
    }

    const sysMatch = path.match(/^_system\/([^/]+?)(\/default)?$/);
    if (sysMatch) {
      return this.getSystemDoc(sysMatch[1], !!sysMatch[2]);
    }

    // mutations or mutations/{object}?limit=N
    if (path === "mutations" || path.startsWith("mutations")) {
      const parts = path.split("?");
      const pathPart = parts[0];
      const params = new URLSearchParams(parts[1] || "");
      const limit = Number(params.get("limit")) || 50;
      const tableName = pathPart === "mutations" ? null : pathPart.replace("mutations/", "");
      return this.getMutationLog(tableName, limit);
    }

    return this.errorJson(`Unknown URI: ${input}. Valid patterns: ${uri("index")}, ${uri("schema/{object}")}, ${uri("records/{object}/{id}")}, ${uri("history")}, ${uri("_system/{slug}")}, ${uri("mutations[/{object}]")}`);
  }

  // === Cross-object search ===

  async search(term: string, objectsJson: string, limit_: number): Promise<string> {
    const limit = Math.min(limit_ || 20, LIMITS.QUERY_ROWS);
    const targetObjects = objectsJson
      ? JSON.parse(objectsJson) as string[]
      : (this.db.exec("SELECT name FROM _objects ORDER BY name").toArray() as any[]).map((r: any) => r.name);

    const results: { object: string; record: any; matched_fields: string[] }[] = [];

    for (const objName of targetObjects) {
      if (!this.objectExists(objName)) continue;

      // Get text fields from normalized schema
      const textFields = (this.db.exec(
        "SELECT name FROM _fields WHERE object_name = ? AND type = 'text' ORDER BY id",
        objName
      ).toArray() as any[]).map((r: any) => r.name as string);
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

  // === Mutation log ===

  private getMutationLog(tableName: string | null, limit: number): string {
    let sql = "SELECT * FROM _mutation_log";
    const bindings: any[] = [];
    if (tableName) {
      sql += " WHERE table_name = ?";
      bindings.push(tableName);
    }
    sql += " ORDER BY id DESC LIMIT ?";
    bindings.push(limit);

    const rows = this.db.exec(sql, ...bindings).toArray();
    return JSON.stringify({ mutations: rows, count: rows.length }, null, 2);
  }

  // === System docs ===

  private getSystemDocList(): string {
    const rows = this.db.exec(
      `SELECT slug, title FROM "_system_docs" ORDER BY slug`
    ).toArray() as { slug: string; title: string }[];
    return JSON.stringify({
      docs: rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        uri: uri(`_system/${r.slug}`),
      })),
    }, null, 2);
  }

  private getSystemDoc(slug: string, returnDefault: boolean): string {
    const rows = this.db.exec(
      `SELECT * FROM "_system_docs" WHERE slug = ?`,
      slug
    ).toArray() as any[];
    if (rows.length === 0) return this.errorJson(`No system doc with slug: ${slug}`);
    const doc = rows[0];
    const content = returnDefault ? doc.default_content : (doc.content ?? doc.default_content);
    return JSON.stringify({
      slug: doc.slug,
      title: doc.title,
      content,
      is_default: doc.content === null || doc.content === doc.default_content,
      uri: uri(`_system/${doc.slug}`),
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
    const hasPlugins = this.objectExists("_plugins");
    const hasSkills = this.objectExists("_skills");

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

  private getCurrentIndex(): StoreIndex {
    const meta = this.db.exec("SELECT * FROM _meta WHERE id = 1").one() as any;
    const objects = this.db.exec("SELECT name, description FROM _objects ORDER BY name").toArray() as any[];
    const allFields = this.db.exec("SELECT * FROM _fields ORDER BY object_name, id").toArray() as any[];
    const conventions = this.db.exec("SELECT text FROM _conventions ORDER BY id").toArray() as any[];

    // Group fields by object
    const fieldsByObject = new Map<string, IndexFieldEntry[]>();
    for (const f of allFields) {
      if (!fieldsByObject.has(f.object_name)) fieldsByObject.set(f.object_name, []);
      const field: IndexFieldEntry = {
        name: f.name,
        type: f.type,
        required: !!f.required,
        default: f.default_value != null ? JSON.parse(f.default_value) : null,
      };
      if (f.references_object) field.references = f.references_object;
      fieldsByObject.get(f.object_name)!.push(field);
    }

    return {
      version: meta.version,
      updated_at: meta.updated_at,
      objects: objects.map((o: any) => ({
        name: o.name,
        description: o.description,
        fields: fieldsByObject.get(o.name) || [],
        record_count: 0,
      })),
      conventions: conventions.map((c: any) => c.text),
      guidance: meta.guidance,
    };
  }

  private ensureAuditTriggers(tableName: string) {
    // Get columns for this table from sqlite_master (works for any table)
    let columns: string[];
    try {
      const info = this.db.exec(`PRAGMA table_info("${tableName}")`).toArray() as any[];
      columns = info.map((c: any) => c.name as string);
    } catch {
      return; // Table doesn't exist yet
    }
    if (columns.length === 0) return;

    const newJson = columns.map((c) => `'${c}', NEW."${c}"`).join(", ");
    const oldJson = columns.map((c) => `'${c}', OLD."${c}"`).join(", ");

    this.db.exec(`CREATE TRIGGER IF NOT EXISTS "_audit_${tableName}_insert"
      AFTER INSERT ON "${tableName}" BEGIN
        INSERT INTO _mutation_log (table_name, record_id, operation, new_data)
        VALUES ('${tableName}', NEW.id, 'INSERT', json_object(${newJson}));
      END`);

    this.db.exec(`CREATE TRIGGER IF NOT EXISTS "_audit_${tableName}_update"
      AFTER UPDATE ON "${tableName}" BEGIN
        INSERT INTO _mutation_log (table_name, record_id, operation, old_data, new_data)
        VALUES ('${tableName}', NEW.id, 'UPDATE', json_object(${oldJson}), json_object(${newJson}));
      END`);

    this.db.exec(`CREATE TRIGGER IF NOT EXISTS "_audit_${tableName}_delete"
      AFTER DELETE ON "${tableName}" BEGIN
        INSERT INTO _mutation_log (table_name, record_id, operation, old_data)
        VALUES ('${tableName}', OLD.id, 'DELETE', json_object(${oldJson}));
      END`);
  }

  private objectExists(name: string): boolean {
    return this.db.exec(
      "SELECT 1 FROM _objects WHERE name = ?", name
    ).toArray().length > 0;
  }

  /** True if the table's `version` column is the kernel auto-increment, not a user field. */
  private hasKernelVersion(objectName: string): boolean {
    // If _fields has a user-defined 'version' field for this object,
    // the column is user-managed (e.g. semver text). Otherwise it's kernel.
    return this.db.exec(
      "SELECT 1 FROM _fields WHERE object_name = ? AND name = 'version'",
      objectName
    ).toArray().length === 0;
  }

  // === Passkey storage ===

  async hasPasskey(): Promise<boolean> {
    return this.db.exec("SELECT 1 FROM _passkeys WHERE id = 1").toArray().length > 0;
  }

  async getPasskey(): Promise<{ credential_id: string; public_key: string; counter: number; transports: string } | null> {
    const rows = this.db.exec("SELECT * FROM _passkeys WHERE id = 1").toArray() as any[];
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      credential_id: r.credential_id,
      public_key: r.public_key,
      counter: r.counter,
      transports: r.transports,
    };
  }

  async storePasskey(credentialId: string, publicKey: string, counter: number, transports: string): Promise<void> {
    this.db.exec("DELETE FROM _passkeys");
    this.db.exec(
      "INSERT INTO _passkeys (id, credential_id, public_key, counter, transports) VALUES (1, ?, ?, ?, ?)",
      credentialId, publicKey, counter, transports
    );
  }

  async updatePasskeyCounter(counter: number): Promise<void> {
    this.db.exec("UPDATE _passkeys SET counter = ? WHERE id = 1", counter);
  }

  // === Auth codes ===

  /** Check and consume a code (for browser auth — single use). */
  async consumeAuthCode(code: string): Promise<boolean> {
    const rows = this.db.exec(
      `SELECT * FROM "_auth_codes" WHERE code = ? AND archived_at IS NULL AND consumed_at IS NULL`,
      code
    ).toArray() as any[];
    if (rows.length === 0) return false;
    const row = rows[0];
    if (new Date(row.expires_at) < new Date()) return false;
    this.db.exec(
      `UPDATE "_auth_codes" SET consumed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      row.id
    );
    return true;
  }

  /** Validate a code without consuming it (for bearer token sessions). */
  async validateAuthCode(code: string): Promise<boolean> {
    const rows = this.db.exec(
      `SELECT * FROM "_auth_codes" WHERE code = ? AND archived_at IS NULL AND consumed_at IS NULL`,
      code
    ).toArray() as any[];
    if (rows.length === 0) return false;
    return new Date(rows[0].expires_at) >= new Date();
  }

  // === HTTP I/O ===

  async resolveOutput(path: string): Promise<string> {
    try {
      const rows = this.db.exec(
        `SELECT content, mime_type, visibility, updated_at FROM "_outputs" WHERE path = ? AND archived_at IS NULL`,
        path
      ).toArray() as any[];
      if (rows.length === 0) return JSON.stringify({ found: false });
      return JSON.stringify({ found: true, ...rows[0] });
    } catch {
      return JSON.stringify({ found: false });
    }
  }

  async getInputVisibility(path: string): Promise<string> {
    try {
      const rows = this.db.exec(
        `SELECT visibility FROM "_inputs" WHERE path = ? AND archived_at IS NULL`,
        path
      ).toArray() as any[];
      if (rows.length === 0) return JSON.stringify({ found: false });
      return JSON.stringify({ found: true, visibility: rows[0].visibility });
    } catch {
      return JSON.stringify({ found: false });
    }
  }

  async processInput(path: string, body: string, headersJson: string, queryJson: string): Promise<string> {
    const rows = this.db.exec(
      `SELECT * FROM "_inputs" WHERE path = ? AND archived_at IS NULL`,
      path
    ).toArray() as any[];
    if (rows.length === 0) return this.errorJson("No input endpoint for this path");

    const input = rows[0];
    let data: Record<string, unknown>;

    if (input.field_mapping) {
      const mapping = JSON.parse(input.field_mapping) as Record<string, string>;
      let parsedBody: unknown = null;
      try { parsedBody = JSON.parse(body); } catch { /* not JSON */ }

      data = evaluateMapping(mapping, {
        body: parsedBody,
        rawBody: body,
        headers: JSON.parse(headersJson),
        query: JSON.parse(queryJson),
      });
    } else if (input.body_field) {
      data = { [input.body_field]: body };
    } else {
      data = { body };
    }

    const result = this.executeMutate(input.target_object, "create", data);
    return JSON.stringify(result, null, 2);
  }

  private errorJson(message: string): string {
    return JSON.stringify({ error: true, message });
  }
}
