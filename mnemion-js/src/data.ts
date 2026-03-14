// Data engine: query, mutate, search
//
// Pure functions that take a DataContext. HiveDO keeps thin RPC wrappers
// that add broadcast and transaction concerns.

import { applyKernelRules, type KernelContext } from "./kernel";
import { uri } from "./constants";

// === Types ===

type DB = { exec: (sql: string, ...params: any[]) => { toArray: () => any[]; one: () => any } };

export interface DataContext {
  db: DB;
  patternExists(name: string): boolean;
  entryExists(pattern: string, id: number): boolean;
  hasKernelVersion(patternName: string): boolean;
  facetMeta(pattern: string, facet: string): { type: string; options?: string[] } | null;
}

// === Constants ===

const KERNEL_COLUMNS = new Set(["id", "created_at", "updated_at", "archived_at"]);

const LIMITS = {
  ENTRY_BYTES: 1_048_576,  // 1 MB per entry
  QUERY_ROWS: 1_000,       // max rows a single query can return
  BATCH_OPS: 100,          // max operations in a single batch mutate
};

export { LIMITS };

function estimateRecordBytes(data: Record<string, unknown>): number {
  let bytes = 0;
  for (const v of Object.values(data)) {
    if (typeof v === "string") bytes += v.length * 2;
    else if (typeof v === "number") bytes += 8;
    else if (typeof v === "boolean") bytes += 4;
    else if (v === null || v === undefined) bytes += 0;
    else bytes += JSON.stringify(v).length * 2;
  }
  return bytes;
}

function errorJson(message: string): string {
  return JSON.stringify({ error: true, message });
}

// === Query ===

export function query(
  ctx: DataContext,
  patternName: string,
  filterJson: string,
  facets: string,
  sortField: string,
  limit: number,
  countOnly: boolean,
): string {
  if (!ctx.patternExists(patternName))
    return errorJson(`Pattern "${patternName}" does not exist`);

  if (countOnly) {
    let countSql = `SELECT COUNT(*) as count FROM "${patternName}" WHERE archived_at IS NULL`;
    const countBindings: (string | number)[] = [];
    if (filterJson) {
      const filters: string[] = JSON.parse(filterJson);
      for (const expr of filters) {
        const parsed = parseFilter(expr);
        if (!parsed) return errorJson(`Invalid filter expression: ${expr}`);
        countSql += ` AND ${parsed.clause}`;
        countBindings.push(parsed.binding);
      }
    }
    try {
      const r = ctx.db.exec(countSql, ...countBindings).one() as { count: number };
      return JSON.stringify({ pattern: patternName, count: r.count }, null, 2);
    } catch (err: any) {
      return errorJson(`Query failed: ${err.message}`);
    }
  }

  let sql = `SELECT`;

  if (facets) {
    const requested = facets.split(",").map((f) => f.trim());
    if (!requested.includes("id")) requested.unshift("id");
    sql += ` ${requested.map((f) => `"${f}"`).join(", ")}`;
  } else {
    sql += ` *`;
  }

  sql += ` FROM "${patternName}" WHERE archived_at IS NULL`;

  const bindings: (string | number)[] = [];
  if (filterJson) {
    const filters: string[] = JSON.parse(filterJson);
    for (const expr of filters) {
      const parsed = parseFilter(expr);
      if (!parsed) return errorJson(`Invalid filter expression: ${expr}`);
      sql += ` AND ${parsed.clause}`;
      bindings.push(parsed.binding);
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
    const rows = ctx.db.exec(sql, ...bindings).toArray();
    return JSON.stringify({ pattern: patternName, entries: rows, count: rows.length }, null, 2);
  } catch (err: any) {
    return errorJson(`Query failed: ${err.message}`);
  }
}

function parseFilter(expr: string): { clause: string; binding: string } | null {
  const match = expr.match(/^(\w+)(=|!=|>|<|>=|<=|~)(.+)$/);
  if (!match) return null;
  const [, field, op, value] = match;
  if (op === "~") return { clause: `"${field}" LIKE ?`, binding: `%${value}%` };
  return { clause: `"${field}" ${op} ?`, binding: value };
}

// === Mutate ===

export function executeMutate(ctx: DataContext, patternName: string, operation: string, data: any): any {
  if (!ctx.patternExists(patternName))
    return { error: true, message: `Pattern "${patternName}" does not exist` };

  // Kernel rules (immutable fields, create hooks)
  const kernelCtx: KernelContext = {
    patternExists: (name) => ctx.patternExists(name),
    facetMeta: (pattern, facet) => ctx.facetMeta(pattern, facet),
    entryExists: (pattern, id) => ctx.entryExists(pattern, id),
  };
  const ruled = applyKernelRules(patternName, operation, data, kernelCtx);
  if ('error' in ruled) return ruled;
  data = ruled;

  // Size guard + select validation
  if (operation === "create" || operation === "update") {
    const size = estimateRecordBytes(data);
    if (size > LIMITS.ENTRY_BYTES)
      return { error: true, message: `Entry too large: ~${Math.round(size / 1024)}KB exceeds the 1MB limit` };

    for (const [key, val] of Object.entries(data)) {
      if (val == null || key === "id") continue;
      const meta = ctx.facetMeta(patternName, key);
      if (meta?.options && !meta.options.includes(String(val)))
        return { error: true, message: `Invalid value "${val}" for "${key}". Options: ${meta.options.join(", ")}` };
    }
  }

  try {
    switch (operation) {
      case "create": {
        const fields = Object.keys(data).filter((k) => !KERNEL_COLUMNS.has(k));
        const cols = fields.map((f) => `"${f}"`).join(", ");
        const placeholders = fields.map(() => "?").join(", ");
        const values = fields.map((f) => data[f]);

        ctx.db.exec(`INSERT INTO "${patternName}" (${cols}) VALUES (${placeholders})`, ...values);
        const row = ctx.db.exec(`SELECT * FROM "${patternName}" WHERE id = last_insert_rowid()`).one();
        return { operation: "create", pattern: patternName, entry: row, uri: uri(`entry/${patternName}/${(row as any).id}`) };
      }

      case "update": {
        if (!data.id) return { error: true, message: "id is required for update" };
        const kernelVersion = ctx.hasKernelVersion(patternName);

        const stripCols = ["id", "created_at", "archived_at"];
        if (kernelVersion) stripCols.push("version");
        const fields = Object.keys(data).filter((k) => !stripCols.includes(k));
        if (fields.length === 0) return { error: true, message: "No facets to update" };

        const sets = fields.map((f) => `"${f}" = ?`).join(", ");
        const values = fields.map((f) => data[f]);

        if (kernelVersion) {
          let where = `id = ? AND archived_at IS NULL`;
          values.push(data.id);
          if (data.version != null) { where += ` AND version = ?`; values.push(data.version); }

          ctx.db.exec(
            `UPDATE "${patternName}" SET ${sets}, version = version + 1, updated_at = datetime('now') WHERE ${where}`,
            ...values
          );

          if (data.version != null) {
            const changes = ctx.db.exec("SELECT changes() as c").one() as { c: number };
            if (changes.c === 0)
              return { error: true, message: `Version conflict: entry ${data.id} in "${patternName}" has been modified. Re-read and retry.` };
          }
        } else {
          values.push(data.id);
          ctx.db.exec(
            `UPDATE "${patternName}" SET ${sets}, updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL`,
            ...values
          );
        }

        const row = ctx.db.exec(`SELECT * FROM "${patternName}" WHERE id = ?`, data.id).one();
        return { operation: "update", pattern: patternName, entry: row, uri: uri(`entry/${patternName}/${data.id}`) };
      }

      case "patch": {
        if (!data.id) return { error: true, message: "id is required for patch" };
        if (!data.facet) return { error: true, message: "facet is required for patch" };
        if (typeof data.match !== "string") return { error: true, message: "match (string to find) is required for patch" };
        if (typeof data.replacement !== "string") return { error: true, message: "replacement (string to insert) is required for patch" };

        const meta = ctx.facetMeta(patternName, data.facet as string);
        if (!meta) return { error: true, message: `Facet "${data.facet}" does not exist on "${patternName}"` };
        if (meta.type !== "text") return { error: true, message: `Patch only works on text facets, "${data.facet}" is ${meta.type}` };

        // Read current value
        let current: string;
        try {
          const row = ctx.db.exec(
            `SELECT "${data.facet}" FROM "${patternName}" WHERE id = ? AND archived_at IS NULL`, data.id
          ).one() as any;
          if (!row) return { error: true, message: `Entry ${data.id} not found in "${patternName}"` };
          current = row[data.facet as string] ?? "";
        } catch (err: any) {
          return { error: true, message: `Patch read failed: ${err.message}` };
        }

        // Validate match uniqueness
        const matchStr = data.match as string;
        const firstIdx = current.indexOf(matchStr);
        if (firstIdx === -1) return { error: true, message: `Match not found in "${data.facet}". Read the entry and provide an exact substring.` };
        const secondIdx = current.indexOf(matchStr, firstIdx + 1);
        if (secondIdx !== -1) return { error: true, message: `Match is ambiguous — found ${matchStr.length < 40 ? `"${matchStr}"` : "it"} more than once. Provide a longer, unique substring.` };

        // Apply replacement
        const patched = current.slice(0, firstIdx) + (data.replacement as string) + current.slice(firstIdx + matchStr.length);
        const patchSize = estimateRecordBytes({ [data.facet as string]: patched });
        if (patchSize > LIMITS.ENTRY_BYTES)
          return { error: true, message: `Patched entry too large: ~${Math.round(patchSize / 1024)}KB exceeds the 1MB limit` };

        const kernelVersion = ctx.hasKernelVersion(patternName);
        if (kernelVersion) {
          const bindings: any[] = [patched, data.id];
          let where = `id = ? AND archived_at IS NULL`;
          if (data.version != null) { where += ` AND version = ?`; bindings.push(data.version); }
          ctx.db.exec(
            `UPDATE "${patternName}" SET "${data.facet}" = ?, version = version + 1, updated_at = datetime('now') WHERE ${where}`,
            ...bindings
          );
          if (data.version != null) {
            const changes = ctx.db.exec("SELECT changes() as c").one() as { c: number };
            if (changes.c === 0)
              return { error: true, message: `Version conflict: entry ${data.id} in "${patternName}" has been modified. Re-read and retry.` };
          }
        } else {
          ctx.db.exec(
            `UPDATE "${patternName}" SET "${data.facet}" = ?, updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL`,
            patched, data.id
          );
        }

        const row = ctx.db.exec(`SELECT * FROM "${patternName}" WHERE id = ?`, data.id).one();
        return { operation: "patch", pattern: patternName, entry: row, uri: uri(`entry/${patternName}/${data.id}`) };
      }

      case "archive": {
        if (!data.id) return { error: true, message: "id is required for archive" };
        ctx.db.exec(
          `UPDATE "${patternName}" SET archived_at = datetime('now') WHERE id = ? AND archived_at IS NULL`,
          data.id
        );
        return { operation: "archive", pattern: patternName, id: data.id, uri: uri(`entry/${patternName}/${data.id}`) };
      }

      case "unarchive": {
        if (!data.id) return { error: true, message: "id is required for unarchive" };
        ctx.db.exec(
          `UPDATE "${patternName}" SET archived_at = NULL, updated_at = datetime('now') WHERE id = ? AND archived_at IS NOT NULL`,
          data.id
        );
        return { operation: "unarchive", pattern: patternName, id: data.id, uri: uri(`entry/${patternName}/${data.id}`) };
      }

      default:
        return { error: true, message: `Unknown operation: ${operation}. Use create, update, patch, archive, or unarchive.` };
    }
  } catch (err: any) {
    return { error: true, message: `Mutate failed: ${err.message}` };
  }
}

// === Search ===

export function search(ctx: DataContext, term: string, objectsJson: string, limit_: number): string {
  const limit = Math.min(limit_ || 20, LIMITS.QUERY_ROWS);
  const targetObjects = objectsJson
    ? JSON.parse(objectsJson) as string[]
    : (ctx.db.exec("SELECT name FROM _objects ORDER BY name").toArray() as any[]).map((r: any) => r.name);

  const results: { pattern: string; entry: any; matched_facets: string[] }[] = [];

  for (const objName of targetObjects) {
    if (!ctx.patternExists(objName)) continue;

    const textFields = (ctx.db.exec(
      "SELECT name FROM _fields WHERE object_name = ? AND type = 'text' ORDER BY id", objName
    ).toArray() as any[]).map((r: any) => r.name as string);
    if (textFields.length === 0) continue;

    const conditions = textFields.map((f) => `"${f}" LIKE ?`).join(" OR ");
    const bindings = textFields.map(() => `%${term}%`);

    try {
      const rows = ctx.db.exec(
        `SELECT * FROM "${objName}" WHERE archived_at IS NULL AND (${conditions}) LIMIT ?`,
        ...bindings, limit
      ).toArray();

      for (const row of rows) {
        const matched = textFields.filter((f) => {
          const val = (row as any)[f];
          return typeof val === "string" && val.toLowerCase().includes(term.toLowerCase());
        });
        results.push({ pattern: objName, entry: row, matched_facets: matched });
      }
    } catch { /* table may not exist yet */ }

    if (results.length >= limit) break;
  }

  return JSON.stringify({
    term, results: results.slice(0, limit), count: Math.min(results.length, limit),
  }, null, 2);
}
