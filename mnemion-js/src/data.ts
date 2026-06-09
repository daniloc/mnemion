// Data engine: query, mutate, search
//
// Pure functions that take a DataContext. HiveDO keeps thin RPC wrappers
// that add broadcast and transaction concerns.

import { applyKernelRules, INTERNAL_WRITE_PROTECTED, type KernelContext } from "./kernel";
import { getMemoryPolicy } from "./prime";
import { uri } from "./constants";

// === Types ===

type DB = { exec: (sql: string, ...params: any[]) => { toArray: () => any[]; one: () => any } };

export interface DataContext {
  db: DB;
  patternExists(name: string): boolean;
  listPatterns(): string[];
  entryExists(pattern: string, id: number): boolean;
  hasKernelVersion(patternName: string): boolean;
  facetMeta(pattern: string, facet: string): { type: string; options?: string[] } | null;
}

// === Constants ===

const KERNEL_COLUMNS = new Set(["id", "created_at", "updated_at", "archived_at"]);

// Columns that always exist on a pattern table regardless of declared facets.
// Used to validate user-supplied identifiers (facets list, sort field) before
// they're interpolated into SQL — identifiers can't be bound, so they must be
// confirmed real to prevent injection via the quoting escape.
const KERNEL_SELECTABLE = new Set(["id", "version", "created_at", "updated_at", "archived_at"]);

function isValidColumn(ctx: DataContext, pattern: string, name: string): boolean {
  return KERNEL_SELECTABLE.has(name) || ctx.facetMeta(pattern, name) != null;
}

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

// === Fuzzy pattern suggestion ===

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function suggestMatch(name: string, candidates: string[]): string {
  if (candidates.length === 0) return "";
  let best = "", bestDist = Infinity;
  for (const c of candidates) {
    if (c.startsWith(name) || name.startsWith(c)) return ` Did you mean "${c}"?`;
    const d = editDistance(name.toLowerCase(), c.toLowerCase());
    if (d < bestDist) { bestDist = d; best = c; }
  }
  if (bestDist <= Math.max(2, Math.floor(name.length * 0.4))) return ` Did you mean "${best}"?`;
  return "";
}

function suggestPattern(name: string, ctx: DataContext): string {
  return suggestMatch(name, ctx.listPatterns());
}

function suggestFacet(name: string, pattern: string, ctx: DataContext): string {
  const facets = ctx.db.exec(
    "SELECT name FROM _fields WHERE object_name = ? ORDER BY id", pattern
  ).toArray().map((r: any) => r.name as string);
  return suggestMatch(name, facets);
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
    return errorJson(`Pattern "${patternName}" does not exist.${suggestPattern(patternName, ctx)}`);

  if (countOnly) {
    let countSql = `SELECT COUNT(*) as count FROM "${patternName}" WHERE archived_at IS NULL`;
    const countBindings: (string | number)[] = [];
    if (filterJson) {
      const filters: string[] = JSON.parse(filterJson);
      for (const expr of filters) {
        const parsed = parseFilter(expr);
        if (!parsed) return errorJson(`Invalid filter expression: ${expr}`);
        countSql += ` AND ${parsed.clause}`;
        countBindings.push(...parsed.bindings);
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
    const requested = facets.split(",").map((f) => f.trim()).filter((f) => f.length > 0);
    for (const f of requested) {
      if (!isValidColumn(ctx, patternName, f))
        return errorJson(`Unknown facet "${f}" on "${patternName}".${suggestFacet(f, patternName, ctx)}`);
    }
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
      bindings.push(...parsed.bindings);
    }
  }

  if (sortField) {
    const desc = sortField.startsWith("-");
    const col = desc ? sortField.slice(1) : sortField;
    if (!isValidColumn(ctx, patternName, col))
      return errorJson(`Cannot sort by unknown facet "${col}" on "${patternName}".${suggestFacet(col, patternName, ctx)}`);
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

function parseFilter(expr: string): { clause: string; bindings: string[] } | null {
  const match = expr.match(/^(\w+)(\|=|=|!=|>=|<=|>|<|~)(.+)$/);
  if (!match) return null;
  const [, field, op, value] = match;
  if (op === "~") return { clause: `"${field}" LIKE ?`, bindings: [`%${value}%`] };
  if (op === "|=") {
    const values = value.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
    if (values.length === 0) return null;
    const placeholders = values.map(() => "?").join(",");
    return { clause: `"${field}" IN (${placeholders})`, bindings: values };
  }
  return { clause: `"${field}" ${op} ?`, bindings: [value] };
}

// === Mutate ===

export function executeMutate(ctx: DataContext, patternName: string, operation: string, data: any): any {
  if (!ctx.patternExists(patternName))
    return { error: true, message: `Pattern "${patternName}" does not exist.${suggestPattern(patternName, ctx)}` };

  // System-managed caches/audit logs are never agent-writable (e.g. _web_cache
  // poisoning → resolve() serving planted content). Internal writers use direct
  // SQL, not this path.
  if (INTERNAL_WRITE_PROTECTED.has(patternName))
    return { error: true, message: `"${patternName}" is managed by the system and cannot be modified directly.` };

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

    const SKIP_KEYS = new Set(["id", "version", "created_at", "updated_at", "archived_at"]);
    for (const [key, val] of Object.entries(data)) {
      if (SKIP_KEYS.has(key)) continue;
      const meta = ctx.facetMeta(patternName, key);
      if (!meta)
        return { error: true, message: `Facet "${key}" does not exist on "${patternName}".${suggestFacet(key, patternName, ctx)}` };
      if (val != null && meta.options && !meta.options.includes(String(val)))
        return { error: true, message: `Invalid value "${val}" for "${key}". Options: ${meta.options.join(", ")}` };
    }
  }

  try {
    switch (operation) {
      case "create": {
        // Exclusive-facet advisory (memory policy): the pattern declares this
        // facet single-valued-per-value, and an active entry already holds it.
        // Checked before the insert so the advisory never matches the new row.
        let overlap: { pattern: string; id: number; uri: string; reason: string; facet: string }[] | undefined;
        if (!patternName.startsWith("_")) {
          const policy = getMemoryPolicy(ctx.db, patternName);
          for (const facet of policy.exclusive_facets) {
            const val = data[facet];
            if (val == null || val === "") continue;
            if (!ctx.facetMeta(patternName, facet)) continue;
            const existing = ctx.db.exec(
              `SELECT id FROM "${patternName}" WHERE "${facet}" = ? AND archived_at IS NULL LIMIT 3`, val
            ).toArray() as { id: number }[];
            for (const e of existing) {
              (overlap ??= []).push({
                pattern: patternName, id: e.id,
                uri: uri(`entry/${patternName}/${e.id}`),
                reason: "exclusive_facet", facet,
              });
            }
          }
        }

        const fields = Object.keys(data).filter((k) => !KERNEL_COLUMNS.has(k));
        const cols = fields.map((f) => `"${f}"`).join(", ");
        const placeholders = fields.map(() => "?").join(", ");
        const values = fields.map((f) => data[f]);

        ctx.db.exec(`INSERT INTO "${patternName}" (${cols}) VALUES (${placeholders})`, ...values);
        const row = ctx.db.exec(`SELECT * FROM "${patternName}" WHERE id = last_insert_rowid()`).one();
        const result: any = { operation: "create", pattern: patternName, entry: row, uri: uri(`entry/${patternName}/${(row as any).id}`) };
        if (overlap?.length) {
          result.possible_overlap = overlap;
          result.overlap_guidance = `Advisory only — the entry was created. These facets are declared exclusive in this pattern's memory policy; if the new entry replaces one of them, link supersession: mutate(pattern: "link", data: {source: "${patternName}/${(row as any).id}", target: "${patternName}/{old_id}", label: "supersedes"}).`;
        }
        return result;
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

      case "unlink": {
        // Find link by source+target shorthand and archive it
        let sp = data.source_pattern as string, si = data.source_id as number;
        let tp = data.target_pattern as string, ti = data.target_id as number;

        // Parse shorthand if provided
        if (data.source && typeof data.source === "string") {
          const parts = (data.source as string).split("/");
          if (parts.length === 2) { sp = parts[0]; si = Number(parts[1]); }
        }
        if (data.target && typeof data.target === "string") {
          const parts = (data.target as string).split("/");
          if (parts.length === 2) { tp = parts[0]; ti = Number(parts[1]); }
        }

        if (!sp || si == null || !tp || ti == null)
          return { error: true, message: "unlink requires source and target (e.g. source: \"tasks/6\", target: \"goals/9\")" };

        const links = ctx.db.exec(
          `SELECT id FROM "_links" WHERE source_pattern = ? AND source_id = ? AND target_pattern = ? AND target_id = ? AND archived_at IS NULL`,
          sp, si, tp, ti
        ).toArray() as any[];
        if (links.length === 0)
          return { error: true, message: `No active link from ${sp}/${si} to ${tp}/${ti}` };

        ctx.db.exec(
          `UPDATE "_links" SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`, links[0].id
        );
        return { operation: "unlink", pattern: "_links", id: links[0].id, source: `${sp}/${si}`, target: `${tp}/${ti}` };
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
