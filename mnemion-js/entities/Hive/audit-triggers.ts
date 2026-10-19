// Audit triggers — the one home for building a table's _mutation_log triggers and
// for changing a table's columns underneath them.
//
// @why A leaf (policy.ts + sql.ts only) so every module that alters a table's
// columns — schema.ts boot, evolution.ts change types, relations.ts's boot
// migrations — reaches the same functions without an import cycle. SQLite
// refuses DROP COLUMN on a column a trigger names, and every audited table's
// triggers name every column: dropColumn is the only sanctioned way to drop one,
// and rebuildTableWithout (its sibling) the only way to remove a column SQLite
// can't DROP at all (a foreign key). So the next migration that drops a column
// can't repeat the v18 failure (a plain DROP COLUMN on a live, audited
// `_relations`); the "trigger-safe drops" structural test holds every other
// worker file to that.

import { quoteIdent } from "../../shared/core/sql";
import { isAuditExempt, sensitiveColumns } from "./policy";

// Audit exemption (high-frequency append-only logs whose change history is the
// data itself — auditing them would just churn the bounded _mutation_log) is a
// per-pattern behavior declared in the policy registry (policy.ts), alongside
// write class, so it's covered by the same boot-time totality check.
export function ensureAuditTriggers(db: any, tableName: string): void {
  if (isAuditExempt(tableName)) return;
  let columns: string[];
  try {
    const info = db.exec(`PRAGMA table_info(${quoteIdent(tableName)})`).toArray() as any[];
    columns = info.map((c: any) => c.name as string);
  } catch {
    return;
  }
  if (columns.length === 0) return;

  // Sensitive columns are recorded as NULL in the audit log — the change history
  // must never become a side channel for a secret/redacted value (born-hashed
  // already keeps the raw out of the row, this keeps even the digest/value out of
  // _mutation_log). Derived from the one SENSITIVE_COLUMNS registry.
  const sensitive = new Set(sensitiveColumns(tableName).map((s) => s.column));
  const col = (side: "NEW" | "OLD", c: string) => sensitive.has(c) ? `'${c}', NULL` : `'${c}', ${side}.${quoteIdent(c)}`;
  const newJson = columns.map((c) => col("NEW", c)).join(", ");
  const oldJson = columns.map((c) => col("OLD", c)).join(", ");

  // ALWAYS drop + recreate, so the trigger's captured column list tracks the current
  // schema on an already-deployed hive. `CREATE TRIGGER IF NOT EXISTS` is a no-op against
  // a pre-existing trigger, so a trigger built before a column was added (e.g. the
  // created_by/updated_by attribution backfill, or a sensitive-column reclassification)
  // would permanently omit that column from _mutation_log until an unrelated rebuild. The
  // prior code only force-rebuilt for SENSITIVE tables, silently freezing every other
  // pattern's audit trigger. Recreating a trigger is cheap metadata (no table rewrite).
  for (const op of ["insert", "update", "delete"]) db.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(`_audit_${tableName}_${op}`)}`);

  db.exec(`CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`_audit_${tableName}_insert`)}
    AFTER INSERT ON ${quoteIdent(tableName)} BEGIN
      INSERT INTO _mutation_log (table_name, record_id, operation, new_data)
      VALUES ('${tableName}', NEW.id, 'INSERT', json_object(${newJson}));
    END`);

  db.exec(`CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`_audit_${tableName}_update`)}
    AFTER UPDATE ON ${quoteIdent(tableName)} BEGIN
      INSERT INTO _mutation_log (table_name, record_id, operation, old_data, new_data)
      VALUES ('${tableName}', NEW.id, 'UPDATE', json_object(${oldJson}), json_object(${newJson}));
    END`);

  db.exec(`CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`_audit_${tableName}_delete`)}
    AFTER DELETE ON ${quoteIdent(tableName)} BEGIN
      INSERT INTO _mutation_log (table_name, record_id, operation, old_data)
      VALUES ('${tableName}', OLD.id, 'DELETE', json_object(${oldJson}));
    END`);
}

/** Drop `column` from `table`, safely under its audit triggers: drop the triggers
 *  (they name every column, so SQLite would refuse the drop), drop the column,
 *  then rebuild them over the remaining columns. Idempotent: a missing column is
 *  a no-op (the triggers are still rebuilt). Throws on a real SQLite refusal
 *  (an index or foreign key on the column) — callers decide how loud to be. */
export function dropColumn(db: any, table: string, column: string): void {
  for (const op of ["insert", "update", "delete"]) db.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(`_audit_${table}_${op}`)}`);
  try {
    const cols = (db.exec(`PRAGMA table_info(${quoteIdent(table)})`).toArray() as { name: string }[]).map((c) => c.name);
    if (cols.includes(column)) db.exec(`ALTER TABLE ${quoteIdent(table)} DROP COLUMN ${quoteIdent(column)}`);
  } finally {
    ensureAuditTriggers(db, table); // never leave the table unaudited, even on a refusal
  }
}

/**
 * Rebuild `table` without `columns` — the trigger-safe way to remove a column
 * SQLite refuses to DROP (a FOREIGN KEY column, which v19 retires). The 12-step
 * rebuild, under the audit triggers: drop the triggers, create
 * `<table>__rebuild` from PRAGMA (types, NOT NULL, defaults, the INTEGER PRIMARY
 * KEY with its AUTOINCREMENT, and every foreign key not being removed), copy
 * every row and every kept column (ids, version, timestamps, archived state),
 * drop the old table, rename the new one into place, restore its indexes and
 * AUTOINCREMENT high-water mark, rebuild the triggers.
 *
 * Foreign keys stay enforced, so a table still referenced by another table's
 * foreign key can't be dropped: callers rebuild referencing tables first
 * (relations.ts orders v19 that way). Crash-safe across boots (boot isn't one
 * transaction): a leftover `<table>__rebuild` beside the original is an
 * unfinished copy and is discarded; one WITHOUT the original means the swap was
 * interrupted after the drop, and is renamed into place.
 */
export function rebuildTableWithout(db: any, table: string, columns: string[]): void {
  const t = quoteIdent(table);
  const tmpName = `${table}__rebuild`;
  const tmp = quoteIdent(tmpName);
  const exists = (name: string) => db.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name).toArray().length > 0;
  if (exists(tmpName)) {
    if (exists(table)) db.exec(`DROP TABLE ${tmp}`);
    else db.exec(`ALTER TABLE ${tmp} RENAME TO ${t}`);
  }

  const info = db.exec(`PRAGMA table_info(${t})`).toArray() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];
  const drop = new Set(columns.filter((c) => info.some((i) => i.name === c)));
  if (!drop.size) { ensureAuditTriggers(db, table); return; }

  const ddl = (db.exec(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, table).toArray()[0] as any)?.sql ?? "";
  const fks = db.exec(`PRAGMA foreign_key_list(${t})`).toArray() as { table: string; from: string; to: string | null }[];
  const kept = info.filter((c) => !drop.has(c.name));
  const defs = kept.map((c) => {
    let d = `${quoteIdent(c.name)} ${c.type}`.trim();
    if (c.pk) d += ` PRIMARY KEY${/AUTOINCREMENT/i.test(ddl) ? " AUTOINCREMENT" : ""}`;
    if (c.notnull && !c.pk) d += " NOT NULL";
    if (c.dflt_value != null) d += ` DEFAULT (${c.dflt_value})`;
    const fk = fks.find((f) => f.from === c.name);
    if (fk) d += ` REFERENCES ${quoteIdent(fk.table)}(${quoteIdent(fk.to ?? "id")})`;
    return d;
  });
  const indexes = (db.exec(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`, table).toArray() as { sql: string }[])
    .map((r) => r.sql).filter((sql) => ![...drop].some((c) => sql.includes(`"${c}"`)));
  const seq = (() => { try { return (db.exec(`SELECT seq FROM sqlite_sequence WHERE name = ?`, table).toArray()[0] as any)?.seq ?? null; } catch { return null; } })();
  const cols = kept.map((c) => quoteIdent(c.name)).join(", ");

  for (const op of ["insert", "update", "delete"]) db.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(`_audit_${table}_${op}`)}`);
  try {
    db.exec(`CREATE TABLE ${tmp} (\n  ${defs.join(",\n  ")}\n)`);
    db.exec(`INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${t}`);
    db.exec(`DROP TABLE ${t}`);
    db.exec(`ALTER TABLE ${tmp} RENAME TO ${t}`);
    for (const sql of indexes) db.exec(sql);
    if (seq != null) { try { db.exec(`UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?`, seq, table); } catch { /* best-effort */ } }
  } finally {
    if (exists(table)) ensureAuditTriggers(db, table); // never leave the table unaudited
  }
}
