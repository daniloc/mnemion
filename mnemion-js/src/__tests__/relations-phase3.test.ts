// Relations Phase 3 — acceptance tests (project-docs/relations.md, "Migration →
// Phase 3", §7, owner decision O5; shapes pinned in "Interface (Phase 3)").
//
//   1. Reference facets retire: create_pattern/add_facet refuse `links`; every
//      reader of `references_object` drops it; the fork migration turns each
//      existing reference facet into a legacy relation plus links, rebuilds the
//      table without the column, and records a restore point first.
//   2. Web relation surfaces as pure, worker-tested modules
//      (shared/core/relation-view.ts): create-form relation fields, the `_relate`
//      payload builder, and the grouped entry-relations view.
//   3. The `reference` format retires from the format palette.
//
// The new module is reached through import.meta.glob so this file loads (and the
// behavioral tests fail on assertions) before it exists.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";
import { initializeSchema, ensureAuditTriggers } from "../../entities/Hive/schema";
import { FORMAT_IDS, isFormat, resolveFormat, validateFormatsMap } from "../../shared/core/format-palette";

type Store = DurableObjectStub<HiveDO>;

const RELATION_VIEW_PATH = "../../shared/core/relation-view.ts";
const RELATION_VIEW = import.meta.glob("../../shared/core/relation-view.ts", { eager: true }) as Record<string, any>;
const rv = () => {
  const mod = RELATION_VIEW[RELATION_VIEW_PATH];
  if (!mod) throw new Error("shared/core/relation-view.ts must exist and export createRelationFields, buildRelatePayload, entryRelationsView");
  return mod;
};

// === Helpers ===

function getStore(): Store {
  return env.MNEMION_HIVE.get(env.MNEMION_HIVE.idFromName(`relations-p3:${crypto.randomUUID()}`));
}

async function createPattern(store: Store, name: string, facets: Record<string, unknown>[] = [{ name: "title", type: "text" }], patternClass: "dataset" | "knowledge" = "dataset") {
  const p = JSON.parse(await store.proposeChange(`Create ${name}`, JSON.stringify({
    type: "create_pattern", pattern_name: name, pattern_description: `Test pattern ${name}`,
    doctrine: `Test doctrine for ${name}`, pattern_class: patternClass, facets,
  })));
  if (p.error) throw new Error(p.message);
  const a = JSON.parse(await store.applyChange(p.change_id));
  if (a.error) throw new Error(a.message);
}

const mut = (store: Store, pattern: string, op: string, data: Record<string, unknown>) =>
  store.mutate(pattern, op, JSON.stringify(data)).then(JSON.parse);

async function entry(store: Store, pattern: string, data: Record<string, unknown>): Promise<number> {
  const r = await mut(store, pattern, "create", data);
  if (r.error) throw new Error(r.message);
  return r.entry.id as number;
}

async function sql(store: Store, q: string, ...params: unknown[]): Promise<any[]> {
  return runInDurableObject(store, (_i, state) => state.storage.sql.exec(q, ...params).toArray() as any[]);
}

async function boot(store: Store): Promise<void> {
  await runInDurableObject(store, (_i, state) => { initializeSchema(state.storage.sql, env); });
}

const propose = async (store: Store, change: Record<string, unknown>) =>
  JSON.parse(await store.proposeChange(`test ${change.type}`, JSON.stringify(change)));
const apply = async (store: Store, id: string) => JSON.parse(await store.applyChange(id));

const DESC = (name: string) =>
  `Test relation "${name}": the source entry stands in a specific, documented relationship to the target entry. ` +
  `Use it when no kernel default fits the connection. Example, in canonical direction: notes/1 ${name} papers/2.`;

async function declare(store: Store, spec: Record<string, unknown>) {
  const p = await propose(store, { type: "declare_relation", description: DESC(String(spec.name)), cardinality: "many", behaviors: [], ...spec });
  if (p.error) throw new Error(`declare refused: ${p.message}`);
  const a = await apply(store, p.change_id);
  if (a.error) throw new Error(`declare apply refused: ${a.message}`);
}

const columns = async (store: Store, table: string) => (await sql(store, `PRAGMA table_info("${table}")`)).map((c) => c.name as string);
const relationOf = async (store: Store, name: string) =>
  JSON.parse(await store.resolve("mnemion://relations")).relations.find((r: any) => r.name === name);

async function warnLines(fn: () => void | Promise<void>): Promise<string[]> {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await fn();
    return warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n").split("\n");
  } finally { warn.mockRestore(); }
}

/**
 * Plant a pre-Phase-3 reference facet the way an old create_pattern left it: an
 * INTEGER column with a REFERENCES clause plus a `_fields` row carrying
 * `references_object`. Runs inside the live DO without re-booting, so the facet
 * exists until the next boot migrates it.
 */
async function plantReferenceFacet(store: Store, pattern: string, facet: string, target: string, values: Record<number, number | null> = {}) {
  await runInDurableObject(store, (_i, state) => {
    const db = state.storage.sql;
    db.exec(`ALTER TABLE "${pattern}" ADD COLUMN "${facet}" INTEGER REFERENCES "${target}"("id")`);
    db.exec(`INSERT INTO _fields (object_name, name, type, required, references_object) VALUES (?, ?, 'integer', 0, ?)`, pattern, facet, target);
    for (const [id, v] of Object.entries(values)) db.exec(`UPDATE "${pattern}" SET "${facet}" = ? WHERE id = ?`, v, Number(id));
    productionTriggers(db, pattern, facet);
  });
}

/** Production shape (lesson of the v18 incident, 2026-10-19): on a deployed hive
 *  every boot rebuilt the pattern's audit triggers over ALL its columns, so they
 *  name the reference-facet column, and SQLite refuses DROP COLUMN on a column a
 *  trigger references. Build them as production had, and prove the fixture
 *  reproduces it. */
function productionTriggers(db: any, pattern: string, facet: string) {
  ensureAuditTriggers(db, pattern);
  const triggerSql = (db.exec(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`, pattern).toArray() as any[]).map((r) => r.sql).join("\n");
  expect(triggerSql, `fixture reproduces production: a ${pattern} audit trigger names ${facet}`).toContain(`"${facet}"`);
}

/** Triggers on `pattern` after a boot: they must exist and must not name `facet`. */
async function triggersAfter(store: Store, pattern: string, facet: string) {
  const triggerSql = (await sql(store, `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`, pattern)).map((r) => r.sql).join("\n");
  expect(triggerSql, `${pattern}'s audit triggers exist again`).toMatch(new RegExp(`_audit_${pattern}_`));
  expect(triggerSql, `${pattern}'s audit triggers no longer name ${facet}`).not.toContain(`"${facet}"`);
}

/** Boot, and require that no migration reported failure (a failed migration warns
 *  and boot carries on, which is how the v18 incident hid). */
async function bootMigrating(store: Store): Promise<string[]> {
  const lines = await warnLines(() => boot(store));
  expect(lines.filter((l) => /migration failed/i.test(l)), "no migration failed").toEqual([]);
  return lines;
}

/** A whole pre-Phase-3 pattern whose reference facet is NOT NULL (an old
 *  create_pattern with `required: true, links`). Built raw: SQLite can't ADD a
 *  NOT NULL REFERENCES column to an existing table. Returns the row ids. */
async function plantMandatoryFkPattern(store: Store, pattern: string, facet: string, target: string, values: number[]): Promise<number[]> {
  return runInDurableObject(store, (_i, state) => {
    const db = state.storage.sql;
    db.exec(`CREATE TABLE "${pattern}" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "title" TEXT,
      "${facet}" INTEGER NOT NULL REFERENCES "${target}"("id"),
      version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT,
      archived_at TEXT
    )`);
    db.exec(`INSERT INTO _objects (name, description, doctrine, pattern_class) VALUES (?, 'planted', 'planted', 'dataset')`, pattern);
    db.exec(`INSERT INTO _fields (object_name, name, type, required) VALUES (?, 'title', 'text', 0)`, pattern);
    db.exec(`INSERT INTO _fields (object_name, name, type, required, references_object) VALUES (?, ?, 'integer', 1, ?)`, pattern, facet, target);
    const ids: number[] = [];
    for (const v of values) {
      db.exec(`INSERT INTO "${pattern}" (title, "${facet}") VALUES ('row', ?)`, v);
      ids.push((db.exec(`SELECT last_insert_rowid() AS id`).one() as { id: number }).id);
    }
    productionTriggers(db, pattern, facet);
    return ids;
  });
}

async function amendP3(store: Store, change: Record<string, unknown>) {
  const p = await propose(store, { type: "amend_relation", ...change });
  if (p.error) return p;
  return apply(store, p.change_id);
}

/** A hive with a pre-Phase-3 reference facet tasks.goal_id → goals, values set. */
async function legacyFkHive() {
  const store = getStore();
  await createPattern(store, "goals");
  await createPattern(store, "tasks");
  const g1 = await entry(store, "goals", { title: "g1" });
  const g2 = await entry(store, "goals", { title: "g2" });
  const t1 = await entry(store, "tasks", { title: "t1" });
  const t2 = await entry(store, "tasks", { title: "t2" });
  const t3 = await entry(store, "tasks", { title: "t3 (no goal)" });
  const t4 = await entry(store, "tasks", { title: "t4 (archived)" });
  await plantReferenceFacet(store, "tasks", "goal_id", "goals", { [t1]: g1, [t2]: g2, [t3]: null, [t4]: g1 });
  await mut(store, "tasks", "archive", { id: t4 });   // an archived source…
  await mut(store, "goals", "archive", { id: g2 });   // …and an archived target: both links come over, dormant
  return { store, g1, g2, t1, t2, t3, t4 };
}

// =====================================================================
// 1. Reference facets retire
// =====================================================================

describe("reference facets retired", () => {
  it("create_pattern and add_facet refuse the `links` option, pointing to declare_relation", async () => {
    const store = getStore();
    await createPattern(store, "goals");
    const c = await propose(store, {
      type: "create_pattern", pattern_name: "plans", pattern_description: "x", doctrine: "x",
      facets: [{ name: "title", type: "text" }, { name: "goal_id", type: "integer", links: { pattern: "goals" } }],
    });
    expect(c.error).toBe(true);
    expect(c.message).toContain("declare_relation");
    expect(await sql(store, `SELECT name FROM _objects WHERE name = 'plans'`)).toEqual([]);

    await createPattern(store, "plans");
    const f = await propose(store, { type: "add_facet", pattern_name: "plans", facets: [{ name: "goal_id", type: "integer", links: { pattern: "goals" } }] });
    expect(f.error).toBe(true);
    expect(f.message).toContain("declare_relation");
    expect(await columns(store, "plans")).not.toContain("goal_id");
  });

  it("no reader reports `links` for a facet: schema, index and export ignore references_object", async () => {
    const store = getStore();
    await createPattern(store, "goals");
    await createPattern(store, "tasks", [{ name: "title", type: "text" }, { name: "goal_ref", type: "integer" }]);
    // A stale references_object row, planted without a boot: no reader may surface it.
    await sql(store, `UPDATE _fields SET references_object = 'goals' WHERE object_name = 'tasks' AND name = 'goal_ref'`);
    const schema = JSON.parse(await store.getSchema("tasks"));
    expect(schema.facets.find((f: any) => f.name === "goal_ref")).not.toHaveProperty("links");
    const index = JSON.parse(await store.getIndex());
    expect(index.patterns.find((p: any) => p.name === "tasks").facets.find((f: any) => f.name === "goal_ref")).not.toHaveProperty("links");
    const exported = await store.exportPattern("tasks");
    expect(exported.meta.facets.find((f: any) => f.name === "goal_ref")).not.toHaveProperty("links");
  });

  it("followLinks no longer follows a facet value: only _links connect entries", async () => {
    const store = getStore();
    await createPattern(store, "goals");
    await createPattern(store, "tasks", [{ name: "title", type: "text" }, { name: "goal_ref", type: "integer" }]);
    const g = await entry(store, "goals", { title: "g" });
    const t = await entry(store, "tasks", { title: "t", goal_ref: g });
    await sql(store, `UPDATE _fields SET references_object = 'goals' WHERE object_name = 'tasks' AND name = 'goal_ref'`);
    const r = JSON.parse(await store.resolve(`mnemion://entry/tasks/${t}`));
    expect((r.linked ?? []).some((l: any) => l.pattern === "goals" && l.id === g)).toBe(false);
  });

  it("archive_pattern's impact no longer reports referencing facets", async () => {
    const store = getStore();
    await createPattern(store, "goals");
    await createPattern(store, "tasks", [{ name: "title", type: "text" }, { name: "goal_ref", type: "integer" }]);
    await sql(store, `UPDATE _fields SET references_object = 'goals' WHERE object_name = 'tasks' AND name = 'goal_ref'`);
    const p = await propose(store, { type: "archive_pattern", pattern_name: "goals" });
    expect(p.error).toBeUndefined();
    expect(p.preview.impact?.referencing_facets).toBeUndefined();
  });

  it("findStoredDerivedAggregates reads containment relations, not references_object", async () => {
    const { findStoredDerivedAggregates } = await import("../../entities/Hive/schema");
    // Declared explicit containment: lists retains items.
    const s1 = getStore();
    await createPattern(s1, "lists", [{ name: "title", type: "text" }, { name: "item_count", type: "number" }]);
    await createPattern(s1, "items");
    await declare(s1, { name: "listed-in", inverse: "lists-item", source: ["items"], target: ["lists"], behaviors: ["containment"] });
    const v1 = await runInDurableObject(s1, (_i, state) => findStoredDerivedAggregates(state.storage.sql));
    expect(v1.some((v) => v.includes(`"lists".item_count`)), "declared containment flags the stored count").toBe(true);

    // A `*` containment relation (kernel part-of) counts where active links show it.
    const s2 = getStore();
    await createPattern(s2, "lists", [{ name: "title", type: "text" }, { name: "item_count", type: "number" }]);
    await createPattern(s2, "items");
    const l = await entry(s2, "lists", { title: "l" });
    const i = await entry(s2, "items", { title: "i" });
    expect((await mut(s2, "link", "create", { source: `items/${i}`, target: `lists/${l}`, label: "part-of" })).error).toBeUndefined();
    const v2 = await runInDurableObject(s2, (_i, state) => findStoredDerivedAggregates(state.storage.sql));
    expect(v2.some((v) => v.includes(`"lists".item_count`)), "active part-of links flag it").toBe(true);

    // A non-containment relation, or a stale references_object, never does.
    const s3 = getStore();
    await createPattern(s3, "lists", [{ name: "title", type: "text" }, { name: "item_count", type: "number" }]);
    await createPattern(s3, "items", [{ name: "title", type: "text" }, { name: "list_ref", type: "integer" }]);
    await declare(s3, { name: "mentions-list", inverse: "list-mentioned-by", source: ["items"], target: ["lists"] });
    await sql(s3, `UPDATE _fields SET references_object = 'lists' WHERE object_name = 'items' AND name = 'list_ref'`);
    const v3 = await runInDurableObject(s3, (_i, state) => findStoredDerivedAggregates(state.storage.sql));
    expect(v3.some((v) => v.includes("lists")), "no containment → silent").toBe(false);
  });
});

// =====================================================================
// 1b. The fork migration (v19)
// =====================================================================

describe("reference facet migration", () => {
  it("turns each reference facet into a legacy relation plus links, and rebuilds the table without the column", async () => {
    const { store, g1, g2, t1, t2, t3, t4 } = await legacyFkHive();
    const before = await sql(store, `SELECT id, title, created_at, archived_at, version FROM tasks ORDER BY id`);
    await bootMigrating(store); // (a) v19 completes on a production-shaped hive

    // The relation: named after the facet, tasks → goals, cardinality one, legacy debt.
    // D-P3-1: named after the facet in kebab-case (goal_id → goal-id).
    const rel = await relationOf(store, "goal-id");
    expect(rel).toMatchObject({ name: "goal-id", inverse: "goal-id-inverse", source: ["tasks"], target: ["goals"], cardinality: "one", required: false, kernel: false, legacy: true });
    expect(rel.legacy_debt).toEqual(["placeholder description", "generated inverse"]);

    // The links: one per non-null value, archived sources and targets included (dormant).
    const links = await sql(store, `SELECT source_id, target_pattern, target_id FROM "_links" WHERE archived_at IS NULL AND label = 'goal-id' ORDER BY source_id`);
    expect(links.map((l) => `${l.source_id}->${l.target_pattern}/${l.target_id}`)).toEqual([`${t1}->goals/${g1}`, `${t2}->goals/${g2}`, `${t4}->goals/${g1}`]);
    expect(links.some((l) => l.source_id === t3)).toBe(false);

    // The table: rebuilt without the column, every other value intact.
    expect(await columns(store, "tasks")).not.toContain("goal_id");
    expect(await sql(store, `SELECT id, title, created_at, archived_at, version FROM tasks ORDER BY id`)).toEqual(before);
    expect(await sql(store, `SELECT name FROM _fields WHERE references_object IS NOT NULL`)).toEqual([]);
    expect(await sql(store, `SELECT name FROM _fields WHERE object_name = 'tasks' AND name = 'goal_id'`)).toEqual([]);
    const fkTables = (await sql(store, `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'`))
      .filter((t) => /REFERENCES/i.test(String(t.sql))).map((t) => t.name);
    expect(fkTables).toEqual([]);

    // Audit triggers exist again and no longer name the dropped column.
    await triggersAfter(store, "tasks", "goal_id");

    // (b) The audit trail still works: updating a MIGRATED row writes a _mutation_log entry.
    const logged = async () => (await sql(store, `SELECT id, new_data FROM _mutation_log WHERE table_name = 'tasks' AND record_id = ? AND operation = 'UPDATE' ORDER BY id`, t1));
    const beforeLog = (await logged()).length;
    expect((await mut(store, "tasks", "update", { id: t1, title: "t1, edited after the rebuild" })).error).toBeUndefined();
    const afterLog = await logged();
    expect(afterLog.length, "the update was audited").toBe(beforeLog + 1);
    expect(String(afterLog[afterLog.length - 1].new_data)).toContain("t1, edited after the rebuild");
    expect(String(afterLog[afterLog.length - 1].new_data)).not.toContain("goal_id");

    // The pattern stays fully writable.
    const t5 = await entry(store, "tasks", { title: "after" });
    expect((await mut(store, "tasks", "update", { id: t5, title: "after, edited" })).error).toBeUndefined();
    expect((await mut(store, "tasks", "create", { title: "x", goal_id: g1 })).error).toBe(true);
  });

  it("migrates every reference facet in one pass, including one pointing at a table it also rebuilds", async () => {
    const { store, t1 } = await legacyFkHive();
    await createPattern(store, "notes");
    const n = await entry(store, "notes", { title: "n" });
    await plantReferenceFacet(store, "notes", "task_id", "tasks", { [n]: t1 });
    await bootMigrating(store); // (c) both tables carry production-shaped triggers
    expect(await columns(store, "tasks")).not.toContain("goal_id");
    expect(await columns(store, "notes")).not.toContain("task_id");
    await triggersAfter(store, "tasks", "goal_id");
    await triggersAfter(store, "notes", "task_id");
    expect(await sql(store, `SELECT source_id, target_id FROM "_links" WHERE archived_at IS NULL AND label = 'task-id'`)).toEqual([{ source_id: n, target_id: t1 }]);
  });

  it("a facet name already taken in the vocabulary becomes <pattern>-<facet>, kebab-cased", async () => {
    const store = getStore();
    await createPattern(store, "goals");
    await createPattern(store, "tasks");
    const g = await entry(store, "goals", { title: "g" });
    const t = await entry(store, "tasks", { title: "t" });
    await plantReferenceFacet(store, "tasks", "references", "goals", { [t]: g }); // collides with the kernel default
    await bootMigrating(store);
    const rel = await relationOf(store, "tasks-references");
    expect(rel).toMatchObject({ source: ["tasks"], target: ["goals"], cardinality: "one", legacy: true });
    expect(await sql(store, `SELECT label FROM "_links" WHERE archived_at IS NULL AND source_id = ? AND target_id = ?`, t, g)).toEqual([{ label: "tasks-references" }]);
  });

  // D-P3-1: migrated names obey the same kebab rule declare_relation enforces
  // (names are immutable, so they are born valid).
  it("every migrated name satisfies declare_relation's kebab-case rule", async () => {
    const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
    const store = getStore();
    await createPattern(store, "goals");
    await createPattern(store, "tasks");
    const g = await entry(store, "goals", { title: "g" });
    const t = await entry(store, "tasks", { title: "t" });
    await plantReferenceFacet(store, "tasks", "parent__goal_", "goals", { [t]: g }); // doubled and trailing underscores
    await plantReferenceFacet(store, "tasks", "_2nd_goal", "goals", { [t]: g });     // kebab form would start with a digit
    await bootMigrating(store);
    const migrated = (await sql(store, `SELECT label FROM "_links" WHERE archived_at IS NULL AND source_pattern = 'tasks' AND source_id = ?`, t)).map((r) => r.label).sort();
    expect(migrated).toEqual(["parent-goal", "tasks-2nd-goal"]);
    for (const name of migrated) {
      expect(name, `${name} is kebab-case`).toMatch(KEBAB);
      const rel = await relationOf(store, name);
      expect(rel, `${name} is declared`).toBeDefined();
      expect(rel.inverse, `${name}'s inverse is kebab-case too`).toMatch(KEBAB);
    }
  });

  // D-P3-2: a NOT NULL reference facet migrates OPTIONAL, with a third debt fact.
  it("a mandatory (NOT NULL) reference facet migrates as an optional relation carrying `was mandatory` debt", async () => {
    const store = getStore();
    await createPattern(store, "goals");
    const g = await entry(store, "goals", { title: "g" });
    const ids = await plantMandatoryFkPattern(store, "plans", "goal_id", "goals", [g, g]);
    const lines = await warnLines(() => boot(store));
    expect(lines.filter((l) => /migration failed/i.test(l)), "no migration failed").toEqual([]);
    await triggersAfter(store, "plans", "goal_id");

    const rel = await relationOf(store, "goal-id");
    expect(rel).toMatchObject({ required: false, legacy: true });
    expect(rel.legacy_debt).toEqual(["placeholder description", "generated inverse", "was mandatory"]);
    expect(lines.some((l) => /goal-id: .*was mandatory, consider required/.test(l)), lines.join(" | ")).toBe(true);
    expect((await sql(store, `SELECT source_id FROM "_links" WHERE archived_at IS NULL AND label = 'goal-id' ORDER BY source_id`)).map((r) => r.source_id)).toEqual(ids);
    expect(await columns(store, "plans")).not.toContain("goal_id");
    // The fact survives later boots (it is recorded, the NOT NULL it came from is gone).
    await boot(store);
    expect((await relationOf(store, "goal-id")).legacy_debt).toContain("was mandatory");
    // A nullable reference facet never carries it.
    const { store: s2 } = await legacyFkHive();
    await boot(s2);
    expect((await relationOf(s2, "goal-id")).legacy_debt).not.toContain("was mandatory");
  });

  it("`was mandatory` clears when the owner decides: amend to required: true, or decline with required: false", async () => {
    for (const decision of [true, false]) {
      const store = getStore();
      await createPattern(store, "goals");
      const g = await entry(store, "goals", { title: "g" });
      await plantMandatoryFkPattern(store, "plans", "goal_id", "goals", [g]);
      await boot(store);
      // An amend that does not mention `required` is no decision.
      expect((await amendP3(store, { name: "goal-id", description: DESC("goal-id") })).error).toBeUndefined();
      expect((await relationOf(store, "goal-id")).legacy_debt, "description alone decides nothing").toContain("was mandatory");
      // An explicit required: true / false is the decision, either way.
      const a = await amendP3(store, { name: "goal-id", required: decision });
      expect(a.error, `required: ${decision}`).toBeUndefined();
      const rel = await relationOf(store, "goal-id");
      expect(rel.required).toBe(decision);
      expect(rel.legacy_debt, `required: ${decision}`).not.toContain("was mandatory");
      const lines = await warnLines(() => boot(store));
      expect(lines.some((l) => /was mandatory/.test(l)), `required: ${decision}`).toBe(false);
    }
  });

  // The v19 restore point (a MIGRATION_RESTORE_POINTS entry) is covered in
  // relations.test.ts's "restore point" describe, where the structural check
  // requires every entry's covering test to live. Here: none on a clean hive.
  it("a hive without reference facets records no v19 restore point", async () => {
    const clean = getStore();
    await createPattern(clean, "tasks");
    await boot(clean);
    expect(await sql(clean, `SELECT id FROM _schema_history WHERE change_type = 'restore_point' AND description LIKE '%v19%'`)).toEqual([]);
  });

  it("is idempotent: a second boot changes nothing", async () => {
    const { store } = await legacyFkHive();
    await bootMigrating(store);
    expect(await columns(store, "tasks"), "the first boot migrated").not.toContain("goal_id");
    const snap = async () => ({
      links: await sql(store, `SELECT * FROM "_links" ORDER BY id`),
      relations: await sql(store, `SELECT * FROM "_relations" ORDER BY id`),
      tasks: await sql(store, `SELECT * FROM tasks ORDER BY id`),
      fields: await sql(store, `SELECT * FROM _fields WHERE object_name = 'tasks' ORDER BY id`),
    });
    const first = await snap();
    await boot(store);
    expect(await snap()).toEqual(first);
  });

  it("clears stored `reference` facet formats, which no longer exist", async () => {
    const store = getStore();
    await createPattern(store, "tasks", [{ name: "title", type: "text" }, { name: "owner_ref", type: "integer" }]);
    await sql(store, `UPDATE _fields SET format = 'reference' WHERE object_name = 'tasks' AND name = 'owner_ref'`);
    await boot(store);
    expect(await sql(store, `SELECT name FROM _fields WHERE format = 'reference'`)).toEqual([]);
  });

  it("the dev seed declares relations instead of a reference facet", async () => {
    const store = getStore();
    await runInDurableObject(store, (_i, state) => { initializeSchema(state.storage.sql, { DEV_SEED: "true" } as any); });
    expect(await sql(store, `SELECT object_name, name FROM _fields WHERE references_object IS NOT NULL`)).toEqual([]);
    expect(await columns(store, "tasks")).not.toContain("goal_id");
    const toGoals = await sql(store, `SELECT label FROM "_links" WHERE archived_at IS NULL AND source_pattern = 'tasks' AND target_pattern = 'goals'`);
    expect(toGoals.length, "tasks still connect to goals, through links").toBeGreaterThan(0);
    // Every label the seed writes names a declared relation on the seeding boot itself…
    const names = new Set((await sql(store, `SELECT name FROM "_relations" WHERE archived_at IS NULL`)).map((r) => r.name));
    const labels = (await sql(store, `SELECT DISTINCT label FROM "_links" WHERE archived_at IS NULL`)).map((r) => r.label);
    for (const l of labels) expect(names.has(l), `seed label ${l} is declared`).toBe(true);
    // …and none of them is legacy debt.
    await boot(store);
    const rels = JSON.parse(await store.resolve("mnemion://relations")).relations;
    expect(rels.filter((r: any) => r.legacy).map((r: any) => r.name)).toEqual([]);
  });
});

// =====================================================================
// 1c. One trigger-safe path for column drops and table rebuilds
// =====================================================================

// The v18 incident: a hand-rolled DROP COLUMN under live audit triggers threw on
// production. entities/Hive/audit-triggers.ts owns the only sanctioned mechanism
// (dropColumn, plus a sibling trigger-safe table rebuild for v19's FK columns).
const WORKER_SRC = import.meta.glob(
  ["../../entities/**/*.ts", "../../shared/**/*.ts", "../../src/**/*.ts", "!../../src/__tests__/**"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;
const AUDIT_TRIGGERS_PATH = "../../entities/Hive/audit-triggers.ts";

/** Pre-existing kernel retirements and whole-table GC, each named by file and the
 *  exact literal body. None is a column drop or rebuild of a user table under its
 *  triggers. Each must still exist, so the list can't rot. */
const SANCTIONED_DROPS: [string, string][] = [
  ["../../entities/Hive/schema.ts", `ALTER TABLE "_short_term_fragments" DROP COLUMN "access_count"`], // v10, kernel
  ["../../entities/Hive/schema.ts", `DROP TABLE IF EXISTS "\${old}"`],                                  // v5 retired token tables (kernel)
  ["../../entities/Hive/schema.ts", `DROP TABLE IF EXISTS _passkeys_old`],                               // _passkeys rebuild (kernel)
  ["../../entities/Hive/schema.ts", `DROP TABLE _passkeys_old`],                                         // _passkeys rebuild (kernel)
  ["../../entities/Hive/schema.ts", `DROP TABLE IF EXISTS "_canvases"`],                                 // v16 Canvas retirement (kernel)
  ["../../entities/Hive/schema.ts", `DROP TABLE IF EXISTS \${quoteIdent(obj.name)}`],                   // 30-day archived-pattern GC: whole table and its triggers
];

/** String and template literal bodies, comments skipped. */
function literals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { const j = src.indexOf("\n", i); i = j < 0 ? n : j; continue; }
    if (c === "/" && d === "*") { const j = src.indexOf("*/", i + 2); i = j < 0 ? n : j + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1, body = "", depth = 0;
      while (j < n) {
        const ch = src[j];
        if (ch === "\\") { body += src.slice(j, j + 2); j += 2; continue; }
        if (c === "`") {
          if (depth === 0 && ch === "`") break;
          if (ch === "$" && src[j + 1] === "{") { depth++; body += "${"; j += 2; continue; }
          if (depth > 0 && ch === "{") depth++;
          if (depth > 0 && ch === "}") depth--;
        } else if (ch === c || ch === "\n") break;
        body += ch; j++;
      }
      out.push(body); i = j + 1; continue;
    }
    i++;
  }
  return out;
}

describe("trigger-safe drops", () => {
  it("no worker source outside audit-triggers.ts drops a column or a table, except the listed kernel retirements and GC", () => {
    const paths = Object.keys(WORKER_SRC);
    expect(paths, "the scan reads the worker tree").toContain(AUDIT_TRIGGERS_PATH);
    expect(paths).toContain("../../entities/Hive/schema.ts");
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const [path, src] of Object.entries(WORKER_SRC)) {
      if (path === AUDIT_TRIGGERS_PATH) continue;
      for (const lit of literals(src)) {
        if (!/\bDROP\s+COLUMN\b|\bDROP\s+TABLE\b/i.test(lit)) continue;
        const flat = lit.replace(/\s+/g, " ").trim();
        const ok = SANCTIONED_DROPS.find(([p, body]) => p === path && flat === body);
        if (ok) seen.add(ok[1]); else offenders.push(`${path}: ${flat.slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
    expect([...seen].sort(), "every sanctioned exception still exists").toEqual(SANCTIONED_DROPS.map(([, b]) => b).sort());
  });
});

// =====================================================================
// 2a. Create-form relation fields and the _relate payload
// =====================================================================

const REL = (over: Record<string, unknown>) => ({
  name: "x", inverse: "x-of", description: "d", source: ["*"], target: ["*"], cardinality: "many",
  behaviors: [], kernel: false, legacy: false, legacy_debt: [], required: false, derived: false, ...over,
});

describe("create relation fields", () => {
  it("returns one field per REQUIRED stored relation the pattern is a source of, sorted by name", () => {
    const relations = [
      REL({ name: "belongs-to", inverse: "contains", source: ["tasks"], target: ["projects"], cardinality: "one", required: true }),
      REL({ name: "assigned-to", inverse: "assigns", source: ["tasks", "bugs"], target: ["people", "teams"], required: true }),
      REL({ name: "serves", inverse: "served-by", source: ["projects"], target: ["goals"], required: true }), // other source
      REL({ name: "references", inverse: "referenced-by", kernel: true }),                                   // not required
      REL({ name: "cites", inverse: "cited-by", source: ["tasks"], target: ["papers"] }),                     // not required
      REL({ name: "addresses", inverse: "addressed-by", source: ["tasks"], target: ["goals"], derived: true, chain: ["belongs-to", "serves"] }),
      REL({ name: "owned-by", inverse: "owns", source: ["notes"], target: ["tasks"], required: true }),       // tasks only as target
    ];
    expect(rv().createRelationFields("tasks", relations)).toEqual([
      { relation: "assigned-to", target_patterns: ["people", "teams"], cardinality: "many", label: "assigned to" },
      { relation: "belongs-to", target_patterns: ["projects"], cardinality: "one", label: "belongs to" },
    ]);
    expect(rv().createRelationFields("goals", relations)).toEqual([]);
  });

  it("buildRelatePayload produces exactly the Phase 2 _relate shape", () => {
    const { buildRelatePayload } = rv();
    expect(buildRelatePayload({ "belongs-to": "projects/3" })).toEqual({ "belongs-to": "projects/3" });
    expect(buildRelatePayload({ "assigned-to": ["people/1", "teams/2"] })).toEqual({ "assigned-to": ["people/1", "teams/2"] });
    // Empty values are omitted; duplicates collapse; nothing to relate → {}.
    expect(buildRelatePayload({ a: "", b: null, c: [], d: undefined, e: ["x/1", "x/1"] } as any)).toEqual({ e: ["x/1"] });
    expect(buildRelatePayload({})).toEqual({});
  });

  it("a form built from the fields creates the entry and its links in one write", async () => {
    const store = getStore();
    await createPattern(store, "projects");
    await createPattern(store, "tasks");
    const p = await entry(store, "projects", { title: "p" });
    await declare(store, { name: "belongs-to", inverse: "contains", source: ["tasks"], target: ["projects"], cardinality: "one", required: true });
    const relations = JSON.parse(await store.resolve("mnemion://relations")).relations;
    const fields = rv().createRelationFields("tasks", relations);
    expect(fields.map((f: any) => f.relation)).toEqual(["belongs-to"]);
    const values = Object.fromEntries(fields.map((f: any) => [f.relation, `${f.target_patterns[0]}/${p}`]));
    const r = await mut(store, "tasks", "create", { title: "from the form", _relate: rv().buildRelatePayload(values) });
    expect(r.error, r.message).toBeUndefined();
    expect(r.links).toEqual([expect.objectContaining({ source: `tasks/${r.entry.id}`, target: `projects/${p}`, label: "belongs-to" })]);
  });
});

// =====================================================================
// 2b. Entry relations view (replaces reference-facet rendering)
// =====================================================================

describe("entry relations view", () => {
  const item = (o: Record<string, unknown>) => ({ uri: `mnemion://entry/${o.pattern}/${o.id}`, entry: {}, ...o });

  it("groups linked items by reader-side relation and direction, outgoing first, derived flagged", () => {
    const linked = [
      item({ pattern: "notes", id: 4, label: "part-of", direction: "in", relation: "has-part" }),
      item({ pattern: "projects", id: 1, label: "belongs-to", direction: "out", relation: "belongs-to" }),
      item({ pattern: "goals", id: 9, direction: "out", relation: "addresses", derived: true }),
      item({ pattern: "notes", id: 5, label: "part-of", direction: "in", relation: "has-part" }),
      item({ pattern: "goals", id: 8, direction: "out", relation: "addresses", derived: true }),
      item({ pattern: "papers", id: 2, label: "references", direction: "out", relation: "references" }),
    ];
    expect(rv().entryRelationsView(linked)).toEqual([
      { relation: "addresses", direction: "out", derived: true, items: [
        { pattern: "goals", id: 9, uri: "mnemion://entry/goals/9" },
        { pattern: "goals", id: 8, uri: "mnemion://entry/goals/8" },
      ] },
      { relation: "belongs-to", direction: "out", derived: false, items: [{ pattern: "projects", id: 1, uri: "mnemion://entry/projects/1" }] },
      { relation: "references", direction: "out", derived: false, items: [{ pattern: "papers", id: 2, uri: "mnemion://entry/papers/2" }] },
      { relation: "has-part", direction: "in", derived: false, items: [
        { pattern: "notes", id: 4, uri: "mnemion://entry/notes/4" },
        { pattern: "notes", id: 5, uri: "mnemion://entry/notes/5" },
      ] },
    ]);
  });

  it("is empty for no links, and accepts resolve's real output", async () => {
    expect(rv().entryRelationsView([])).toEqual([]);
    expect(rv().entryRelationsView(undefined)).toEqual([]);
    const store = getStore();
    await createPattern(store, "notes");
    const a = await entry(store, "notes", { title: "a" });
    const b = await entry(store, "notes", { title: "b" });
    await mut(store, "link", "create", { source: `notes/${a}`, target: `notes/${b}`, label: "references" });
    const linked = JSON.parse(await store.resolve(`mnemion://entry/notes/${b}`)).linked;
    expect(rv().entryRelationsView(linked)).toEqual([
      { relation: "referenced-by", direction: "in", derived: false, items: [{ pattern: "notes", id: a, uri: `mnemion://entry/notes/${a}` }] },
    ]);
  });
});

// =====================================================================
// 2c. The `reference` format retires
// =====================================================================

describe("reference format retired", () => {
  it("is gone from the palette and resolveFormat never returns it", () => {
    expect(FORMAT_IDS).not.toContain("reference");
    expect(isFormat("reference")).toBe(false);
    // The old foreign-key flag no longer selects it: the type default applies.
    expect((resolveFormat as any)(undefined, undefined, "integer", true)).toBe("number");
    // A stale stored or view-level `reference` degrades like any unknown id.
    expect(resolveFormat("reference", undefined, "integer")).toBe("number");
    expect(resolveFormat(undefined, "reference", "text")).toBe("text");
    expect(validateFormatsMap({ owner: "reference" }, null).join()).toContain("must be one of");
  });

  it("set_facet_format refuses it", async () => {
    const store = getStore();
    await createPattern(store, "tasks", [{ name: "title", type: "text" }, { name: "owner_ref", type: "integer" }]);
    const p = await propose(store, { type: "set_facet_format", pattern_name: "tasks", facet: "owner_ref", format: "reference" });
    expect(p.error).toBe(true);
  });
});
