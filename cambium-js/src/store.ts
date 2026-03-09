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

// === System docs seed content ===

const SYSTEM_DOCS_SEED: { slug: string; title: string; content: string }[] = [
  {
    slug: "tools",
    title: "Tool Strategy",
    content: `# Tool Strategy

Cambium has six tools. They never grow — new capabilities come from schema and records, not new tools.

## resolve
Read anything by \`cambium://\` URI. The URI scheme is the API.
- \`cambium://index\` — master index. Read this first.
- \`cambium://schema/{object}\` — field definitions for an object
- \`cambium://records/{object}/{id}\` — a single record
- \`cambium://history\` — recent schema changes (supports \`?limit=N\`)
- \`cambium://_system/{slug}\` — system documentation (you're reading one now)
- \`cambium://_system/\` — list all system docs

## query
Filtered, sorted, paginated reads from a single object.
- \`filter\`: array of expressions like \`status=active\`, \`priority>3\`, \`title~keyword\`
- \`fields\`: comma-separated projection (default: all)
- \`sort\`: field name, prefix \`-\` for descending (e.g. \`-updated_at\`)
- \`count_only\`: return count without records — use this before large queries

## search
Cross-object full-text search across all text fields. Use when you don't know which object holds what you need.

## mutate
Create, update, or archive records. One tool for all writes.
- \`create\`: provide field values, kernel columns (id, timestamps) are auto-set
- \`update\`: provide \`id\` + fields to change
- \`archive\`: provide \`id\` only — soft-deletes, never destroys data

## propose_change / apply_change
Two-step schema evolution. Propose validates and previews. Apply commits.
- \`create_object\`: new object with fields
- \`add_field\`: add fields to an existing object
- \`add_convention\`: add a convention to the index

Schema changes are permanent and logged in \`cambium://history\`. Propose first, review the preview, then apply.

## When to use what
- Know exactly what you want → \`resolve\` with a URI
- Need filtered/sorted data → \`query\`
- Exploring, don't know where something is → \`search\`
- Writing data → \`mutate\`
- Changing structure → \`propose_change\` then \`apply_change\`
`,
  },
  {
    slug: "schema-evolution",
    title: "Schema Evolution",
    content: `# Schema Evolution

Objects are created through \`propose_change\` / \`apply_change\`. This is a two-step process: propose validates and returns a preview; apply commits the change to SQLite and the index.

## Naming conventions
- Object names: kebab-case (e.g. \`research-threads\`, \`daily-notes\`)
- Field names: snake_case (e.g. \`due_date\`, \`source_url\`)
- Objects starting with \`_\` are kernel/system objects (e.g. \`_plugins\`, \`_skills\`, \`_system_docs\`)

## Field types
\`text\`, \`number\`, \`integer\`, \`boolean\`, \`datetime\`

## Kernel columns (auto-provided, never define these)
\`id\`, \`created_at\`, \`updated_at\`, \`archived_at\`

Every object gets these automatically. Do not include them in \`propose_change\` field lists.

## When to create a new object vs. add fields
- New object: the data represents a distinct concept with its own lifecycle
- Add field: the data extends an existing concept (e.g. adding \`priority\` to \`tasks\`)

## When to evolve schema
- When the work demands a new shape. Don't pre-create objects speculatively.
- When existing fields can't represent what's needed. Add fields rather than overloading existing ones.
- When the human says "track X" or "I need to remember Y" — that's a schema evolution signal.

## Archiving vs. deletion
Cambium never deletes. \`archive\` sets \`archived_at\`, excluding the record from queries. The data persists for history and recovery.
`,
  },
  {
    slug: "skills",
    title: "Skills & Marketplace",
    content: `# Skills & Marketplace Distribution

Cambium can serve itself as a Claude Code plugin marketplace. Skills are records authored through \`mutate\`, served as a synthesized git repo on every request.

## Schema objects

Two objects support the skill system. Create them via \`propose_change\` / \`apply_change\` when first needed:

### \`_plugins\`
Each record is a plugin — a named package of skills and configuration.
- \`name\` (text, required) — kebab-case identifier
- \`description\` (text, required)
- \`version\` (text, required) — semver, bump on skill changes
- \`visibility\` (text, required) — "public" or "private"
- \`author\` (text) — optional
- \`claude_md\` (text) — CLAUDE.md content injected when plugin is active
- \`settings_json\` (text) — settings.json content
- \`mcp_json\` (text) — .mcp.json for MCP server definitions

### \`_skills\`
Each record is a skill within a plugin.
- \`plugin_id\` (integer, required) — references \`_plugins.id\`
- \`name\` (text, required) — kebab-case
- \`description\` (text) — triggers and purpose
- \`argument_hint\` (text) — e.g. "[topic or question]"
- \`skill_md\` (text, required) — full SKILL.md body after frontmatter
- \`visibility\` (text, required) — "public" or "private"

## Creating a skill workflow
1. Ensure \`_plugins\` and \`_skills\` objects exist (one-time setup)
2. \`mutate(_plugins, create, {...})\` — create the plugin
3. \`mutate(_skills, create, {...})\` — create skills within it
4. Human installs: \`/plugin marketplace add <url>\`

## Marketplace endpoints
- \`/marketplace/\` — private, token-authenticated, serves all visibility levels
- \`/marketplace/public/\` — unauthenticated, serves only public plugins/skills

## Scoped tokens
Create via \`mutate(_marketplace_tokens, create, {name, scope})\`.
- \`scope\`: JSON array of plugin names (null = all plugins)
- \`token\`: auto-generated, returned in response
- Install URL: \`https://cambium:<token>@<host>/marketplace.git\`

## Visibility rules
- Private skills: only on authenticated marketplace
- Public plugins: appear on public marketplace ONLY if ALL skills are public
- Default to \`private\`. Only mark \`public\` when explicitly sharing.

## Updating skills
Mutate the skill record. Bump the plugin version. Claude Code detects the version change on next startup.
Note: Users may need to restart Claude Code for skill changes to take effect.
`,
  },
  {
    slug: "conventions",
    title: "Conventions",
    content: `# Conventions

## URI scheme
All Cambium data is addressable via \`cambium://\` URIs:
- \`cambium://index\` — the master index
- \`cambium://schema/{object}\` — object field definitions
- \`cambium://records/{object}/{id}\` — individual record
- \`cambium://history\` — schema change log
- \`cambium://_system/{slug}\` — system documentation

## The index
The index is the single source of truth for what exists. Read it first in any new session. It contains:
- All objects with descriptions and field lists
- Active record counts
- Conventions established for this instance
- Guidance text

## Visibility model
Records can be \`public\` or \`private\`. This controls marketplace distribution:
- Private: only accessible via authenticated marketplace
- Public: accessible to anyone via public marketplace

## Archiving
\`archive\` is the only destructive operation, and it's soft — sets \`archived_at\` timestamp. Archived records are excluded from queries but never deleted. Recovery is always possible.

## Kernel objects
Objects prefixed with \`_\` are system objects managed by the kernel:
- \`_marketplace_tokens\` — scoped access tokens
- \`_plugins\`, \`_skills\` — marketplace content (created on demand)
- \`_system_docs\` — these documents

Kernel objects follow the same query/mutate interface as user objects.

## System docs
System docs (like this one) are editable via \`mutate\`. Each has a \`default_content\` field preserving the original seed. To restore a doc, set \`content\` to null — resolve will fall back to \`default_content\`.

Edits to \`_system_docs\` require confirmation because they affect all future agent sessions.
`,
  },
  {
    slug: "index-guide",
    title: "Reading the Index",
    content: `# Reading the Index

\`cambium://index\` is your starting point every session. Here's how to interpret it.

## Structure
\`\`\`json
{
  "version": 5,
  "updated_at": "2025-...",
  "objects": [...],
  "conventions": [...],
  "guidance": "..."
}
\`\`\`

## Objects array
Each entry describes an object:
- \`name\`: the object identifier (used in queries and URIs)
- \`description\`: what this object holds and why
- \`fields\`: array of {name, type, required, default} — the object's schema
- \`record_count\`: current active (non-archived) records

Use \`record_count\` to gauge activity. Zero-count objects may be unused or newly created.

## Conventions
Text entries the human or agent has established:
- Naming patterns
- Workflow rules
- Domain-specific guidance

Conventions are added via \`propose_change\` with type \`add_convention\`.

## Guidance
Free-text orientation. On a fresh instance: "No objects exist yet." After schema creation: "Cambium is active."

The guidance evolves as the instance grows. It's a one-liner for fast orientation.

## What to do after reading the index
1. Scan objects and record counts for orientation
2. If you need details on an object's fields, resolve \`cambium://schema/{name}\`
3. Query objects with recent activity (\`sort=-updated_at\`, \`limit=5\`)
4. Check conventions for any rules to follow
`,
  },
];


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

    // System docs (kernel table — always exists)
    this.db.exec(`CREATE TABLE IF NOT EXISTS "_system_docs" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "slug" TEXT NOT NULL UNIQUE,
      "title" TEXT NOT NULL,
      "content" TEXT,
      "default_content" TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    // Seed system docs if empty
    const docCount = this.db.exec(
      `SELECT COUNT(*) as count FROM "_system_docs"`
    ).one() as { count: number };
    if (docCount.count === 0) {
      for (const doc of SYSTEM_DOCS_SEED) {
        this.db.exec(
          `INSERT INTO "_system_docs" (slug, title, content, default_content) VALUES (?, ?, ?, ?)`,
          doc.slug, doc.title, doc.content, doc.content
        );
      }
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

    // Ensure _system_docs is registered in the index
    if (!index.objects.some((o) => o.name === "_system_docs")) {
      index.objects.push({
        name: "_system_docs",
        description: "System documentation for agent orientation. Editable but requires confirmation. Set content to null to restore defaults.",
        fields: [
          { name: "slug", type: "text", required: true },
          { name: "title", type: "text", required: true },
          { name: "content", type: "text", required: false },
          { name: "default_content", type: "text", required: true },
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
        // Table may lack archived_at (kernel tables like _system_docs) — count all rows
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

    // Attach system docs pointer
    const enriched = {
      ...index,
      system_docs: "cambium://_system/",
    };

    return JSON.stringify(enriched, null, 2);
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

    // Protect default_content on _system_docs
    if (objectName === "_system_docs" && "default_content" in data) {
      return this.errorJson("default_content is immutable. It preserves the original seed for recovery.");
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

    // cambium://_system/ — list all system docs
    if (path === "_system/" || path === "_system") {
      return this.getSystemDocList();
    }

    // cambium://_system/{slug} or cambium://_system/{slug}/default
    const sysMatch = path.match(/^_system\/([^/]+?)(\/default)?$/);
    if (sysMatch) {
      return this.getSystemDoc(sysMatch[1], !!sysMatch[2]);
    }

    return this.errorJson(`Unknown URI: ${uri}. Valid patterns: cambium://index, cambium://schema/{object}, cambium://records/{object}/{id}, cambium://history, cambium://_system/{slug}`);
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

  // === System docs ===

  private getSystemDocList(): string {
    const rows = this.db.exec(
      `SELECT slug, title FROM "_system_docs" ORDER BY slug`
    ).toArray() as { slug: string; title: string }[];
    return JSON.stringify({
      docs: rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        uri: `cambium://_system/${r.slug}`,
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
      uri: `cambium://_system/${doc.slug}`,
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
