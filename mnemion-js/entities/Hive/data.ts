// Data engine: query, mutate, search
//
// Pure functions that take a DataContext. HiveDO keeps thin RPC wrappers
// that add broadcast and transaction concerns.
//
// @why The query/mutate/search engine is pure functions over an injected
// DataContext so the same logic serves the MCP path and the browser /api path
// without duplication. executeMutate is the one chokepoint every engine write
// crosses: it strips forged created_by/updated_by, refuses System patterns,
// refuses any kernel target on an untrusted (ingress) write, and runs the
// kernel rules — so the boundary holds for callers entering below the MCP
// consent layer. patch honors field immutability here (not only in the kernel
// hooks) because applyKernelRules scans top-level keys and a patched facet
// rides in data.facet.

import { applyKernelRules, immutableFieldError, type KernelContext } from "./kernel";
import { isInternalWriteProtected, isKernelPattern, isValidWriteTarget } from "./policy";
import { getMemoryPolicy } from "./prime";
import { uri } from "../../shared/core/constants";
import {
  KERNEL_COLUMN_SET,
  CALLER_EXCLUDED_ON_CREATE,
  STRUCTURAL_KERNEL_COLUMNS,
} from "./kernel-columns";

// === Types ===

type DB = { exec: (sql: string, ...params: any[]) => { toArray: () => any[]; one: () => any } };

export interface DataContext {
  db: DB;
  patternExists(name: string): boolean;
  listPatterns(): string[];
  entryExists(pattern: string, id: number): boolean;
  hasKernelVersion(patternName: string): boolean;
  facetMeta(pattern: string, facet: string): { type: string; options?: string[] } | null;
  patternClass(name: string): "knowledge" | "dataset";
  /** The member this write is attributed to (created_by/updated_by). */
  actor: string;
  /** Whether this context entered through a TRUSTED surface (the authenticated
   *  MCP/owner session, which runs the consent gate) or an UNTRUSTED public path
   *  (ingress writes; served public-page / OG / publication / /o-entry reads).
   *  The single kernel boundary, symmetric across reads and writes: an untrusted
   *  context (`!trusted`) may neither WRITE a kernel pattern nor READ one — the
   *  engine refuses both, so the boundary lives at this one chokepoint instead of
   *  a check per call site. REQUIRED (no default): a context must declare its
   *  trust, so a new serve/ingress path can't silently inherit kernel access. */
  trusted: boolean;
}

// === Constants ===

// Kernel column slices live in ./kernel-columns (the canonical home):
//  - CALLER_EXCLUDED_ON_CREATE — auto-provided columns stripped from the
//    agent-supplied field set on create (created_by/updated_by stamped from ctx.actor).
//  - KERNEL_COLUMN_SET — every column that always exists on a pattern table
//    regardless of declared facets; used to validate user-supplied identifiers
//    (facets list, sort field) before they're interpolated into SQL — identifiers
//    can't be bound, so they must be confirmed real to prevent injection via the
//    quoting escape.

function isValidColumn(ctx: DataContext, pattern: string, name: string): boolean {
  return KERNEL_COLUMN_SET.has(name) || ctx.facetMeta(pattern, name) != null;
}

const LIMITS = {
  ENTRY_BYTES: 1_048_576,       // 1 MB per entry
  DOCUMENT_BYTES: 26_214_400,   // 25 MB per uploaded document (R2-backed)
  QUERY_ROWS: 1_000,            // max rows a single query can return
  BATCH_OPS: 100,               // max operations in a single batch mutate
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

// === Facet value validation (dataset patterns) ===
//
// Knowledge patterns stay permissive — facet types are advisory, everything is
// stored as given. Dataset patterns enforce structural well-formedness so that
// aggregation over them is sound: a "number" facet must hold a number, not
// "banana". This is shape-checking, not truth-adjudication — it never blocks a
// memory on semantic grounds, so it sits cleanly beside the never-blocks doctrine.
// Each validator coerces to the canonical stored form or reports why it can't.

type Coerce = { ok: true; value: unknown } | { ok: false; error: string };

const FACET_VALIDATORS: Record<string, (v: unknown) => Coerce> = {
  text: (v) => ({ ok: true, value: typeof v === "string" ? v : String(v) }),
  number: (v) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: `expected a number, got ${JSON.stringify(v)}` };
  },
  integer: (v) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isInteger(n) ? { ok: true, value: n } : { ok: false, error: `expected an integer, got ${JSON.stringify(v)}` };
  },
  boolean: (v) => {
    if (typeof v === "boolean") return { ok: true, value: v ? 1 : 0 };
    if (v === 1 || v === 0) return { ok: true, value: v };
    if (v === "true" || v === "1") return { ok: true, value: 1 };
    if (v === "false" || v === "0") return { ok: true, value: 0 };
    return { ok: false, error: `expected a boolean, got ${JSON.stringify(v)}` };
  },
  datetime: (v) => {
    if (typeof v !== "string" && typeof v !== "number") return { ok: false, error: `expected a date string` };
    const t = Date.parse(String(v));
    return Number.isNaN(t) ? { ok: false, error: `expected a valid date (ISO 8601), got ${JSON.stringify(v)}` } : { ok: true, value: String(v) };
  },
  select: (v) => ({ ok: true, value: v }), // option membership is checked separately
};

interface FacetDef { name: string; type: string; required: boolean; hasDefault: boolean; }

/** Declared facets for a pattern, read straight from _fields. */
function facetDefs(ctx: DataContext, pattern: string): FacetDef[] {
  return (ctx.db.exec(
    "SELECT name, type, required, default_value FROM _fields WHERE object_name = ? ORDER BY id", pattern
  ).toArray() as any[]).map((r) => ({
    name: r.name as string,
    type: r.type as string,
    required: !!r.required,
    hasDefault: r.default_value != null,
  }));
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

const AGG_FNS = new Set(["count", "sum", "avg", "min", "max"]);
const ALIAS_RE = /^[a-z_][a-z0-9_]*$/i;
// strftime formats for date bucketing — group a datetime facet by calendar period.
const BUCKET_FORMATS: Record<string, string> = {
  day: "%Y-%m-%d", week: "%Y-W%W", month: "%Y-%m", year: "%Y",
};

interface AggSpec { fn: string; facet?: string; as?: string; }

export function query(
  ctx: DataContext,
  patternName: string,
  filterJson: string,
  facets: string,
  sortField: string,
  limit: number,
  countOnly: boolean,
  groupBy: string = "",
  aggregateJson: string = "",
): string {
  // Read boundary, symmetric with the write boundary below: an untrusted/served
  // context can't read a kernel pattern. Fail-closed — a serve path that forgets
  // to mark itself trusted gets the safe (refused) behavior, not full access.
  if (!ctx.trusted && isKernelPattern(patternName))
    return errorJson(`Pattern "${patternName}" is not readable on a public/served surface.`);

  if (!ctx.patternExists(patternName))
    return errorJson(`Pattern "${patternName}" does not exist.${suggestPattern(patternName, ctx)}`);

  // Aggregation: GROUP BY + aggregate functions. This is the analysis verb —
  // compute over rows rather than fetch them. Triggered by either group_by or
  // an aggregate spec; the two compose (e.g. sum(amount) grouped by category).
  if (groupBy || aggregateJson) {
    return aggregate(ctx, patternName, filterJson, groupBy, aggregateJson, sortField, limit);
  }

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

// === Aggregate ===
//
// SELECT <group exprs>, <agg exprs> FROM pattern WHERE ... GROUP BY <group exprs>.
// Every facet name is validated against the real columns before interpolation
// (identifiers can't be bound), aggregate functions against a fixed whitelist,
// and aliases against ALIAS_RE — so nothing user-supplied reaches SQL unchecked.
function aggregate(
  ctx: DataContext,
  patternName: string,
  filterJson: string,
  groupBy: string,
  aggregateJson: string,
  sortField: string,
  limit: number,
): string {
  // Group dimensions: bare "facet" or "facet:unit" for date bucketing.
  const groupExprs: { expr: string; alias: string }[] = [];
  for (const raw of groupBy.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [facet, unit] = raw.split(":");
    if (!isValidColumn(ctx, patternName, facet))
      return errorJson(`Cannot group by unknown facet "${facet}" on "${patternName}".${suggestFacet(facet, patternName, ctx)}`);
    if (unit !== undefined) {
      const fmt = BUCKET_FORMATS[unit];
      if (!fmt) return errorJson(`Unknown bucket unit "${unit}". Use one of: ${Object.keys(BUCKET_FORMATS).join(", ")}`);
      groupExprs.push({ expr: `strftime('${fmt}', "${facet}")`, alias: facet });
    } else {
      groupExprs.push({ expr: `"${facet}"`, alias: facet });
    }
  }

  // Aggregate measures. Default: COUNT(*) when nothing else is asked.
  let specs: AggSpec[] = [];
  if (aggregateJson) {
    try {
      const parsed = JSON.parse(aggregateJson);
      if (!Array.isArray(parsed)) return errorJson("aggregate must be an array of {fn, facet?, as?}");
      specs = parsed;
    } catch {
      return errorJson("aggregate must be valid JSON: array of {fn, facet?, as?}");
    }
  }
  if (specs.length === 0) specs = [{ fn: "count" }];

  const aggExprs: { expr: string; alias: string }[] = [];
  const usedAliases = new Set(groupExprs.map((g) => g.alias));
  for (const spec of specs) {
    const fn = String(spec.fn || "").toLowerCase();
    if (!AGG_FNS.has(fn)) return errorJson(`Unknown aggregate function "${spec.fn}". Use: ${[...AGG_FNS].join(", ")}`);
    let expr: string, defaultAlias: string;
    if (fn === "count" && !spec.facet) {
      expr = "COUNT(*)";
      defaultAlias = "count";
    } else {
      if (!spec.facet) return errorJson(`Aggregate "${fn}" requires a facet`);
      if (!isValidColumn(ctx, patternName, spec.facet))
        return errorJson(`Cannot aggregate unknown facet "${spec.facet}" on "${patternName}".${suggestFacet(spec.facet, patternName, ctx)}`);
      expr = `${fn.toUpperCase()}("${spec.facet}")`;
      defaultAlias = `${fn}_${spec.facet}`;
    }
    const alias = spec.as ?? defaultAlias;
    if (!ALIAS_RE.test(alias)) return errorJson(`Invalid aggregate alias "${alias}". Use letters, digits, underscores.`);
    if (usedAliases.has(alias)) return errorJson(`Duplicate output name "${alias}" — set distinct "as" aliases.`);
    usedAliases.add(alias);
    aggExprs.push({ expr, alias });
  }

  const selectParts = [...groupExprs, ...aggExprs].map((e) => `${e.expr} AS "${e.alias}"`);
  let sql = `SELECT ${selectParts.join(", ")} FROM "${patternName}" WHERE archived_at IS NULL`;

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

  if (groupExprs.length) sql += ` GROUP BY ${groupExprs.map((g) => g.expr).join(", ")}`;

  // Sort by any output column (group alias or aggregate alias).
  if (sortField) {
    const desc = sortField.startsWith("-");
    const col = desc ? sortField.slice(1) : sortField;
    if (!usedAliases.has(col))
      return errorJson(`Cannot sort by "${col}" — not in this aggregate's output. Available: ${[...usedAliases].join(", ")}`);
    sql += ` ORDER BY "${col}" ${desc ? "DESC" : "ASC"}`;
  }

  sql += ` LIMIT ${Math.min(limit || 100, LIMITS.QUERY_ROWS)}`;

  try {
    const rows = ctx.db.exec(sql, ...bindings).toArray();
    return JSON.stringify({
      pattern: patternName,
      aggregate: true,
      group_by: groupExprs.map((g) => g.alias),
      rows,
      count: rows.length,
    }, null, 2);
  } catch (err: any) {
    return errorJson(`Aggregate failed: ${err.message}`);
  }
}

// === Mutate ===

export function executeMutate(ctx: DataContext, patternName: string, operation: string, data: any): any {
  if (!ctx.patternExists(patternName))
    return { error: true, message: `Pattern "${patternName}" does not exist.${suggestPattern(patternName, ctx)}` };

  // System-managed caches/audit logs are never agent-writable (e.g. _web_cache
  // poisoning → resolve() serving planted content). Internal writers use direct
  // SQL, not this path.
  if (isInternalWriteProtected(patternName))
    return { error: true, message: `"${patternName}" is managed by the system and cannot be modified directly.` };

  // Untrusted write paths (public HTTP ingress) enter below the MCP consent
  // layer, so the engine itself confines them to user patterns — every kernel
  // target (System, Open, or Consent) is refused here, at the one chokepoint all
  // engine writes cross, rather than re-checked at each entry point.
  if (!ctx.trusted && !isValidWriteTarget(patternName))
    return { error: true, message: `Pattern "${patternName}" is not a writable user pattern — ingress/upload write user patterns only.` };

  // Attribution is system-set from the session actor, never caller-supplied —
  // strip any forged created_by/updated_by before processing.
  delete (data as any).created_by;
  delete (data as any).updated_by;

  // Kernel rules (immutable fields, create hooks)
  const kernelCtx: KernelContext = {
    patternExists: (name) => ctx.patternExists(name),
    facetMeta: (pattern, facet) => ctx.facetMeta(pattern, facet),
    entryExists: (pattern, id) => ctx.entryExists(pattern, id),
    memberActive: (label) =>
      ctx.db.exec(
        `SELECT 1 FROM "_members" WHERE label = ? AND status = 'active' AND archived_at IS NULL`,
        label
      ).toArray().length > 0,
    entryField: (pattern, id, field) => {
      // pattern/field are interpolated (identifiers can't be bound); guard them.
      // Callers pass trusted literals, but validate as defense in depth.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pattern) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) return null;
      try {
        const row = ctx.db.exec(`SELECT "${field}" AS v FROM "${pattern}" WHERE id = ?`, id).toArray()[0];
        return row ? row.v : null;
      } catch {
        return null;
      }
    },
  };
  const ruled = applyKernelRules(patternName, operation, data, kernelCtx);
  if ('error' in ruled) return ruled;
  data = ruled;

  // Size guard + facet validation
  if (operation === "create" || operation === "update") {
    const size = estimateRecordBytes(data);
    if (size > LIMITS.ENTRY_BYTES)
      return { error: true, message: `Entry too large: ~${Math.round(size / 1024)}KB exceeds the 1MB limit` };

    const isDataset = ctx.patternClass(patternName) === "dataset";

    for (const [key, val] of Object.entries(data)) {
      if (STRUCTURAL_KERNEL_COLUMNS.includes(key)) continue;
      const meta = ctx.facetMeta(patternName, key);
      if (!meta)
        return { error: true, message: `Facet "${key}" does not exist on "${patternName}".${suggestFacet(key, patternName, ctx)}` };
      if (val != null && meta.options && !meta.options.includes(String(val)))
        return { error: true, message: `Invalid value "${val}" for "${key}". Options: ${meta.options.join(", ")}` };

      // Dataset patterns enforce types: coerce to canonical form or reject.
      // Knowledge patterns leave the value untouched (types stay advisory).
      if (isDataset && val != null) {
        const validate = FACET_VALIDATORS[meta.type];
        if (validate) {
          const r = validate(val);
          if (!r.ok)
            return { error: true, message: `Invalid value for "${key}" on dataset "${patternName}" (${meta.type}): ${r.error}` };
          data[key] = r.value;
        }
      }
    }

    // Required-field enforcement for datasets: a clean message before SQL's
    // NOT NULL would reject it. On create, every required facet without a
    // default must be present; on update, a required facet can't be cleared.
    if (isDataset) {
      for (const def of facetDefs(ctx, patternName)) {
        if (!def.required) continue;
        const present = Object.prototype.hasOwnProperty.call(data, def.name);
        const empty = data[def.name] == null || data[def.name] === "";
        if (operation === "create" && !def.hasDefault && (!present || empty))
          return { error: true, message: `Facet "${def.name}" is required on dataset "${patternName}".` };
        if (operation === "update" && present && empty)
          return { error: true, message: `Facet "${def.name}" is required on dataset "${patternName}" and cannot be cleared.` };
      }
    }
  }

  try {
    switch (operation) {
      case "create": {
        // Exclusive-facet advisory (memory policy): the pattern declares this
        // facet single-valued-per-value, and an active entry already holds it.
        // Checked before the insert so the advisory never matches the new row.
        let overlap: { pattern: string; id: number; uri: string; reason: string; facet: string }[] | undefined;
        if (!isKernelPattern(patternName)) {
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

        const fields = Object.keys(data).filter((k) => !CALLER_EXCLUDED_ON_CREATE.has(k));
        // Attribution: stamp created_by + updated_by from the session actor.
        const cols = [...fields.map((f) => `"${f}"`), `"created_by"`, `"updated_by"`].join(", ");
        const placeholders = [...fields, "_cb", "_ub"].map(() => "?").join(", ");
        const values = [...fields.map((f) => data[f]), ctx.actor, ctx.actor];

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

        // NOT the kernel column set: this is the write-path immutable-on-update
        // slice. updated_at is reset by SQL, created_by is untouched, and
        // updated_by is appended below — so they are deliberately writable here
        // and excluded from this strip list. version is stripped only when it's
        // the kernel auto-increment (optimistic-lock check below reads it raw).
        const stripCols = ["id", "created_at", "archived_at"];
        if (kernelVersion) stripCols.push("version");
        const fields = Object.keys(data).filter((k) => !stripCols.includes(k));
        if (fields.length === 0) return { error: true, message: "No facets to update" };

        const sets = fields.map((f) => `"${f}" = ?`).join(", ");
        const values = fields.map((f) => data[f]);
        values.push(ctx.actor); // updated_by — bound right after the SET facets

        if (kernelVersion) {
          let where = `id = ? AND archived_at IS NULL`;
          values.push(data.id);
          if (data.version != null) { where += ` AND version = ?`; values.push(data.version); }

          ctx.db.exec(
            `UPDATE "${patternName}" SET ${sets}, updated_by = ?, version = version + 1, updated_at = datetime('now') WHERE ${where}`,
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
            `UPDATE "${patternName}" SET ${sets}, updated_by = ?, updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL`,
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

        // Patch must honor field immutability exactly as update does. applyKernelRules
        // (above) only inspects top-level keys, so the patched facet — which rides in
        // data.facet, not as a key — would otherwise slip past IMMUTABLE rules (e.g.
        // repointing _inputs.target_pattern, which the create hook confines to a user
        // pattern). patch is always on an existing entry, so both immutable tables apply.
        const immErr = immutableFieldError(patternName, data.facet as string);
        if (immErr) return { error: true, message: immErr };

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
          const bindings: any[] = [patched, ctx.actor, data.id];
          let where = `id = ? AND archived_at IS NULL`;
          if (data.version != null) { where += ` AND version = ?`; bindings.push(data.version); }
          ctx.db.exec(
            `UPDATE "${patternName}" SET "${data.facet}" = ?, updated_by = ?, version = version + 1, updated_at = datetime('now') WHERE ${where}`,
            ...bindings
          );
          if (data.version != null) {
            const changes = ctx.db.exec("SELECT changes() as c").one() as { c: number };
            if (changes.c === 0)
              return { error: true, message: `Version conflict: entry ${data.id} in "${patternName}" has been modified. Re-read and retry.` };
          }
        } else {
          ctx.db.exec(
            `UPDATE "${patternName}" SET "${data.facet}" = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL`,
            patched, ctx.actor, data.id
          );
        }

        const row = ctx.db.exec(`SELECT * FROM "${patternName}" WHERE id = ?`, data.id).one();
        return { operation: "patch", pattern: patternName, entry: row, uri: uri(`entry/${patternName}/${data.id}`) };
      }

      case "archive": {
        if (!data.id) return { error: true, message: "id is required for archive" };
        ctx.db.exec(
          `UPDATE "${patternName}" SET archived_at = datetime('now'), updated_at = datetime('now'), updated_by = ? WHERE id = ? AND archived_at IS NULL`,
          ctx.actor, data.id
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
          `UPDATE "_links" SET archived_at = datetime('now'), updated_at = datetime('now'), updated_by = ? WHERE id = ?`, ctx.actor, links[0].id
        );
        return { operation: "unlink", pattern: "_links", id: links[0].id, source: `${sp}/${si}`, target: `${tp}/${ti}` };
      }

      case "unarchive": {
        if (!data.id) return { error: true, message: "id is required for unarchive" };
        ctx.db.exec(
          `UPDATE "${patternName}" SET archived_at = NULL, updated_at = datetime('now'), updated_by = ? WHERE id = ? AND archived_at IS NOT NULL`,
          ctx.actor, data.id
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
  let targetObjects = objectsJson
    ? JSON.parse(objectsJson) as string[]
    : (ctx.db.exec("SELECT name FROM _objects ORDER BY name").toArray() as any[]).map((r: any) => r.name);

  // Served/untrusted full-text search may never surface kernel patterns
  // (secrets/roster/control tables) — mirror prime's kernel exclusion. An
  // explicit served search naming only kernel targets simply returns nothing.
  if (!ctx.trusted) targetObjects = targetObjects.filter((name: string) => !isKernelPattern(name));

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
