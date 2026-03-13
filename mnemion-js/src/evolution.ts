// Schema evolution engine
//
// Each change type is one row in CHANGE_TYPES: validate, preview, apply.
// The full evolution surface is visible by scanning this table.
// proposeChange and applyChange are generic dispatchers.

import { PRODUCT_NAME, uri } from "./constants";
import { ensureAuditTriggers } from "./schema";
import type { StoreIndex, IndexFacetEntry } from "./hive";

// === Types ===

type DB = { exec: (sql: string, ...params: any[]) => { toArray: () => any[]; one: () => any } };

export interface EvolutionContext {
  db: DB;
  patternExists(name: string): boolean;
  entryExists(pattern: string, id: number): boolean;
}

// === Constants (shared with hive.ts — could be centralized later) ===

const SQLITE_TYPE_MAP: Record<string, string> = {
  text: "TEXT", number: "REAL", integer: "INTEGER", boolean: "INTEGER", datetime: "TEXT", select: "TEXT",
};

const KERNEL_COLUMNS = new Set(["id", "created_at", "updated_at", "archived_at"]);

const LIMITS = {
  NAME_MAX_LEN: 64,
  FACETS_PER_PATTERN: 64,
};

const NAME_RE = /^[a-z_][a-z0-9_-]*$/;

function validateName(kind: string, name: string): string | null {
  if (!name || name.length > LIMITS.NAME_MAX_LEN)
    return `${kind} name must be 1–${LIMITS.NAME_MAX_LEN} characters, got ${name?.length ?? 0}`;
  if (!NAME_RE.test(name))
    return `${kind} name must be lowercase, start with a letter, and contain only a-z, 0-9, hyphens, underscores. Got: "${name}"`;
  return null;
}

// === Facet helpers ===

function validateFacets(
  facets: any[],
  ctx: EvolutionContext,
  existingFacets?: IndexFacetEntry[],
): string | null {
  for (const a of facets) {
    const nameErr = validateName("Facet", a.name);
    if (nameErr) return nameErr;
    if (!SQLITE_TYPE_MAP[a.type]) return `Unknown facet type: ${a.type}`;
    if (KERNEL_COLUMNS.has(a.name))
      return `Facet "${a.name}" is a kernel-provided column and cannot be defined by the user`;
    if (existingFacets?.some((e) => e.name === a.name))
      return `Facet "${a.name}" already exists on the pattern`;
    if (a.links && !ctx.patternExists(a.links.pattern))
      return `Linked pattern "${a.links.pattern}" does not exist`;
    if (a.type === "select" && (!Array.isArray(a.options) || a.options.length === 0))
      return `Facet "${a.name}" is type select but has no options`;
    if (a.type !== "select" && a.options)
      return `Facet "${a.name}" has options but is not type select`;
  }
  return null;
}

function facetToIndexEntry(a: any): IndexFacetEntry {
  const facet: IndexFacetEntry = {
    name: a.name, type: a.type, required: a.required ?? false,
    default: a.default_value ?? null,
  };
  if (a.links) facet.links = a.links.pattern;
  if (a.options) facet.options = a.options;
  return facet;
}

function facetToDDL(a: any): string {
  let col = `"${a.name}" ${SQLITE_TYPE_MAP[a.type]}`;
  if (a.required) col += " NOT NULL";
  if (a.default_value != null) {
    col += typeof a.default_value === "string"
      ? ` DEFAULT '${a.default_value}'`
      : ` DEFAULT ${a.default_value}`;
  }
  if (a.links) col += ` REFERENCES "${a.links.pattern}"("${a.links.facet || 'id'}")`;
  return col;
}

function registerFacets(db: DB, patternName: string, facets: any[]): void {
  for (const a of facets) {
    db.exec(
      "INSERT INTO _fields (object_name, name, type, required, default_value, references_object, options) VALUES (?, ?, ?, ?, ?, ?, ?)",
      patternName, a.name, a.type, a.required ? 1 : 0,
      a.default_value != null ? JSON.stringify(a.default_value) : null,
      a.links?.pattern ?? null,
      a.options ? JSON.stringify(a.options) : null
    );
  }
}

// === Change type declarations ===

interface ChangeType {
  validate: (change: any, ctx: EvolutionContext, preview: StoreIndex) => string | null;
  preview:  (change: any, preview: StoreIndex) => void;
  apply:    (change: any, ctx: EvolutionContext) => void;
}

const CHANGE_TYPES: Record<string, ChangeType> = {

  create_pattern: {
    validate(change, ctx) {
      if (!change.pattern_name) return "pattern_name is required for create_pattern";
      const nameErr = validateName("Pattern", change.pattern_name);
      if (nameErr) return nameErr;
      if (!change.doctrine) return "doctrine is required for create_pattern — describe how this pattern should be used";
      if (!change.facets?.length) return "At least one facet is required for create_pattern";
      if (change.facets.length > LIMITS.FACETS_PER_PATTERN)
        return `Too many facets: ${change.facets.length} exceeds limit of ${LIMITS.FACETS_PER_PATTERN}`;
      if (ctx.patternExists(change.pattern_name))
        return `Pattern "${change.pattern_name}" already exists`;
      return validateFacets(change.facets, ctx);
    },
    preview(change, preview) {
      preview.patterns.push({
        name: change.pattern_name,
        description: change.pattern_description || "",
        doctrine: change.doctrine,
        facets: change.facets.map(facetToIndexEntry),
        entry_count: 0,
      });
    },
    apply(change, { db }) {
      const colDefs = change.facets.map(facetToDDL);
      const hasUserVersion = change.facets.some((a: any) => a.name === "version");
      const kernelCols = [
        ...(hasUserVersion ? [] : ["version INTEGER NOT NULL DEFAULT 0"]),
        "created_at TEXT NOT NULL DEFAULT (datetime('now'))",
        "updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
        "archived_at TEXT",
      ];
      db.exec(`CREATE TABLE "${change.pattern_name}" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ${colDefs.join(",\n        ")},
        ${kernelCols.join(",\n        ")}
      )`);
      db.exec("INSERT INTO _objects (name, description, doctrine) VALUES (?, ?, ?)",
        change.pattern_name, change.pattern_description || "", change.doctrine);
      registerFacets(db, change.pattern_name, change.facets);
      ensureAuditTriggers(db, change.pattern_name);
    },
  },

  add_facet: {
    validate(change, ctx, preview) {
      if (!change.pattern_name) return "pattern_name is required for add_facet";
      if (!change.facets?.length) return "At least one facet is required for add_facet";
      if (!ctx.patternExists(change.pattern_name))
        return `Pattern "${change.pattern_name}" does not exist`;
      const pat = preview.patterns.find((p) => p.name === change.pattern_name);
      if (!pat) return `Pattern "${change.pattern_name}" does not exist`;
      if (pat.facets.length + change.facets.length > LIMITS.FACETS_PER_PATTERN)
        return `Adding ${change.facets.length} facets would exceed the limit of ${LIMITS.FACETS_PER_PATTERN} facets per pattern`;
      return validateFacets(change.facets, ctx, pat.facets);
    },
    preview(change, preview) {
      const pat = preview.patterns.find((p) => p.name === change.pattern_name)!;
      for (const a of change.facets) pat.facets.push(facetToIndexEntry(a));
    },
    apply(change, { db }) {
      for (const a of change.facets) {
        let ddl = `ALTER TABLE "${change.pattern_name}" ADD COLUMN ${facetToDDL(a)}`;
        db.exec(ddl);
      }
      registerFacets(db, change.pattern_name, change.facets);
      db.exec(`DROP TRIGGER IF EXISTS "_audit_${change.pattern_name}_insert"`);
      db.exec(`DROP TRIGGER IF EXISTS "_audit_${change.pattern_name}_update"`);
      db.exec(`DROP TRIGGER IF EXISTS "_audit_${change.pattern_name}_delete"`);
      ensureAuditTriggers(db, change.pattern_name);
    },
  },

  set_sharing: {
    validate(change, ctx) {
      if (!change.pattern_name) return "pattern_name is required for set_sharing";
      if (change.entry_id == null) return "entry_id is required for set_sharing";
      if (!ctx.patternExists(change.pattern_name))
        return `Pattern "${change.pattern_name}" does not exist`;
      if (!ctx.entryExists(change.pattern_name, change.entry_id))
        return `Entry ${change.entry_id} not found in "${change.pattern_name}"`;
      const vis = change.visibility ?? "public";
      if (!["public", "unlisted", "private"].includes(vis))
        return `Invalid visibility "${vis}". Use "public", "unlisted", or "private".`;
      return null;
    },
    preview() { /* sharing doesn't alter the schema index */ },
    apply(change, { db }) {
      const vis = change.visibility ?? "public";
      // Always archive existing sharing entry
      db.exec(
        `UPDATE "_shared" SET archived_at = datetime('now'), updated_at = datetime('now') WHERE source_pattern = ? AND source_id = ? AND archived_at IS NULL`,
        change.pattern_name, change.entry_id
      );
      if (vis !== "private") {
        db.exec(
          `INSERT INTO "_shared" (source_pattern, source_id, visibility) VALUES (?, ?, ?)`,
          change.pattern_name, change.entry_id, vis
        );
      }
    },
  },

  set_options: {
    validate(change, ctx, preview) {
      if (!change.pattern_name) return "pattern_name is required for set_options";
      if (!change.facet_name) return "facet_name is required for set_options";
      if (!ctx.patternExists(change.pattern_name))
        return `Pattern "${change.pattern_name}" does not exist`;
      const pat = preview.patterns.find((p) => p.name === change.pattern_name);
      if (!pat) return `Pattern "${change.pattern_name}" does not exist`;
      const facet = pat.facets.find((f) => f.name === change.facet_name);
      if (!facet) return `Facet "${change.facet_name}" does not exist on "${change.pattern_name}"`;
      if (facet.type !== "text" && facet.type !== "select")
        return `set_options only works on text or select facets, "${change.facet_name}" is ${facet.type}`;
      if (!Array.isArray(change.options) || change.options.length === 0)
        return "options must be a non-empty array of strings";
      return null;
    },
    preview(change, preview) {
      const pat = preview.patterns.find((p) => p.name === change.pattern_name)!;
      const facet = pat.facets.find((f) => f.name === change.facet_name)!;
      facet.type = "select";
      facet.options = change.options;
    },
    apply(change, { db }) {
      db.exec(
        "UPDATE _fields SET type = 'select', options = ? WHERE object_name = ? AND name = ?",
        JSON.stringify(change.options), change.pattern_name, change.facet_name
      );
    },
  },

  set_doctrine: {
    validate(change, ctx) {
      if (!change.pattern_name) return "pattern_name is required for set_doctrine";
      if (!change.doctrine) return "doctrine is required for set_doctrine";
      if (!ctx.patternExists(change.pattern_name))
        return `Pattern "${change.pattern_name}" does not exist`;
      return null;
    },
    preview(change, preview) {
      const pat = preview.patterns.find((p) => p.name === change.pattern_name);
      if (pat) pat.doctrine = change.doctrine;
    },
    apply(change, { db }) {
      db.exec(
        "UPDATE _objects SET doctrine = ? WHERE name = ?",
        change.doctrine, change.pattern_name
      );
    },
  },

  archive_pattern: {
    validate(change, ctx) {
      if (!change.pattern_name) return "pattern_name is required for archive_pattern";
      if (!ctx.patternExists(change.pattern_name))
        return `Pattern "${change.pattern_name}" does not exist`;
      if (change.pattern_name.startsWith("_"))
        return `Cannot archive kernel pattern "${change.pattern_name}"`;
      return null;
    },
    preview(change, preview) {
      preview.patterns = preview.patterns.filter((p) => p.name !== change.pattern_name);
    },
    apply(change, { db }) {
      db.exec(
        "UPDATE _objects SET archived_at = datetime('now') WHERE name = ?",
        change.pattern_name
      );
    },
  },

  unarchive_pattern: {
    validate(change, { db }) {
      if (!change.pattern_name) return "pattern_name is required for unarchive_pattern";
      const rows = db.exec(
        "SELECT 1 FROM _objects WHERE name = ? AND archived_at IS NOT NULL", change.pattern_name
      ).toArray();
      if (rows.length === 0)
        return `No archived pattern "${change.pattern_name}" found`;
      return null;
    },
    preview() { /* pattern reappears after apply — preview unchanged */ },
    apply(change, { db }) {
      db.exec(
        "UPDATE _objects SET archived_at = NULL WHERE name = ?",
        change.pattern_name
      );
    },
  },
};

// === Generic dispatchers ===

export function proposeChange(
  description: string,
  changeJson: string,
  ctx: EvolutionContext,
  getCurrentIndex: () => StoreIndex,
): string {
  const change = JSON.parse(changeJson);
  const handler = CHANGE_TYPES[change.type];
  if (!handler) return errorJson(`Unknown change type: ${change.type}`);

  const preview = structuredClone(getCurrentIndex());

  const err = handler.validate(change, ctx, preview);
  if (err) return errorJson(err);

  handler.preview(change, preview);

  const changeId = crypto.randomUUID();
  ctx.db.exec(
    "INSERT INTO _pending_changes (id, description, change_spec, preview_index) VALUES (?, ?, ?, ?)",
    changeId, description, JSON.stringify(change), JSON.stringify(preview)
  );

  return JSON.stringify({
    change_id: changeId, description, preview_index: preview,
    message: "Change proposed. Call apply_change with this change_id to commit.",
  }, null, 2);
}

export async function applyChange(
  changeId: string,
  ctx: EvolutionContext,
  getCurrentIndex: () => StoreIndex,
  getBookmark: () => Promise<string | null>,
  broadcastChange: (patterns: string[]) => void,
): Promise<string> {
  const rows = ctx.db.exec("SELECT * FROM _pending_changes WHERE id = ?", changeId).toArray() as any[];
  if (rows.length === 0) return errorJson(`No pending change found with id: ${changeId}`);

  const pending = rows[0];
  const change = JSON.parse(pending.change_spec);
  const handler = CHANGE_TYPES[change.type];
  if (!handler) return errorJson(`Unknown change type: ${change.type}`);

  try {
    handler.apply(change, ctx);

    // Update meta version
    ctx.db.exec("UPDATE _meta SET version = version + 1, updated_at = datetime('now')");

    // Update guidance if still has empty-instance text
    const meta = ctx.db.exec("SELECT guidance FROM _meta WHERE id = 1").one() as { guidance: string };
    if (meta.guidance.includes("No objects exist yet")) {
      const objCount = ctx.db.exec("SELECT COUNT(*) as count FROM _objects").one() as { count: number };
      if (objCount.count > 0) {
        ctx.db.exec("UPDATE _meta SET guidance = ?",
          `${PRODUCT_NAME} is active. Read ${uri("index")} for orientation, then query and mutate to work with data.`);
      }
    }

    // Log to history with PITR bookmark
    const bookmark = await getBookmark();
    ctx.db.exec(
      "INSERT INTO _schema_history (description, change_type, change_detail, bookmark) VALUES (?, ?, ?, ?)",
      pending.description, change.type, pending.change_spec, bookmark
    );

    ctx.db.exec("DELETE FROM _pending_changes WHERE id = ?", changeId);

    broadcastChange(["_schema"]);

    return JSON.stringify({
      applied: true, description: pending.description, index: getCurrentIndex(),
    }, null, 2);
  } catch (err: any) {
    return errorJson(`Failed to apply change: ${err.message}`);
  }
}

export function revertChange(
  historyId: number,
  ctx: EvolutionContext,
  restoreBookmark: (bookmark: string) => void,
  abort: () => void,
): string {
  const rows = ctx.db.exec("SELECT * FROM _schema_history WHERE id = ?", historyId).toArray() as any[];
  if (rows.length === 0) return errorJson(`No schema history entry with id: ${historyId}`);

  const entry = rows[0];
  if (!entry.bookmark)
    return errorJson("No PITR bookmark stored for this change. Rollback unavailable (change may predate PITR support or was made in local dev).");

  try {
    restoreBookmark(entry.bookmark);
    abort();
    return JSON.stringify({
      reverted: true, description: entry.description,
      message: "PITR restore initiated. The Durable Object will restart at the state before this change. WARNING: This restores ALL data, not just schema.",
    }, null, 2);
  } catch (err: any) {
    return errorJson(`Rollback failed: ${err.message}`);
  }
}

function errorJson(message: string): string {
  return JSON.stringify({ error: true, message });
}
