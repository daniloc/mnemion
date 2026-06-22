// Schema evolution engine
//
// Each change type is one row in CHANGE_TYPES: validate, preview, apply.
// The full evolution surface is visible by scanning this table.
// proposeChange and applyChange are generic dispatchers.
//
// @why Schema evolution is a declaration table (CHANGE_TYPES:
// validate/preview/apply per change type) so the full surface is scannable and
// adding a change type is one row, not a procedural chain. Changes are proposed
// then applied in two steps so the agent and the human can preview the index
// delta before committing; apply fires resource-update notifications.
// create_pattern reserves the `_` namespace here so a user pattern can never
// collide with the kernel namespace that isKernelPattern keys on.

import { PRODUCT_NAME, uri, IDENTIFIER_RE } from "../../shared/core/constants";
import { ensureAuditTriggers } from "./schema";
import { isKernelPattern } from "./policy";
import { FACET_RESERVED_COLUMNS, USER_OVERRIDABLE_KERNEL_COLUMNS } from "./kernel-columns";
import { isFormat, FORMAT_IDS } from "../../shared/core/format-palette";
import type { StoreIndex, IndexFacetEntry } from "./reports";

// === Types ===

type DB = { exec: (sql: string, ...params: any[]) => { toArray: () => any[]; one: () => any } };

export interface EvolutionContext {
  db: DB;
  patternExists(name: string): boolean;
  entryExists(pattern: string, id: number): boolean;
}

// === Constants ===

const SQLITE_TYPE_MAP: Record<string, string> = {
  text: "TEXT", number: "REAL", integer: "INTEGER", boolean: "INTEGER", datetime: "TEXT", select: "TEXT",
};

const LIMITS = {
  NAME_MAX_LEN: 64,
  FACETS_PER_PATTERN: 64,
};

const PATTERN_CLASSES = new Set(["knowledge", "dataset"]);

function validateName(kind: string, name: string): string | null {
  if (!name || name.length > LIMITS.NAME_MAX_LEN)
    return `${kind} name must be 1–${LIMITS.NAME_MAX_LEN} characters, got ${name?.length ?? 0}`;
  if (!IDENTIFIER_RE.test(name))
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
    if (FACET_RESERVED_COLUMNS.has(a.name))
      return `Facet "${a.name}" is a kernel-provided column (auto-added to every pattern) and cannot be defined by the user`;
    if (existingFacets?.some((e) => e.name === a.name))
      return `Facet "${a.name}" already exists on the pattern`;
    if (a.links && !ctx.patternExists(a.links.pattern))
      return `Linked pattern "${a.links.pattern}" does not exist`;
    // links.facet is interpolated into REFERENCES "..."("...") DDL — validate it
    // the same as any other identifier so it can't break out of the quoting.
    if (a.links?.facet) {
      const facetErr = validateName("Linked facet", a.links.facet);
      if (facetErr) return facetErr;
    }
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
      // Escape single quotes — default_value is owner-supplied and interpolated
      // into DDL (identifiers/literals can't be bound in CREATE/ALTER TABLE).
      ? ` DEFAULT '${a.default_value.replace(/'/g, "''")}'`
      : ` DEFAULT ${Number(a.default_value)}`;
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
      // The leading-underscore namespace is reserved for kernel patterns — a
      // user pattern named "_foo" would collide with the write-class registry
      // (isKernelPattern) and be denied as unclassified. Refuse it at the source.
      if (isKernelPattern(change.pattern_name))
        return `Pattern name "${change.pattern_name}" is reserved — names starting with "_" belong to the kernel. Choose a name starting with a letter.`;
      if (!change.doctrine) return "doctrine is required for create_pattern — describe how this pattern should be used";
      if (!change.facets?.length) return "At least one facet is required for create_pattern";
      if (change.facets.length > LIMITS.FACETS_PER_PATTERN)
        return `Too many facets: ${change.facets.length} exceeds limit of ${LIMITS.FACETS_PER_PATTERN}`;
      if (ctx.patternExists(change.pattern_name))
        return `Pattern "${change.pattern_name}" already exists`;
      if (change.pattern_class != null && !PATTERN_CLASSES.has(change.pattern_class))
        return `Invalid pattern_class "${change.pattern_class}". Use "knowledge" (default) or "dataset".`;
      return validateFacets(change.facets, ctx);
    },
    preview(change, preview) {
      preview.patterns.push({
        name: change.pattern_name,
        description: change.pattern_description || "",
        doctrine: change.doctrine,
        ...(change.pattern_class === "dataset" ? { pattern_class: "dataset" } : {}),
        facets: change.facets.map(facetToIndexEntry),
        entry_count: 0,
        latest_activity: null,
      });
    },
    apply(change, { db }) {
      const colDefs = change.facets.map(facetToDDL);
      // `version` is the one user-overridable kernel column (USER_OVERRIDABLE_KERNEL_COLUMNS,
      // the same declaration FACET_RESERVED_COLUMNS excludes) — a user `version` facet
      // replaces the kernel default below. Every other kernel column is reserved, so it
      // can never appear here.
      const hasUserVersion = change.facets.some((a: any) => USER_OVERRIDABLE_KERNEL_COLUMNS.has(a.name));
      const kernelCols = [
        ...(hasUserVersion ? [] : ["version INTEGER NOT NULL DEFAULT 0"]),
        "created_at TEXT NOT NULL DEFAULT (datetime('now'))",
        "updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
        // Attribution (Phase 2 shared hive): which member created/last-touched
        // this entry. Set by the mutate engine from the session actor.
        "created_by TEXT",
        "updated_by TEXT",
        "archived_at TEXT",
      ];
      db.exec(`CREATE TABLE "${change.pattern_name}" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ${colDefs.join(",\n        ")},
        ${kernelCols.join(",\n        ")}
      )`);
      db.exec("INSERT INTO _objects (name, description, doctrine, pattern_class) VALUES (?, ?, ?, ?)",
        change.pattern_name, change.pattern_description || "", change.doctrine,
        change.pattern_class === "dataset" ? "dataset" : "knowledge");
      registerFacets(db, change.pattern_name, change.facets);
      ensureAuditTriggers(db, change.pattern_name);
    },
  },

  set_class: {
    validate(change, ctx) {
      if (!change.pattern_name) return "pattern_name is required for set_class";
      if (!ctx.patternExists(change.pattern_name))
        return `Pattern "${change.pattern_name}" does not exist`;
      if (isKernelPattern(change.pattern_name))
        return `Pattern class applies to user patterns, not kernel pattern "${change.pattern_name}"`;
      if (!PATTERN_CLASSES.has(change.pattern_class))
        return `Invalid pattern_class "${change.pattern_class}". Use "knowledge" or "dataset".`;
      // A clipboard requires a dataset-class target (so submitted values are coerced and
      // the completion log aggregates soundly — clipboards/hooks.ts enforces it at bind
      // time). Demoting a bound pattern to knowledge would break that invariant out from
      // under the clipboard, so refuse it while a binding is active.
      if (change.pattern_class === "knowledge") {
        try {
          const bound = ctx.db.exec(
            `SELECT 1 FROM _clipboards WHERE target_pattern = ? AND archived_at IS NULL LIMIT 1`,
            change.pattern_name,
          ).toArray().length > 0;
          if (bound)
            return `Pattern "${change.pattern_name}" is bound by an active clipboard, which requires a dataset-class target. Archive the clipboard before demoting it to knowledge.`;
        } catch { /* _clipboards absent (pre-migration) → no binding to protect */ }
      }
      return null;
    },
    preview(change, preview) {
      const pat = preview.patterns.find((p) => p.name === change.pattern_name);
      if (pat) {
        if (change.pattern_class === "dataset") pat.pattern_class = "dataset";
        else delete pat.pattern_class;
      }
    },
    // Affects future writes (validation) and recall (prime exclusion). Existing
    // rows are untouched; vectors already written linger until re-embedded or
    // archived — acceptable, prime filters dataset patterns at read time too.
    apply(change, { db }) {
      db.exec(
        "UPDATE _objects SET pattern_class = ? WHERE name = ?",
        change.pattern_class, change.pattern_name
      );
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
      // A NOT NULL column added to an EXISTING table needs a DEFAULT — SQLite
      // rejects `ALTER TABLE ADD COLUMN <c> <T> NOT NULL` with no default
      // unconditionally ("Cannot add a NOT NULL column with default value NULL"),
      // so the apply would always throw. (CREATE TABLE in create_pattern is fine,
      // hence this check lives here and not in the shared validateFacets.)
      for (const a of change.facets) {
        if (a.required && a.default_value == null)
          return `Facet "${a.name}": a required facet added to an existing pattern must provide a default_value (existing entries need a value for the new column).`;
      }
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
      if (isKernelPattern(change.pattern_name))
        return `Kernel pattern "${change.pattern_name}" cannot be shared — sharing exposes user-pattern entries only.`;
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

  set_memory_policy: {
    validate(change, ctx, preview) {
      if (!change.pattern_name) return "pattern_name is required for set_memory_policy";
      if (!ctx.patternExists(change.pattern_name))
        return `Pattern "${change.pattern_name}" does not exist`;
      if (isKernelPattern(change.pattern_name))
        return `Memory policy applies to user patterns, not kernel pattern "${change.pattern_name}"`;
      const p = change.policy;
      if (p === null) return null; // explicit clear
      if (!p || typeof p !== "object" || Array.isArray(p))
        return "policy is required for set_memory_policy: {half_life_days?, conflict_check?, exclusive_facets?} (or null to clear)";
      const KNOWN = new Set(["half_life_days", "conflict_check", "exclusive_facets"]);
      for (const key of Object.keys(p)) {
        if (!KNOWN.has(key)) return `Unknown policy field "${key}". Valid: half_life_days, conflict_check, exclusive_facets`;
      }
      if (p.half_life_days != null && (typeof p.half_life_days !== "number" || !(p.half_life_days > 0)))
        return "half_life_days must be a positive number of days, or null for no decay";
      if (p.conflict_check != null && !["annotate", "off"].includes(p.conflict_check))
        return `Invalid conflict_check "${p.conflict_check}". Use "annotate" or "off".`;
      if (p.exclusive_facets != null) {
        if (!Array.isArray(p.exclusive_facets) || p.exclusive_facets.some((f: unknown) => typeof f !== "string"))
          return "exclusive_facets must be an array of facet names";
        const pat = preview.patterns.find((x) => x.name === change.pattern_name);
        for (const f of p.exclusive_facets) {
          if (!pat?.facets.some((x) => x.name === f))
            return `exclusive_facets names facet "${f}" which does not exist on "${change.pattern_name}"`;
        }
      }
      return null;
    },
    preview(change, preview) {
      const pat = preview.patterns.find((p) => p.name === change.pattern_name);
      if (pat) pat.memory_policy = change.policy ?? null;
    },
    apply(change, { db }) {
      db.exec(
        "UPDATE _objects SET memory_policy = ? WHERE name = ?",
        change.policy ? JSON.stringify(change.policy) : null, change.pattern_name
      );
    },
  },

  set_facet_format: {
    validate(change, ctx, preview) {
      if (!change.pattern_name) return "pattern_name is required for set_facet_format";
      if (!ctx.patternExists(change.pattern_name))
        return `Pattern "${change.pattern_name}" does not exist`;
      if (isKernelPattern(change.pattern_name))
        return `Facet formats apply to user patterns, not kernel pattern "${change.pattern_name}"`;
      if (!change.facet) return "facet is required for set_facet_format";
      const pat = preview.patterns.find((p) => p.name === change.pattern_name);
      if (!pat?.facets.some((f) => f.name === change.facet))
        return `Facet "${change.facet}" does not exist on "${change.pattern_name}"`;
      if (change.format === null) return null; // explicit clear → derive from type
      if (typeof change.format !== "string" || !isFormat(change.format))
        return `format must be one of: ${FORMAT_IDS.join(", ")} (or null to clear)`;
      return null;
    },
    preview(change, preview) {
      const pat = preview.patterns.find((p) => p.name === change.pattern_name);
      const facet = pat?.facets.find((f) => f.name === change.facet);
      if (facet) facet.format = change.format ?? undefined;
    },
    apply(change, { db }) {
      db.exec(
        "UPDATE _fields SET format = ? WHERE object_name = ? AND name = ?",
        change.format ?? null, change.pattern_name, change.facet
      );
    },
  },

  archive_pattern: {
    validate(change, ctx) {
      if (!change.pattern_name) return "pattern_name is required for archive_pattern";
      if (!ctx.patternExists(change.pattern_name))
        return `Pattern "${change.pattern_name}" does not exist`;
      if (isKernelPattern(change.pattern_name))
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

// The change types an agent may propose — the single source the MCP tool's
// `change.type` enum derives from (session.ts), so a new change type is exposed
// through MCP automatically and the protocol contract can't drift from the
// engine's CHANGE_TYPES table.
export const CHANGE_TYPE_NAMES = Object.keys(CHANGE_TYPES) as [string, ...string[]];

// === Generic dispatchers ===

// A change touches one pattern (or one entry within one). Returning the whole
// index + charter on every propose/apply is a multi-thousand-token drain that's
// ~95% irrelevant to the change — and the charter's epistemic_caution block
// alone dominates it. Return only what's needed to confirm the change looks
// right; agents that want the full picture resolve mnemion://index.
//
// The exception is downstream impact: a destructive change (archiving a pattern)
// can leave references elsewhere dangling. Minimalism that hides a broken
// reference is worse than the bloat, so we surface the affected set — the target
// plus what the change actually breaks. That's a targeted inbound-reference
// query, not a re-serialization of the hive.
function focusedPreview(change: any, index: StoreIndex, ctx: EvolutionContext): Record<string, unknown> {
  const name = change.pattern_name;
  switch (change.type) {
    case "set_sharing":
      return { pattern_name: name, entry_id: change.entry_id, visibility: change.visibility ?? "public" };
    case "archive_pattern": {
      const impact = referenceImpact(ctx, name);
      return { pattern_name: name, archived: true, ...(impact ? { impact } : {}) };
    }
    case "unarchive_pattern":
      return { pattern_name: name, unarchived: true };
    default: {
      const pat = name ? index.patterns.find((p) => p.name === name) : undefined;
      return pat ? { pattern: pat } : { pattern_name: name ?? null };
    }
  }
}

// References from elsewhere that point INTO `patternName` — active `_links` whose
// target is one of its entries, and foreign-key facets on other patterns that
// reference it. After the pattern is archived these dangle (the entries become
// unreachable), so the propose/apply return flags them. Self-references are
// excluded: they're archived together with the pattern, not orphaned.
function referenceImpact(ctx: EvolutionContext, patternName: string): Record<string, unknown> | null {
  if (!patternName) return null;
  const CAP = 25;
  let links: { source_pattern: string; source_id: number; label: string | null }[] = [];
  let facets: { object_name: string; name: string }[] = [];
  try {
    links = ctx.db.exec(
      `SELECT source_pattern, source_id, label FROM "_links"
       WHERE target_pattern = ? AND source_pattern != ? AND archived_at IS NULL
       ORDER BY source_pattern, source_id`,
      patternName, patternName
    ).toArray() as any[];
  } catch { /* _links may not exist yet */ }
  try {
    facets = ctx.db.exec(
      `SELECT object_name, name FROM _fields WHERE references_object = ? AND object_name != ?`,
      patternName, patternName
    ).toArray() as any[];
  } catch { /* best-effort */ }

  if (links.length === 0 && facets.length === 0) return null;

  return {
    dangling_reference_count: links.length,
    ...(links.length ? {
      dangling_references: links.slice(0, CAP).map((l) => ({
        from: `${l.source_pattern}/${l.source_id}`,
        uri: uri(`entry/${l.source_pattern}/${l.source_id}`),
        ...(l.label ? { label: l.label } : {}),
      })),
    } : {}),
    ...(links.length > CAP ? { dangling_references_truncated: links.length - CAP } : {}),
    ...(facets.length ? { referencing_facets: facets.map((f) => `${f.object_name}.${f.name}`) } : {}),
    warning: `Archiving "${patternName}" leaves ${links.length} reference(s) from other entries pointing at now-unreachable entries${facets.length ? ` and ${facets.length} foreign-key facet(s) referencing it` : ""}. Re-point or archive those, or reconsider the archive.`,
  };
}


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
    change_id: changeId,
    description,
    change_type: change.type,
    version: preview.version,
    preview: focusedPreview(change, preview, ctx),
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

    const freshIndex = getCurrentIndex();
    return JSON.stringify({
      applied: true,
      description: pending.description,
      change_type: change.type,
      pattern_name: change.pattern_name ?? null,
      version: freshIndex.version,
      preview: focusedPreview(change, freshIndex, ctx),
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
