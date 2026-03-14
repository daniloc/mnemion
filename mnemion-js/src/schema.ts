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

interface KernelFacet { name: string; type: string; required: boolean; options?: string[] }

interface KernelTable {
  name: string;
  description: string;
  doctrine: string;
  ddl: string;
  indexes?: string[];
  facets: KernelFacet[];
}

const KERNEL_TABLES: KernelTable[] = [
  {
    name: "_access_tokens",
    description: `Unified access tokens. Token auto-generated on create. Scope controls what the token can do — hierarchical prefix matching (e.g. "read" matches "read:entry:axioms:7"). Constraints holds scope-specific JSON (e.g. upload target). Single-use tokens are consumed on first use.

Scopes:
- * — full access (OAuth, session login, all reads/writes)
- read — read any shared entry or output
- read:entry:{pattern} — read shared entries in a pattern
- read:entry:{pattern}:{id} — read a specific shared entry
- read:output:{path} — read a specific output
- upload — write via POST /upload/{token} (constraints: {target_pattern, target_id, target_facet, mode})
- marketplace — private marketplace git access (constraints: {plugins: [...]})`,
    doctrine: "Create tokens only when the human requests external access. Use the narrowest scope possible. Never create wildcard tokens without explicit instruction.",
    ddl: `CREATE TABLE IF NOT EXISTS "_access_tokens" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "token" TEXT NOT NULL UNIQUE DEFAULT (hex(randomblob(16))),
      "label" TEXT,
      "scope" TEXT NOT NULL DEFAULT '*',
      "constraints" TEXT,
      "expires_at" TEXT,
      "single_use" INTEGER NOT NULL DEFAULT 0,
      "consumed_at" TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT,
      version INTEGER NOT NULL DEFAULT 0
    )`,
    facets: [
      { name: "token", type: "text", required: false },
      { name: "label", type: "text", required: false },
      { name: "scope", type: "text", required: false },
      { name: "constraints", type: "text", required: false },
      { name: "expires_at", type: "datetime", required: false },
      { name: "single_use", type: "boolean", required: false },
      { name: "consumed_at", type: "datetime", required: false },
    ],
  },
  {
    name: "_shared",
    description: "Entry-level sharing. Links an entry to a visibility mode for HTTP access at /o/entry/{pattern}/{id}. Public entries are openly readable; unlisted entries require a valid auth code token (anyone-with-the-link access).",
    doctrine: "Only share entries the human explicitly asks to make accessible. Default to unlisted over public. Archive sharing when access is no longer needed.",
    ddl: `CREATE TABLE IF NOT EXISTS "_shared" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "source_pattern" TEXT NOT NULL,
      "source_id" INTEGER NOT NULL,
      "visibility" TEXT NOT NULL DEFAULT 'public',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT,
      version INTEGER NOT NULL DEFAULT 0
    )`,
    indexes: [
      `CREATE UNIQUE INDEX IF NOT EXISTS "_shared_source_active" ON "_shared" ("source_pattern", "source_id") WHERE archived_at IS NULL`,
    ],
    facets: [
      { name: "source_pattern", type: "text", required: true },
      { name: "source_id", type: "integer", required: true },
      { name: "visibility", type: "text", required: false },
    ],
  },
  {
    name: "_outputs",
    description: "HTTP egress endpoints. Each entry serves content at GET /o/{path}. Public by default.",
    doctrine: "Create outputs when the human wants to publish content at a stable URL. Set mime_type to match the content. Archive when the endpoint is no longer needed.",
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
    doctrine: "Create ingress endpoints when the human wants to receive external data. Validate facet_mapping DSL before saving. Always specify target_pattern.",
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
    name: "_charter",
    description: "Hive identity and purpose. Key-value pairs that define who owns this hive, what it's for, and guiding principles. Surfaced to every agent on connection.",
    doctrine: "Set charter values when the human establishes identity, purpose, or principles for this hive. Charter is the root context — keep entries concise and meaningful.",
    ddl: `CREATE TABLE IF NOT EXISTS "_charter" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "key" TEXT NOT NULL,
      "value" TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT,
      version INTEGER NOT NULL DEFAULT 0
    )`,
    indexes: [
      `CREATE UNIQUE INDEX IF NOT EXISTS "_charter_key_active" ON "_charter" ("key") WHERE archived_at IS NULL`,
    ],
    facets: [
      { name: "key", type: "text", required: true },
      { name: "value", type: "text", required: true },
    ],
  },
  {
    name: "_system_tasks",
    description: "Maintenance jobs. Create an entry to dispatch a task. Status updates automatically as the task runs.",
    doctrine: "Create a task when the human requests maintenance like reindexing vectors. Do not create tasks speculatively.",
    ddl: `CREATE TABLE IF NOT EXISTS "_system_tasks" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "task" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "result" TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT,
      version INTEGER NOT NULL DEFAULT 0
    )`,
    facets: [
      { name: "task", type: "select", required: true, options: ["seed_vectors"] },
      { name: "status", type: "select", required: false, options: ["pending", "running", "done", "failed"] },
      { name: "result", type: "text", required: false },
    ],
  },
  {
    name: "_web_cache",
    description: "Cached web content fetched via resolve(). Entries are automatically created when resolving https:// URLs. Cached content expires based on the source adapter's TTL.",
    doctrine: "Managed automatically by the web resolution system. Do not create entries directly — use resolve with an https:// URL instead.",
    ddl: `CREATE TABLE IF NOT EXISTS "_web_cache" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "url" TEXT NOT NULL,
      "content" TEXT NOT NULL,
      "source_adapter" TEXT NOT NULL,
      "metadata" TEXT,
      "fetched_at" TEXT NOT NULL DEFAULT (datetime('now')),
      "expires_at" TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT,
      version INTEGER NOT NULL DEFAULT 0
    )`,
    indexes: [
      `CREATE UNIQUE INDEX IF NOT EXISTS "_web_cache_url_active" ON "_web_cache" ("url") WHERE archived_at IS NULL`,
    ],
    facets: [
      { name: "url", type: "text", required: true },
      { name: "content", type: "text", required: true },
      { name: "source_adapter", type: "text", required: true },
      { name: "metadata", type: "text", required: false },
      { name: "fetched_at", type: "datetime", required: false },
      { name: "expires_at", type: "datetime", required: true },
    ],
  },
  {
    name: "_system_docs",
    description: "System documentation for agent orientation. Editable but requires confirmation. Set content to null to restore defaults.",
    doctrine: "Read before acting. Edit content only when the human requests it. Set content to null to restore defaults. Never modify default_content.",
    ddl: `CREATE TABLE IF NOT EXISTS "_system_docs" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "slug" TEXT NOT NULL UNIQUE,
      "title" TEXT NOT NULL,
      "content" TEXT,
      "default_content" TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT
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

export function initializeSchema(db: any, env?: { WORKER_HOST?: string }): void {
  // --- Core schema tables ---

  db.exec(`CREATE TABLE IF NOT EXISTS _objects (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    doctrine TEXT NOT NULL DEFAULT '',
    archived_at TEXT
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS _fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    object_name TEXT NOT NULL REFERENCES _objects(name),
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    required INTEGER NOT NULL DEFAULT 0,
    default_value TEXT,
    references_object TEXT,
    options TEXT,
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

  // --- v5: consolidate token tables into _access_tokens ---

  const RETIRED_TABLES = ["_auth_codes", "_upload_tokens", "_marketplace_tokens"];
  for (const old of RETIRED_TABLES) {
    for (const op of ["insert", "update", "delete"]) {
      try { db.exec(`DROP TRIGGER IF EXISTS "_audit_${old}_${op}"`); } catch {}
    }
    try { db.exec(`DROP TABLE IF EXISTS "${old}"`); } catch {}
  }
  db.exec(`DELETE FROM _objects WHERE name IN ('_auth_codes', '_upload_tokens', '_marketplace_tokens')`);
  db.exec(`DELETE FROM _fields WHERE object_name IN ('_auth_codes', '_upload_tokens', '_marketplace_tokens')`);

  // --- v5b: add archived_at to _system_docs (was missing kernel column) ---

  try {
    const cols = db.exec(`PRAGMA table_info("_system_docs")`).toArray() as any[];
    if (!cols.some((c: any) => c.name === "archived_at")) {
      db.exec(`ALTER TABLE "_system_docs" ADD COLUMN "archived_at" TEXT`);
    }
  } catch {}

  // --- v6: add doctrine column to _objects ---

  try {
    const objCols = db.exec(`PRAGMA table_info("_objects")`).toArray() as any[];
    if (!objCols.some((c: any) => c.name === "doctrine")) {
      db.exec(`ALTER TABLE "_objects" ADD COLUMN "doctrine" TEXT NOT NULL DEFAULT ''`);
    }
  } catch {}

  // --- v7: add options column to _fields for select facets ---

  try {
    const fieldCols = db.exec(`PRAGMA table_info("_fields")`).toArray() as any[];
    if (!fieldCols.some((c: any) => c.name === "options")) {
      db.exec(`ALTER TABLE "_fields" ADD COLUMN "options" TEXT`);
    }
  } catch {}

  // --- v8: add archived_at to _objects for pattern archiving ---

  try {
    const objCols2 = db.exec(`PRAGMA table_info("_objects")`).toArray() as any[];
    if (!objCols2.some((c: any) => c.name === "archived_at")) {
      db.exec(`ALTER TABLE "_objects" ADD COLUMN "archived_at" TEXT`);
    }
  } catch {}

  // --- GC: drop archived patterns older than 30 days ---

  try {
    const expired = db.exec(
      `SELECT name FROM _objects WHERE archived_at IS NOT NULL AND archived_at < datetime('now', '-30 days') AND name NOT LIKE '\\_%' ESCAPE '\\'`
    ).toArray() as any[];
    for (const obj of expired) {
      for (const op of ["insert", "update", "delete"]) {
        try { db.exec(`DROP TRIGGER IF EXISTS "_audit_${obj.name}_${op}"`); } catch {}
      }
      try { db.exec(`DROP TABLE IF EXISTS "${obj.name}"`); } catch {}
      db.exec(`DELETE FROM _fields WHERE object_name = ?`, obj.name);
      db.exec(`DELETE FROM _objects WHERE name = ?`, obj.name);
    }
  } catch {}

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

  // --- Instance info doc (seeded from env, not from file) ---

  if (env?.WORKER_HOST) {
    const instanceContent = `# Instance Info

- **Host**: ${env.WORKER_HOST}
- **Base URL**: https://${env.WORKER_HOST}
- **MCP endpoint**: https://${env.WORKER_HOST}/mcp
- **Upload endpoint**: https://${env.WORKER_HOST}/upload/{token}
- **Shared entries**: https://${env.WORKER_HOST}/o/entry/{pattern}/{id}
- **Egress outputs**: https://${env.WORKER_HOST}/o/{path}
- **Ingress inputs**: https://${env.WORKER_HOST}/i/{path}`;

    const existing = db.exec(
      `SELECT id, default_content FROM "_system_docs" WHERE slug = 'instance'`
    ).toArray() as any[];
    if (existing.length === 0) {
      db.exec(
        `INSERT INTO "_system_docs" (slug, title, content, default_content) VALUES ('instance', 'Instance Info', ?, ?)`,
        instanceContent, instanceContent
      );
    } else if (existing[0].default_content !== instanceContent) {
      db.exec(
        `UPDATE "_system_docs" SET default_content = ?, content = ?, title = 'Instance Info', updated_at = datetime('now') WHERE slug = 'instance'`,
        instanceContent, instanceContent
      );
    }
  }

  // --- Register kernel objects in normalized schema ---

  for (const table of KERNEL_TABLES) {
    db.exec(
      "INSERT INTO _objects (name, description, doctrine) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET doctrine = excluded.doctrine",
      table.name, table.description, table.doctrine
    );
    for (const f of table.facets) {
      db.exec(
        "INSERT OR IGNORE INTO _fields (object_name, name, type, required, options) VALUES (?, ?, ?, ?, ?)",
        table.name, f.name, f.type, f.required ? 1 : 0, f.options ? JSON.stringify(f.options) : null
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
