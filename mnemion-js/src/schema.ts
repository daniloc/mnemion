// Database initialization
//
// Table definitions, migrations, kernel pattern registration, and system doc seeding.
// Called once per HiveDO construction via blockConcurrencyWhile.
//
// Kernel tables are defined declaratively: DDL + description + facets co-located.
// Internal tables (not exposed to agents) are plain DDL.

import { PRODUCT_NAME, URI_SCHEME, URI_PREFIX, uri } from "./constants";

// System docs — imported as raw text, placeholders resolved at load time
import toolsRaw from "./system-docs/tools.md";
import schemaEvolutionRaw from "./system-docs/schema-evolution.md";
import skillsRaw from "./system-docs/skills.md";
import conventionsRaw from "./system-docs/conventions.md";
import indexGuideRaw from "./system-docs/index-guide.md";
import remoteAccessRaw from "./system-docs/remote-access.md";
import httpIoRaw from "./system-docs/http-io.md";

// === System doc parsing ===

function resolveDocPlaceholders(raw: string): string {
  return raw
    .replace(/\{\{PRODUCT_NAME\}\}/g, PRODUCT_NAME)
    .replace(/\{\{URI_SCHEME\}\}/g, URI_SCHEME)
    .replace(/\{\{URI_PREFIX\}\}/g, URI_PREFIX)
    .replace(/\{\{uri:(.*?)\}\}/g, (_, path) => uri(path));
}

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

// === Kernel table declarations ===
//
// Each agent-facing kernel table is one declaration: DDL, description, and
// facet metadata together. The full kernel surface is visible by scanning
// this array.

interface KernelFacet { name: string; type: string; required: boolean }

interface KernelTable {
  name: string;
  description: string;
  ddl: string;
  indexes?: string[];
  facets: KernelFacet[];
}

const KERNEL_TABLES: KernelTable[] = [
  {
    name: "_auth_codes",
    description: "One-time auth codes for remote agents. Code and expiry auto-generated on create. Single-use — consumed when used to authenticate.",
    ddl: `CREATE TABLE IF NOT EXISTS "_auth_codes" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "code" TEXT NOT NULL UNIQUE DEFAULT (hex(randomblob(16))),
      "label" TEXT,
      "expires_at" TEXT NOT NULL,
      "consumed_at" TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT
    )`,
    facets: [
      { name: "code", type: "text", required: false },
      { name: "label", type: "text", required: false },
      { name: "expires_at", type: "datetime", required: false },
      { name: "consumed_at", type: "datetime", required: false },
    ],
  },
  {
    name: "_upload_tokens",
    description: "Temporary capability tokens for large content uploads via HTTP POST. Token and expiry auto-generated on create. Single-use.",
    ddl: `CREATE TABLE IF NOT EXISTS "_upload_tokens" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "token" TEXT NOT NULL UNIQUE DEFAULT (hex(randomblob(16))),
      "target_pattern" TEXT NOT NULL,
      "target_id" INTEGER NOT NULL,
      "target_facet" TEXT NOT NULL,
      "mode" TEXT NOT NULL DEFAULT 'replace',
      "expires_at" TEXT NOT NULL,
      "consumed_at" TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT
    )`,
    facets: [
      { name: "token", type: "text", required: false },
      { name: "target_pattern", type: "text", required: true },
      { name: "target_id", type: "integer", required: true },
      { name: "target_facet", type: "text", required: true },
      { name: "mode", type: "text", required: false },
      { name: "expires_at", type: "datetime", required: false },
      { name: "consumed_at", type: "datetime", required: false },
    ],
  },
  {
    name: "_marketplace_tokens",
    description: "Scoped access tokens for private marketplace delivery. Token auto-generated on create.",
    ddl: `CREATE TABLE IF NOT EXISTS "_marketplace_tokens" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL,
      "token" TEXT NOT NULL UNIQUE DEFAULT (hex(randomblob(16))),
      "scope" TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT
    )`,
    facets: [
      { name: "name", type: "text", required: true },
      { name: "token", type: "text", required: false },
      { name: "scope", type: "text", required: false },
    ],
  },
  {
    name: "_outputs",
    description: "HTTP egress endpoints. Each entry serves content at GET /o/{path}. Public by default.",
    ddl: `CREATE TABLE IF NOT EXISTS "_outputs" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "path" TEXT NOT NULL,
      "content" TEXT NOT NULL,
      "mime_type" TEXT NOT NULL DEFAULT 'text/plain',
      "visibility" TEXT NOT NULL DEFAULT 'public',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT,
      version INTEGER NOT NULL DEFAULT 0
    )`,
    indexes: [
      `CREATE UNIQUE INDEX IF NOT EXISTS "_outputs_path_active" ON "_outputs" ("path") WHERE archived_at IS NULL`,
    ],
    facets: [
      { name: "path", type: "text", required: true },
      { name: "content", type: "text", required: true },
      { name: "mime_type", type: "text", required: false },
      { name: "visibility", type: "text", required: false },
    ],
  },
  {
    name: "_inputs",
    description: "HTTP ingress endpoints. Each entry accepts POST /i/{path} and creates entries in target_pattern. Supports facet_mapping DSL for JSON body transformation.",
    ddl: `CREATE TABLE IF NOT EXISTS "_inputs" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "path" TEXT NOT NULL,
      "target_pattern" TEXT NOT NULL,
      "body_facet" TEXT,
      "facet_mapping" TEXT,
      "visibility" TEXT NOT NULL DEFAULT 'public',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT,
      version INTEGER NOT NULL DEFAULT 0
    )`,
    indexes: [
      `CREATE UNIQUE INDEX IF NOT EXISTS "_inputs_path_active" ON "_inputs" ("path") WHERE archived_at IS NULL`,
    ],
    facets: [
      { name: "path", type: "text", required: true },
      { name: "target_pattern", type: "text", required: true },
      { name: "body_facet", type: "text", required: false },
      { name: "facet_mapping", type: "text", required: false },
      { name: "visibility", type: "text", required: false },
    ],
  },
  {
    name: "_system_docs",
    description: "System documentation for agent orientation. Editable but requires confirmation. Set content to null to restore defaults.",
    ddl: `CREATE TABLE IF NOT EXISTS "_system_docs" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "slug" TEXT NOT NULL UNIQUE,
      "title" TEXT NOT NULL,
      "content" TEXT,
      "default_content" TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    facets: [
      { name: "slug", type: "text", required: true },
      { name: "title", type: "text", required: true },
      { name: "content", type: "text", required: false },
      { name: "default_content", type: "text", required: true },
    ],
  },
];

// === Initialization ===

export function initializeSchema(db: any): void {
  // --- Core schema tables ---

  db.exec(`CREATE TABLE IF NOT EXISTS _objects (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT ''
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS _fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    object_name TEXT NOT NULL REFERENCES _objects(name),
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    required INTEGER NOT NULL DEFAULT 0,
    default_value TEXT,
    references_object TEXT,
    UNIQUE(object_name, name)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS _conventions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS _meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 0,
    guidance TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const metaRows = db.exec("SELECT id FROM _meta WHERE id = 1").toArray();
  if (metaRows.length === 0) {
    db.exec(
      "INSERT INTO _meta (id, version, guidance) VALUES (1, 0, ?)",
      `This is a new ${PRODUCT_NAME} instance. No objects exist yet. Create what the work demands.`
    );
  }

  // --- Internal tables (not exposed to agents) ---

  db.exec(`CREATE TABLE IF NOT EXISTS _schema_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT NOT NULL,
    change_type TEXT NOT NULL,
    change_detail TEXT NOT NULL,
    bookmark TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS _pending_changes (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    change_spec TEXT NOT NULL,
    preview_index TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS _passkeys (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    credential_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS _mutation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id INTEGER,
    operation TEXT NOT NULL,
    old_data TEXT,
    new_data TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // --- Kernel tables (DDL + indexes from declarations) ---

  for (const table of KERNEL_TABLES) {
    db.exec(table.ddl);
    if (table.indexes) {
      for (const idx of table.indexes) db.exec(idx);
    }
  }

  // --- System doc seeding ---

  for (const doc of SYSTEM_DOCS_SEED) {
    const existing = db.exec(
      `SELECT id, default_content FROM "_system_docs" WHERE slug = ?`, doc.slug
    ).toArray() as any[];
    if (existing.length === 0) {
      db.exec(
        `INSERT INTO "_system_docs" (slug, title, content, default_content) VALUES (?, ?, ?, ?)`,
        doc.slug, doc.title, doc.content, doc.content
      );
    } else if (existing[0].default_content !== doc.content) {
      const wasDefault = existing[0].default_content === (db.exec(
        `SELECT content FROM "_system_docs" WHERE id = ?`, existing[0].id
      ).one() as any)?.content;
      db.exec(
        `UPDATE "_system_docs" SET default_content = ?, title = ?${wasDefault ? ', content = ?' : ''}, updated_at = datetime('now') WHERE id = ?`,
        ...(wasDefault
          ? [doc.content, doc.title, doc.content, existing[0].id]
          : [doc.content, doc.title, existing[0].id])
      );
    }
  }

  // --- Register kernel objects in normalized schema ---

  for (const table of KERNEL_TABLES) {
    db.exec(
      "INSERT OR IGNORE INTO _objects (name, description) VALUES (?, ?)",
      table.name, table.description
    );
    for (const f of table.facets) {
      db.exec(
        "INSERT OR IGNORE INTO _fields (object_name, name, type, required) VALUES (?, ?, ?, ?)",
        table.name, f.name, f.type, f.required ? 1 : 0
      );
    }
  }

  // --- Audit triggers for all registered objects ---

  const allObjects = db.exec("SELECT name FROM _objects").toArray() as any[];
  for (const obj of allObjects) {
    ensureAuditTriggers(db, obj.name);
  }
}

// === Audit triggers ===

export function ensureAuditTriggers(db: any, tableName: string): void {
  let columns: string[];
  try {
    const info = db.exec(`PRAGMA table_info("${tableName}")`).toArray() as any[];
    columns = info.map((c: any) => c.name as string);
  } catch {
    return;
  }
  if (columns.length === 0) return;

  const newJson = columns.map((c) => `'${c}', NEW."${c}"`).join(", ");
  const oldJson = columns.map((c) => `'${c}', OLD."${c}"`).join(", ");

  db.exec(`CREATE TRIGGER IF NOT EXISTS "_audit_${tableName}_insert"
    AFTER INSERT ON "${tableName}" BEGIN
      INSERT INTO _mutation_log (table_name, record_id, operation, new_data)
      VALUES ('${tableName}', NEW.id, 'INSERT', json_object(${newJson}));
    END`);

  db.exec(`CREATE TRIGGER IF NOT EXISTS "_audit_${tableName}_update"
    AFTER UPDATE ON "${tableName}" BEGIN
      INSERT INTO _mutation_log (table_name, record_id, operation, old_data, new_data)
      VALUES ('${tableName}', NEW.id, 'UPDATE', json_object(${oldJson}), json_object(${newJson}));
    END`);

  db.exec(`CREATE TRIGGER IF NOT EXISTS "_audit_${tableName}_delete"
    AFTER DELETE ON "${tableName}" BEGIN
      INSERT INTO _mutation_log (table_name, record_id, operation, old_data)
      VALUES ('${tableName}', OLD.id, 'DELETE', json_object(${oldJson}));
    END`);
}
