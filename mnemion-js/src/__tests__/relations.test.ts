// Relations registry — Phase 1 acceptance tests (project-docs/relations.md).
//
// These tests are the contract for Phase 1: the `_relations` kernel pattern, the
// link write chokepoint, link immutability, supersession-by-behavior, the
// integrity sweep, resolve direction, the three relation change types, GC
// protection for linked targets, and the palette totality oracle. Every exact
// shape they assume is pinned in the "Interface (Phase 1)" appendix at the end of
// project-docs/relations.md.
//
// They drive public surfaces only: HiveDO RPC (mutate, query, proposeChange /
// applyChange, resolve / getEntry, getIndex, getStaleEntries, resolvePublication),
// the pure `prime` read path over the live DO database, and `initializeSchema`
// (inside runInDurableObject) wherever a migration, seed, sweep or GC must run.
// The one module the design names, entities/Hive/relations.ts, is reached only
// through import.meta.glob so this file loads (and the behavioral tests fail on
// assertions) before that module exists.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import { HiveDO } from "../../entities/Hive/hive";
import { initializeSchema, KERNEL_TABLES, ensureAuditTriggers } from "../../entities/Hive/schema";
import { prime, type PrimeContext } from "../../entities/Hive/prime";
// This file reads its own source to prove each palette behavior names a describe that
// exists. A ?raw default import, not import.meta.glob: Vite drops the importing file
// from its own glob results, so a self-glob is always empty.
import THIS_FILE_SRC from "./relations.test.ts?raw";
import SCHEMA_SRC from "../../entities/Hive/schema.ts?raw";
import { getAgentByName } from "agents";

type Store = DurableObjectStub<HiveDO>;

// === The design's fixed vocabulary (project-docs/relations.md, "Kernel defaults") ===

const KERNEL_DEFAULTS = [
  { name: "supersedes", inverse: "superseded-by", behaviors: ["supersession", "acyclic"] },
  { name: "references", inverse: "referenced-by", behaviors: [] as string[] },
  { name: "depends-on", inverse: "required-by", behaviors: ["acyclic"] },
  { name: "derived-from", inverse: "source-of", behaviors: ["acyclic"] },
  // Phase 2: part-of gains containment at boot refresh.
  { name: "part-of", inverse: "has-part", behaviors: ["containment", "acyclic"] },
];
const KERNEL_NAMES = KERNEL_DEFAULTS.map((k) => k.name);
const KERNEL_VOCAB = KERNEL_DEFAULTS.flatMap((k) => [k.name, k.inverse]);

/** The only kernel patterns a link may TARGET (§4a). No kernel pattern may be a source. */
const KERNEL_TARGETS = new Set(["_documents", "_web_cache"]);

// === Helpers ===

function getStore(): Store {
  const id = env.MNEMION_HIVE.idFromName(`relations:${crypto.randomUUID()}`);
  return env.MNEMION_HIVE.get(id);
}

/** Fixture patterns default to the dataset class: links behave identically on any
 *  user pattern, and datasets skip the remote embed/conflict round-trips. Tests of
 *  recall-facing behavior (prime, stale view) pass "knowledge". */
async function createPattern(store: Store, name: string, patternClass: "dataset" | "knowledge" = "dataset") {
  const p = JSON.parse(await store.proposeChange(`Create ${name}`, JSON.stringify({
    type: "create_pattern", pattern_name: name, pattern_description: `Test pattern ${name}`,
    doctrine: `Test doctrine for ${name}`, pattern_class: patternClass, facets: [{ name: "title", type: "text" }],
  })));
  if (p.error) throw new Error(p.message);
  const a = JSON.parse(await store.applyChange(p.change_id));
  if (a.error) throw new Error(a.message);
}

const mut = (store: Store, pattern: string, op: string, data: Record<string, unknown>) =>
  store.mutate(pattern, op, JSON.stringify(data)).then(JSON.parse);

/** Create an entry and return its id (throws on refusal — fixtures must succeed). */
async function entry(store: Store, pattern: string, title: string): Promise<number> {
  const r = await mut(store, pattern, "create", { title });
  if (r.error) throw new Error(r.message);
  return r.entry.id as number;
}

/** Attempt a link through the `link` shortcut. Omit `label` to send none. */
function link(store: Store, source: string, target: string, label?: string | null) {
  const data: Record<string, unknown> = { source, target };
  if (label !== undefined) data.label = label;
  return mut(store, "link", "create", data);
}

/** Create a link that must succeed; returns the stored `_links` row id. */
async function mustLink(store: Store, source: string, target: string, label: string): Promise<number> {
  const r = await link(store, source, target, label);
  if (r.error) throw new Error(`link ${source} -[${label}]-> ${target} refused: ${r.message}`);
  return r.entry.id as number;
}

async function sql(store: Store, q: string, ...params: unknown[]): Promise<any[]> {
  return runInDurableObject(store, (_i, state) => state.storage.sql.exec(q, ...params).toArray() as any[]);
}

/** Re-run the boot sequence (migrations, seeds, sweeps, GC, boot oracles). */
async function boot(store: Store): Promise<void> {
  await runInDurableObject(store, (_i, state) => { initializeSchema(state.storage.sql, env); });
}

const propose = async (store: Store, change: Record<string, unknown>) =>
  JSON.parse(await store.proposeChange(`test ${change.type}`, JSON.stringify(change)));
const apply = async (store: Store, changeId: string) => JSON.parse(await store.applyChange(changeId));

/** A description that clears the declaration quality bar (≥120 chars, not the name). */
const DESC = (name: string) =>
  `Test relation "${name}": the source entry stands in a specific, documented relationship to the target entry. ` +
  `Use it when no kernel default fits the connection. Example, in canonical direction: notes/1 ${name} papers/2.`;

interface RelSpec {
  name: string; inverse: string; source?: unknown; target?: unknown;
  cardinality?: string; behaviors?: string[]; description?: string;
  [k: string]: unknown;
}

function declareChange(spec: RelSpec): Record<string, unknown> {
  return {
    type: "declare_relation",
    description: DESC(spec.name),
    source: ["*"], target: ["*"], cardinality: "many", behaviors: [],
    ...spec,
  };
}

/** Declare a relation via propose + apply; throws if either step refuses. */
async function declare(store: Store, spec: RelSpec) {
  const p = await propose(store, declareChange(spec));
  if (p.error) throw new Error(`declare ${spec.name} refused at propose: ${p.message}`);
  const a = await apply(store, p.change_id);
  if (a.error) throw new Error(`declare ${spec.name} refused at apply: ${a.message}`);
  return a;
}

async function amend(store: Store, change: Record<string, unknown>) {
  const p = await propose(store, { type: "amend_relation", ...change });
  if (p.error) return { proposed: p, applied: null as any };
  return { proposed: p, applied: await apply(store, p.change_id) };
}

async function retire(store: Store, name: string) {
  const p = await propose(store, { type: "retire_relation", name });
  if (p.error) return { proposed: p, applied: null as any };
  return { proposed: p, applied: await apply(store, p.change_id) };
}

/** The ACTIVE `_relations` row for `name`, or undefined. */
async function relationRow(store: Store, name: string): Promise<any | undefined> {
  return (await sql(store, `SELECT * FROM "_relations" WHERE name = ? AND archived_at IS NULL`, name))[0];
}

/** A relation's legacy status as the read surface reports it (Phase 2: derived,
 *  never a stored flag): { legacy, legacy_debt }. */
async function legacyOf(store: Store, name: string): Promise<{ legacy: boolean; legacy_debt: string[] }> {
  const r = JSON.parse(await store.resolve("mnemion://relations")).relations.find((x: any) => x.name === name);
  if (!r) throw new Error(`relation ${name} not listed`);
  return { legacy: r.legacy, legacy_debt: r.legacy_debt };
}

/** `_relations.source` / `.target` / `.behaviors` are TEXT holding a JSON array (Interface §A). */
const list = (v: unknown): string[] => {
  if (typeof v !== "string") throw new Error(`expected a JSON-array TEXT column, got ${typeof v}: ${String(v)}`);
  return JSON.parse(v) as string[];
};

async function activeLinks(store: Store): Promise<any[]> {
  return sql(store, `SELECT * FROM "_links" WHERE archived_at IS NULL ORDER BY id`);
}

async function linkRow(store: Store, id: number): Promise<any> {
  return (await sql(store, `SELECT * FROM "_links" WHERE id = ?`, id))[0];
}

/** Two user patterns (notes, papers) with a few entries each — the common fixture. */
async function world(store: Store) {
  await createPattern(store, "notes");
  await createPattern(store, "papers");
  const n1 = await entry(store, "notes", "note one");
  const n2 = await entry(store, "notes", "note two");
  const n3 = await entry(store, "notes", "note three");
  const p1 = await entry(store, "papers", "paper one");
  const p2 = await entry(store, "papers", "paper two");
  return { n1, n2, n3, p1, p2 };
}

/** Insert a `_web_cache` row directly (it is system-written, never via mutate). */
async function insertWebCache(store: Store, url: string): Promise<number> {
  return runInDurableObject(store, (_i, state) => {
    state.storage.sql.exec(
      `INSERT INTO "_web_cache" (url, content, source_adapter, expires_at) VALUES (?, 'cached body', 'test', datetime('now', '-60 days'))`, url,
    );
    return (state.storage.sql.exec(`SELECT last_insert_rowid() AS id`).one() as { id: number }).id;
  });
}

async function insertDocument(store: Store, title: string): Promise<number> {
  return runInDurableObject(store, (_i, state) => {
    state.storage.sql.exec(`INSERT INTO "_documents" (title) VALUES (?)`, title);
    return (state.storage.sql.exec(`SELECT last_insert_rowid() AS id`).one() as { id: number }).id;
  });
}

const isKernel = (p: string) => p.startsWith("_");

/** Drive the real MCP layer (SessionDO: zod schemas + tool handlers) over the agents
 *  RPC transport, against the hive named `hiveId`. Returns the initialize result and
 *  a tools/call helper. */
async function mcpSession(hiveId: string) {
  const session: any = await getAgentByName(env.MCP_OBJECT as any, `rpc:${crypto.randomUUID()}`, { props: { hiveId, actor: "owner" } });
  const init = await session.handleMcpMessage({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "relations-test", version: "1" } },
  });
  await session.handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  let next = 2;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await session.handleMcpMessage({ jsonrpc: "2.0", id: next++, method: "tools/call", params: { name, arguments: args } });
    return r.result as { isError?: boolean; content: { type: string; text: string }[] };
  };
  return { init: init.result, call };
}

/** A hive stub addressed by name, so an MCP session and the test share it. */
function namedStore(hiveId: string): Store {
  return env.MNEMION_HIVE.get(env.MNEMION_HIVE.idFromName(hiveId));
}

/** Snapshot of the edge store and vocabulary, for "a second boot changes nothing". */
async function edgeSnapshot(store: Store) {
  return {
    links: await sql(store, `SELECT * FROM "_links" ORDER BY id`),
    relations: await sql(store, `SELECT * FROM "_relations" ORDER BY id`),
  };
}

/** Every console.warn line emitted while `fn` runs (one array entry per line). */
async function warnLines(fn: () => Promise<void>): Promise<string[]> {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await fn();
    return warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n").split("\n");
  } finally { warn.mockRestore(); }
}

/** True when `pattern` has an _objects row (archived or not), its table exists, and
 *  row `id` is present in it (archived or not). */
async function rowExists(store: Store, pattern: string, id: number): Promise<boolean> {
  return runInDurableObject(store, (_i, state) => {
    const db = state.storage.sql;
    if (db.exec(`SELECT 1 FROM _objects WHERE name = ?`, pattern).toArray().length === 0) return false;
    if (db.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, pattern).toArray().length === 0) return false;
    return db.exec(`SELECT 1 FROM "${pattern.replace(/"/g, '""')}" WHERE id = ?`, id).toArray().length > 0;
  });
}

/**
 * The relation-declaration-totality oracle, evaluated over the live tables:
 * every active name and inverse is unique (so a label names exactly one relation),
 * no active link is unlabeled, every ACTIVE link's label names an ACTIVE relation, its endpoints satisfy that
 * relation's source/target, both endpoint rows EXIST (present in their pattern's
 * table; an archived entry or pattern still exists, which makes the link dormant,
 * not dangling), and a cardinality-`one` relation holds at most one active link per
 * source entry. Returns human-readable violations (empty = holds).
 */
async function totalityViolations(store: Store): Promise<string[]> {
  const rels = await sql(store, `SELECT * FROM "_relations" WHERE archived_at IS NULL`);
  const byName = new Map(rels.map((r) => [r.name as string, r]));
  const out: string[] = [];
  // A label must name exactly one relation: names and inverses share one vocabulary.
  const owners = new Map<string, string[]>();
  for (const r of rels) for (const h of [r.name, r.inverse]) owners.set(h, [...(owners.get(h) ?? []), `${r.name}.${h === r.name ? "name" : "inverse"}`]);
  for (const [h, who] of owners) if (who.length > 1) out.push(`vocabulary handle "${h}" is claimed by ${who.join(", ")}`);
  const nullLabels = (await sql(store, `SELECT id FROM "_links" WHERE archived_at IS NULL AND (label IS NULL OR trim(label) = '')`)).map((r) => r.id);
  if (nullLabels.length) out.push(`active links with no label: ${nullLabels.join(", ")}`);
  const perSource = new Map<string, number>();
  for (const l of await activeLinks(store)) {
    const tag = `link ${l.id} ${l.source_pattern}/${l.source_id} -[${l.label}]-> ${l.target_pattern}/${l.target_id}`;
    const rel = byName.get(l.label);
    if (!rel) { out.push(`${tag}: label names no active relation`); continue; }
    const src = list(rel.source), tgt = list(rel.target);
    const srcOk = isKernel(l.source_pattern) ? false : (src.includes("*") || src.includes(l.source_pattern));
    const tgtOk = isKernel(l.target_pattern)
      ? KERNEL_TARGETS.has(l.target_pattern) && (tgt.includes("*") || tgt.includes(l.target_pattern))
      : (tgt.includes("*") || tgt.includes(l.target_pattern));
    for (const [end, p, id] of [["source", l.source_pattern, l.source_id], ["target", l.target_pattern, l.target_id]] as const)
      if (!(await rowExists(store, p, id))) out.push(`${tag}: ${end} ${p}/${id} does not exist`);
    if (!srcOk) out.push(`${tag}: source pattern not admitted by ${rel.name}`);
    if (!tgtOk) out.push(`${tag}: target pattern not admitted by ${rel.name}`);
    if (rel.cardinality === "one") {
      const k = `${rel.name}|${l.source_pattern}/${l.source_id}`;
      perSource.set(k, (perSource.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of perSource) if (n > 1) out.push(`cardinality one exceeded: ${k} holds ${n}`);
  return out;
}

/** Cycles (as node lists) across each ACTIVE relation carrying `acyclic`. */
async function acyclicCycles(store: Store): Promise<string[]> {
  const rels = (await sql(store, `SELECT name, behaviors FROM "_relations" WHERE archived_at IS NULL`))
    .filter((r) => list(r.behaviors).includes("acyclic"));
  const cycles: string[] = [];
  for (const rel of rels) {
    const edges = new Map<string, string[]>();
    for (const l of await sql(store, `SELECT * FROM "_links" WHERE archived_at IS NULL AND label = ?`, rel.name)) {
      const s = `${l.source_pattern}/${l.source_id}`, t = `${l.target_pattern}/${l.target_id}`;
      edges.set(s, [...(edges.get(s) ?? []), t]);
    }
    const state = new Map<string, number>(); // 1 = on stack, 2 = done
    const visit = (n: string, path: string[]) => {
      state.set(n, 1);
      for (const m of edges.get(n) ?? []) {
        if (state.get(m) === 1) cycles.push(`${rel.name}: ${[...path, n, m].join(" -> ")}`);
        else if (!state.has(m)) visit(m, [...path, n]);
      }
      state.set(n, 2);
    };
    for (const n of edges.keys()) if (!state.has(n)) visit(n, []);
  }
  return cycles;
}

/** A clean refusal: an error the engine authored, not a raw SQLite constraint. */
function expectCleanRefusal(r: any) {
  expect(r.error).toBe(true);
  expect(r.internal).toBeUndefined();
  expect(String(r.message)).not.toMatch(/UNIQUE constraint|SQLITE_CONSTRAINT/i);
}

// =====================================================================
// Registry: the `_relations` kernel pattern and its seeded kernel defaults
// =====================================================================

describe("relations registry: kernel defaults", () => {
  it("seeds exactly the five kernel defaults with their code-owned shape", async () => {
    const store = getStore();
    const rows = await sql(store, `SELECT * FROM "_relations" WHERE archived_at IS NULL AND kernel = 1 ORDER BY name`);
    expect(rows.map((r) => r.name).sort()).toEqual([...KERNEL_NAMES].sort());
    for (const k of KERNEL_DEFAULTS) {
      const r = rows.find((x) => x.name === k.name)!;
      expect(r.inverse, k.name).toBe(k.inverse);
      expect(new Set(list(r.behaviors)), k.name).toEqual(new Set(k.behaviors));
      expect(list(r.source), k.name).toEqual(["*"]);
      expect(list(r.target), k.name).toEqual(["*"]);
      expect(r.cardinality, k.name).toBe("many");
      expect(r.kernel, k.name).toBe(1);
      expect(String(r.description).length, `${k.name} description meets the quality bar`).toBeGreaterThanOrEqual(120);
    }
    // Phase 2: the generic hierarchy relation contains.
    expect(list(rows.find((x) => x.name === "part-of")!.behaviors)).toContain("containment");
  });

  it("seeding is idempotent across boots", async () => {
    const store = getStore();
    await boot(store);
    await boot(store);
    const rows = await sql(store, `SELECT name FROM "_relations" WHERE archived_at IS NULL`);
    expect(rows.length).toBe(KERNEL_NAMES.length);
    expect(new Set(rows.map((r) => r.name))).toEqual(new Set(KERNEL_NAMES));
  });

  it("boot refreshes a kernel default's semantics from code", async () => {
    const store = getStore();
    await sql(store, `UPDATE "_relations" SET behaviors = '[]', inverse = 'tampered', description = 'x' WHERE name = 'supersedes'`);
    await boot(store);
    const r = await relationRow(store, "supersedes");
    expect(r.inverse).toBe("superseded-by");
    expect(new Set(list(r.behaviors))).toEqual(new Set(["supersession", "acyclic"]));
    expect(String(r.description).length).toBeGreaterThanOrEqual(120);
  });

  it("is System write class: mutate cannot create or update it, query can read it", async () => {
    const store = getStore();
    const created = await mut(store, "_relations", "create", {
      name: "sneaky", inverse: "sneaked-by", description: DESC("sneaky"), source: '["*"]', target: '["*"]',
    });
    expect(created.error).toBe(true);
    expect(created.message).toMatch(/managed by the system/);

    const sup = await relationRow(store, "supersedes");
    const updated = await mut(store, "_relations", "update", { id: sup.id, behaviors: "[]" });
    expect(updated.error).toBe(true);
    expect(updated.message).toMatch(/managed by the system/);
    expect(list((await relationRow(store, "supersedes")).behaviors)).toContain("supersession");

    const q = JSON.parse(await store.query("_relations", "", "", "", 100, false));
    expect(q.error).toBeUndefined();
    expect(q.entries.map((e: any) => e.name)).toEqual(expect.arrayContaining(KERNEL_NAMES));
  });
});

// =====================================================================
// Surfaces: the index `relations` key and mnemion://relations
// =====================================================================

describe("relations surface: index and mnemion://relations", () => {
  it("mnemion://schema/<pattern> lists the relations it may be a source or target of, `*` included", async () => {
    const store = getStore();
    await world(store);
    await declare(store, { name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"] });
    const notes = JSON.parse(await store.resolve("mnemion://schema/notes"));
    expect(notes.relations).toBeDefined();
    expect(notes.relations.as_source).toEqual(expect.arrayContaining([...KERNEL_NAMES, "cites"]));
    expect(notes.relations.as_target).toEqual(expect.arrayContaining(KERNEL_NAMES));
    expect(notes.relations.as_target).not.toContain("cites");
    const papers = JSON.parse(await store.resolve("mnemion://schema/papers"));
    expect(papers.relations.as_target).toEqual(expect.arrayContaining([...KERNEL_NAMES, "cites"]));
    expect(papers.relations.as_source).not.toContain("cites");
    // Names only, canonical — never inverses.
    expect(notes.relations.as_source).not.toContain("superseded-by");
  });

  it("the prime response carries the active vocabulary as relations: [{name, inverse}]", async () => {
    const store = getStore();
    await world(store);
    await declare(store, { name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"] });
    const primed = JSON.parse(await store.prime("what do notes cite", "", 3));
    expect(Array.isArray(primed.relations)).toBe(true);
    expect(primed.relations).toEqual(expect.arrayContaining([
      { name: "supersedes", inverse: "superseded-by" },
      { name: "references", inverse: "referenced-by" },
      { name: "cites", inverse: "cited-by" },
    ]));
    for (const r of primed.relations) expect(Object.keys(r).sort()).toEqual(["inverse", "name"]);
  });

  it("the MCP init instructions point agents at mnemion://relations", async () => {
    const { init } = await mcpSession(`user:rel-mcp:${crypto.randomUUID()}`);
    expect(String(init.instructions)).toContain("mnemion://relations");
  });

  const shapeOk = (r: any) => {
    expect(typeof r.name).toBe("string");
    expect(typeof r.inverse).toBe("string");
    expect(typeof r.description).toBe("string");
    expect(Array.isArray(r.source)).toBe(true);
    expect(Array.isArray(r.target)).toBe(true);
    expect(["one", "many"]).toContain(r.cardinality);
    expect(Array.isArray(r.behaviors)).toBe(true);
    expect(typeof r.kernel).toBe("boolean");
    expect(typeof r.legacy).toBe("boolean");
    expect(Array.isArray(r.legacy_debt)).toBe(true); // Phase 2: which legacy debts remain
    expect(typeof r.required).toBe("boolean");      // Phase 2
    expect(typeof r.derived).toBe("boolean");       // Phase 2
  };

  it("the index carries `relations` with the declared vocabulary", async () => {
    const store = getStore();
    await world(store);
    await declare(store, { name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"] });
    const index = JSON.parse(await store.getIndex());
    expect(Array.isArray(index.relations)).toBe(true);
    index.relations.forEach(shapeOk);
    const names = index.relations.map((r: any) => r.name);
    expect(names).toEqual(expect.arrayContaining([...KERNEL_NAMES, "cites"]));
    const cites = index.relations.find((r: any) => r.name === "cites");
    expect(cites).toMatchObject({ inverse: "cited-by", source: ["notes"], target: ["papers"], cardinality: "many", behaviors: [], kernel: false, legacy: false });
    const sup = index.relations.find((r: any) => r.name === "supersedes");
    expect(sup.kernel).toBe(true);
    expect(new Set(sup.behaviors)).toEqual(new Set(["supersession", "acyclic"]));
  });

  it("mnemion://relations lists the active vocabulary and drops retired relations", async () => {
    const store = getStore();
    await world(store);
    await declare(store, { name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"] });
    const before = JSON.parse(await store.resolve("mnemion://relations"));
    expect(before.error).toBeUndefined();
    expect(Array.isArray(before.relations)).toBe(true);
    before.relations.forEach(shapeOk);
    expect(before.relations.map((r: any) => r.name)).toEqual(expect.arrayContaining([...KERNEL_NAMES, "cites"]));
    expect(before.relations.find((r: any) => r.name === "cites").description).toBe(DESC("cites"));

    const { applied } = await retire(store, "cites");
    expect(applied?.error).toBeUndefined();
    const after = JSON.parse(await store.resolve("mnemion://relations"));
    expect(after.relations.map((r: any) => r.name)).not.toContain("cites");
    const index = JSON.parse(await store.getIndex());
    expect(index.relations.map((r: any) => r.name)).not.toContain("cites");
  });
});

// =====================================================================
// Legacy labels: the Phase 1 core migration over links written before the registry
// =====================================================================

/** Simulate a pre-registry hive: raw `_links` rows written without any check. */
async function seedLegacyLinks(store: Store) {
  await createPattern(store, "axioms");
  await createPattern(store, "frames");
  await createPattern(store, "notes");
  const a1 = await entry(store, "axioms", "a1"), a2 = await entry(store, "axioms", "a2"), a3 = await entry(store, "axioms", "a3");
  const f1 = await entry(store, "frames", "f1");
  const n1 = await entry(store, "notes", "n1"), n2 = await entry(store, "notes", "n2");
  await runInDurableObject(store, (_i, state) => {
    const ins = (sp: string, si: number, tp: string, ti: number, label: string | null, archived = false) =>
      state.storage.sql.exec(
        `INSERT INTO "_links" (source_pattern, source_id, target_pattern, target_id, label, archived_at) VALUES (?, ?, ?, ?, ?, ${archived ? "datetime('now')" : "NULL"})`,
        sp, si, tp, ti, label,
      );
    ins("axioms", a1, "axioms", a2, "refines");
    ins("axioms", a2, "axioms", a3, "refines");
    ins("axioms", a1, "frames", f1, "ethos-grounds");
    ins("notes", n1, "frames", f1, "ethos-grounds");
    ins("notes", n2, "notes", n1, "supersedes");
    ins("notes", n1, "axioms", a1, "Inspired By"); // not kebab-case: declared verbatim
    ins("notes", n2, "axioms", a2, null);           // unlabeled
    ins("notes", n1, "notes", n2, "old-label", true); // archived only
  });
  return { a1, a2, a3, f1, n1, n2 };
}

describe("legacy label migration", () => {
  it("declares every label in use by active links as a legacy hive relation, inferring patterns", async () => {
    const store = getStore();
    await seedLegacyLinks(store);
    await boot(store);

    const refines = await relationRow(store, "refines");
    expect(refines, "refines declared").toBeDefined();
    expect(list(refines.source)).toEqual(["axioms"]);
    expect(list(refines.target)).toEqual(["axioms"]);
    expect(list(refines.behaviors)).toEqual([]);
    expect(refines.cardinality).toBe("many");
    expect(refines.kernel).toBe(0);
    expect(await legacyOf(store, "refines")).toEqual({ legacy: true, legacy_debt: ["placeholder description", "generated inverse"] });
    expect(String(refines.description).length).toBeGreaterThan(0);
    expect(String(refines.inverse).length).toBeGreaterThan(0);
    expect(refines.inverse).not.toBe("refines");

    const ethos = await relationRow(store, "ethos-grounds");
    expect(new Set(list(ethos.source))).toEqual(new Set(["axioms", "notes"]));
    expect(list(ethos.target)).toEqual(["frames"]);
    expect((await legacyOf(store, "ethos-grounds")).legacy).toBe(true);

    const inspired = await relationRow(store, "Inspired By");
    expect(inspired, "a non-kebab legacy label is declared verbatim").toBeDefined();
    expect((await legacyOf(store, "Inspired By")).legacy).toBe(true);

    // supersedes resolves to the kernel default — no hive duplicate.
    const sup = await sql(store, `SELECT * FROM "_relations" WHERE name = 'supersedes' AND archived_at IS NULL`);
    expect(sup.length).toBe(1);
    expect(sup[0].kernel).toBe(1);

    // A label only on archived links is not in use.
    expect(await relationRow(store, "old-label")).toBeUndefined();

    // Every inverse is unique across all active names and inverses.
    const all = await sql(store, `SELECT name, inverse FROM "_relations" WHERE archived_at IS NULL`);
    const vocab = all.flatMap((r) => [r.name, r.inverse]);
    expect(new Set(vocab).size).toBe(vocab.length);
  });

  it("an unlabeled active link is migrated to `references`, the honest generic link", async () => {
    const store = getStore();
    const { n2, a2 } = await seedLegacyLinks(store);
    await boot(store);
    const rows = await sql(store, `SELECT label FROM "_links" WHERE source_pattern = 'notes' AND source_id = ? AND target_pattern = 'axioms' AND target_id = ? AND archived_at IS NULL`, n2, a2);
    expect(rows.length).toBe(1);
    expect(rows[0].label).toBe("references");
  });

  it("is idempotent across boots", async () => {
    const store = getStore();
    await seedLegacyLinks(store);
    await boot(store);
    await boot(store);
    const rows = await sql(store, `SELECT name FROM "_relations" WHERE archived_at IS NULL AND name IN ('refines', 'ethos-grounds', 'Inspired By')`);
    expect(rows.map((r) => r.name).sort()).toEqual(["Inspired By", "ethos-grounds", "refines"]);
  });

  it("keeps the hive writable: legacy relations admit their inferred patterns and refuse others", async () => {
    const store = getStore();
    const { a1, a3, n1, n2 } = await seedLegacyLinks(store);
    await boot(store);
    const ok = await link(store, `axioms/${a1}`, `axioms/${a3}`, "refines");
    expect(ok.error).toBeUndefined();
    const bad = await link(store, `notes/${n1}`, `notes/${n2}`, "refines");
    expect(bad.error).toBe(true);
  });

  it("warns at boot for every legacy relation until both debts are paid", async () => {
    const store = getStore();
    await seedLegacyLinks(store);
    await boot(store); // migration runs

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await boot(store);
      const text = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(text).toMatch(/legacy/i);
      expect(text).toContain("refines");
      expect(text).toContain("ethos-grounds");
    } finally { warn.mockRestore(); }

    const { proposed, applied } = await amend(store, { name: "refines", description: DESC("refines"), inverse: "refined-by" });
    expect(proposed.error).toBeUndefined();
    expect(applied.error).toBeUndefined();
    expect((await legacyOf(store, "refines")).legacy).toBe(false);

    const warn2 = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await boot(store);
      const text = warn2.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(text).toContain("ethos-grounds");   // still legacy
      expect(text).not.toContain("refines");     // both debts paid
    } finally { warn2.mockRestore(); }
  });

  it("an upgraded hive loses the pair-only unique index: one pair may carry several relations", async () => {
    const store = getStore();
    const { n1, p1 } = await world(store);
    // The pre-registry index: one active link per (source, target) whatever its label.
    await sql(store, `DROP INDEX IF EXISTS "_links_pair_active"`);
    await sql(store, `CREATE UNIQUE INDEX "_links_pair_active" ON "_links" ("source_pattern", "source_id", "target_pattern", "target_id") WHERE archived_at IS NULL`);
    await boot(store);
    await mustLink(store, `notes/${n1}`, `papers/${p1}`, "references");
    const second = await link(store, `notes/${n1}`, `papers/${p1}`, "depends-on");
    expect(second.error).toBeUndefined();
  });
});

// =====================================================================
// The link write chokepoint (create)
// =====================================================================

describe("link write chokepoint", () => {
  it("refuses an undeclared label, naming the relations declared for that pattern pair", async () => {
    const store = getStore();
    const { n1, n2, p1 } = await world(store);
    await declare(store, { name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"] });

    const r = await link(store, `notes/${n1}`, `notes/${n2}`, "inspired-by");
    expect(r.error).toBe(true);
    expect(r.message).toContain("declare_relation");
    expect(Array.isArray(r.available_relations)).toBe(true);
    expect(r.available_relations).toEqual(expect.arrayContaining(KERNEL_NAMES));
    for (const name of KERNEL_NAMES) expect(r.message).toContain(name);
    // cites is declared for notes -> papers only, so it is not offered for notes -> notes.
    expect(r.available_relations).not.toContain("cites");

    const r2 = await link(store, `notes/${n1}`, `papers/${p1}`, "inspired-by");
    expect(r2.error).toBe(true);
    expect(r2.available_relations).toContain("cites");
    expect(r2.message).toContain("cites");

    expect((await activeLinks(store)).length).toBe(0);
  });

  it("refuses a missing or empty label", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    for (const label of [undefined, null, ""]) {
      const r = await link(store, `notes/${n1}`, `notes/${n2}`, label);
      expect(r.error, `label ${JSON.stringify(label)}`).toBe(true);
      expect(r.available_relations, `label ${JSON.stringify(label)}`).toEqual(expect.arrayContaining(["references"]));
    }
    // Raw `_links` create (not the shortcut) crosses the same chokepoint.
    const raw = await mut(store, "_links", "create", { source: `notes/${n1}`, target: `notes/${n2}` });
    expect(raw.error).toBe(true);
    expect((await activeLinks(store)).length).toBe(0);
  });

  it("raw `_links` create is held to the same rules as the shortcut", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    const bad = await mut(store, "_links", "create", {
      source_pattern: "notes", source_id: n1, target_pattern: "notes", target_id: n2, label: "inspired-by",
    });
    expect(bad.error).toBe(true);
    expect(bad.message).toContain("declare_relation");
    const ok = await mut(store, "_links", "create", {
      source_pattern: "notes", source_id: n1, target_pattern: "notes", target_id: n2, label: "references",
    });
    expect(ok.error).toBeUndefined();
  });

  it("accepts the inverse name and stores the canonical direction", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    // "n1 superseded-by n2" is stored as "n2 supersedes n1".
    const r = await link(store, `notes/${n1}`, `notes/${n2}`, "superseded-by");
    expect(r.error).toBeUndefined();
    const rows = await activeLinks(store);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ source_pattern: "notes", source_id: n2, target_pattern: "notes", target_id: n1, label: "supersedes" });
  });

  it("enforces a relation's source and target patterns, in either written direction", async () => {
    const store = getStore();
    const { n1, n2, p1, p2 } = await world(store);
    await createPattern(store, "facts");
    const f1 = await entry(store, "facts", "fact");
    await declare(store, { name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"] });

    expect((await link(store, `notes/${n1}`, `papers/${p1}`, "cites")).error).toBeUndefined();
    expect((await link(store, `papers/${p1}`, `notes/${n2}`, "cites")).error).toBe(true); // wrong way round
    expect((await link(store, `facts/${f1}`, `papers/${p2}`, "cites")).error).toBe(true); // source not listed
    expect((await link(store, `notes/${n1}`, `notes/${n2}`, "cites")).error).toBe(true);  // target not listed
    // The inverse written from the target side is the same relation: papers/2 cited-by notes/2.
    expect((await link(store, `papers/${p2}`, `notes/${n2}`, "cited-by")).error).toBeUndefined();
    const rows = await sql(store, `SELECT * FROM "_links" WHERE archived_at IS NULL AND label = 'cites' ORDER BY id`);
    expect(rows.map((l) => `${l.source_pattern}/${l.source_id}->${l.target_pattern}/${l.target_id}`))
      .toEqual([`notes/${n1}->papers/${p1}`, `notes/${n2}->papers/${p2}`]);
  });

  it("`*` admits any user pattern; _documents and _web_cache only as targets; other kernel patterns never", async () => {
    const store = getStore();
    const { n1 } = await world(store);
    const doc = await insertDocument(store, "a cited pdf");
    const web = await insertWebCache(store, "https://example.com/cited");

    expect((await link(store, `notes/${n1}`, `_documents/${doc}`, "references")).error).toBeUndefined();
    expect((await link(store, `notes/${n1}`, `_web_cache/${web}`, "references")).error).toBeUndefined();

    const docSource = await link(store, `_documents/${doc}`, `notes/${n1}`, "references");
    expect(docSource.error).toBe(true);
    expect(docSource.message).toMatch(/kernel pattern/);
    const webSource = await link(store, `_web_cache/${web}`, `notes/${n1}`, "references");
    expect(webSource.error).toBe(true);
    expect(webSource.message).toMatch(/kernel pattern/);
    // Inverse wording that would make a kernel row the canonical SOURCE is refused too.
    expect((await link(store, `notes/${n1}`, `_documents/${doc}`, "referenced-by")).error).toBe(true);

    for (const target of ["_members/1", "_relations/1", "_charter/1"]) {
      const r = await link(store, `notes/${n1}`, target, "references");
      expect(r.error, target).toBe(true);
      expect(r.message, target).toMatch(/kernel pattern/);
    }
    expect((await activeLinks(store)).length).toBe(2);
  });

  it("a hive relation may name _documents or _web_cache as an explicit target", async () => {
    const store = getStore();
    const { n1 } = await world(store);
    const doc = await insertDocument(store, "spec");
    await declare(store, { name: "attaches", inverse: "attached-to", source: ["notes"], target: ["_documents"] });
    expect((await link(store, `notes/${n1}`, `_documents/${doc}`, "attaches")).error).toBeUndefined();
    const web = await insertWebCache(store, "https://example.com/x");
    expect((await link(store, `notes/${n1}`, `_web_cache/${web}`, "attaches")).error).toBe(true);
  });

  it("endpoints must exist and be active", async () => {
    const store = getStore();
    const { n1, n2, n3 } = await world(store);
    expect((await link(store, `notes/${n1}`, `notes/99999`, "references")).error).toBe(true);
    expect((await link(store, `nosuch/1`, `notes/${n1}`, "references")).error).toBe(true);
    await mut(store, "notes", "archive", { id: n2 });
    expect((await link(store, `notes/${n1}`, `notes/${n2}`, "references")).error).toBe(true);
    expect((await link(store, `notes/${n2}`, `notes/${n3}`, "references")).error).toBe(true);
    expect((await activeLinks(store)).length).toBe(0);
  });

  it("one pair may carry different relations; the same relation twice is a clean refusal", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    await mustLink(store, `notes/${n1}`, `notes/${n2}`, "references");
    await mustLink(store, `notes/${n1}`, `notes/${n2}`, "depends-on");
    const dup = await link(store, `notes/${n1}`, `notes/${n2}`, "references");
    expectCleanRefusal(dup);
    const dupViaInverse = await link(store, `notes/${n2}`, `notes/${n1}`, "required-by"); // = n1 depends-on n2
    expectCleanRefusal(dupViaInverse);
    expect((await activeLinks(store)).length).toBe(2);
  });
});

// =====================================================================
// Cardinality
// =====================================================================

describe("cardinality", () => {
  it("`one` refuses a second active link from the same source; archived links do not count", async () => {
    const store = getStore();
    const { n1, n2, p1, p2 } = await world(store);
    await declare(store, { name: "filed-under", inverse: "files", source: ["notes"], target: ["papers"], cardinality: "one" });

    const first = await mustLink(store, `notes/${n1}`, `papers/${p1}`, "filed-under");
    const second = await link(store, `notes/${n1}`, `papers/${p2}`, "filed-under");
    expectCleanRefusal(second);
    expect(second.message, "names the link the writer must unlink").toContain(`papers/${p1}`);
    // Written from the target side, it is still a second link from notes/n1.
    expectCleanRefusal(await link(store, `papers/${p2}`, `notes/${n1}`, "files"));
    // Another source is unaffected; the target may be shared (cardinality bounds the source).
    expect((await link(store, `notes/${n2}`, `papers/${p1}`, "filed-under")).error).toBeUndefined();

    await mut(store, "_links", "archive", { id: first });
    expect((await link(store, `notes/${n1}`, `papers/${p2}`, "filed-under")).error).toBeUndefined();
    expect(await totalityViolations(store)).toEqual([]);
  });

  it("`many` admits several links from one source", async () => {
    const store = getStore();
    const { n1, p1, p2 } = await world(store);
    await mustLink(store, `notes/${n1}`, `papers/${p1}`, "references");
    await mustLink(store, `notes/${n1}`, `papers/${p2}`, "references");
    expect((await activeLinks(store)).length).toBe(2);
  });
});

// =====================================================================
// Acyclicity
// =====================================================================

describe("acyclicity", () => {
  it("refuses a self-link across an acyclic relation", async () => {
    const store = getStore();
    const { n1 } = await world(store);
    for (const label of ["depends-on", "supersedes", "derived-from", "part-of"]) {
      expectCleanRefusal(await link(store, `notes/${n1}`, `notes/${n1}`, label));
    }
    expect((await activeLinks(store)).length).toBe(0);
  });

  it("refuses a link that would close a cycle, however long", async () => {
    const store = getStore();
    const { n1, n2, n3 } = await world(store);
    await mustLink(store, `notes/${n1}`, `notes/${n2}`, "depends-on");
    await mustLink(store, `notes/${n2}`, `notes/${n3}`, "depends-on");
    expectCleanRefusal(await link(store, `notes/${n3}`, `notes/${n1}`, "depends-on"));
    expectCleanRefusal(await link(store, `notes/${n2}`, `notes/${n1}`, "depends-on"));
    // Written as the inverse, the same cycle is still refused: n1 required-by n3 = n3 depends-on n1.
    expectCleanRefusal(await link(store, `notes/${n1}`, `notes/${n3}`, "required-by"));
    expect(await acyclicCycles(store)).toEqual([]);
  });

  it("a cycle is judged per relation: other relations do not close it", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    await mustLink(store, `notes/${n1}`, `notes/${n2}`, "depends-on");
    expect((await link(store, `notes/${n2}`, `notes/${n1}`, "references")).error).toBeUndefined(); // references is not acyclic
    expect((await link(store, `notes/${n2}`, `notes/${n1}`, "derived-from")).error).toBeUndefined(); // separate acyclic relation
    expect(await acyclicCycles(store)).toEqual([]);
  });

  it("supersedes is acyclic", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    await mustLink(store, `notes/${n2}`, `notes/${n1}`, "supersedes");
    expectCleanRefusal(await link(store, `notes/${n1}`, `notes/${n2}`, "supersedes"));
  });

  it("a dormant link still takes part in the cycle walk: the closing write is refused", async () => {
    const store = getStore();
    const { n1, n2, n3 } = await world(store);
    await mustLink(store, `notes/${n1}`, `notes/${n2}`, "depends-on");
    await mustLink(store, `notes/${n2}`, `notes/${n3}`, "depends-on");
    await mut(store, "notes", "archive", { id: n2 }); // both links now dormant
    expectCleanRefusal(await link(store, `notes/${n3}`, `notes/${n1}`, "depends-on"));
    await mut(store, "notes", "unarchive", { id: n2 });
    expect(await acyclicCycles(store)).toEqual([]);
  });

  it("pre-registry cycles are reported at boot and left in place, never auto-repaired", async () => {
    const store = getStore();
    const { n1, n2, n3 } = await world(store);
    const ids = await runInDurableObject(store, (_i, state) => {
      const db = state.storage.sql;
      const ins = (s: number, t: number, label: string) => {
        db.exec(`INSERT INTO "_links" (source_pattern, source_id, target_pattern, target_id, label) VALUES ('notes', ?, 'notes', ?, ?)`, s, t, label);
        return (db.exec(`SELECT last_insert_rowid() AS id`).one() as { id: number }).id;
      };
      return [
        ins(n1, n2, "supersedes"), ins(n2, n1, "supersedes"), // 2-cycle
        ins(n3, n3, "depends-on"),                            // self-loop
        ins(n1, n3, "derived-from"), ins(n1, n3, "source-of"), // the rewrite makes n3 derived-from n1: a 2-cycle
      ];
    });

    const lines = await warnLines(() => boot(store));
    const reported = (relation: string, entries: string[]) =>
      lines.some((l) => l.includes(relation) && entries.every((e) => new RegExp(`${e}(?!\\d)`).test(l)));
    expect(reported("supersedes", [`notes/${n1}`, `notes/${n2}`]), "supersedes 2-cycle reported").toBe(true);
    expect(reported("depends-on", [`notes/${n3}`]), "depends-on self-loop reported").toBe(true);
    expect(reported("derived-from", [`notes/${n1}`, `notes/${n3}`]), "derived-from 2-cycle (after the inverse rewrite) reported").toBe(true);

    for (const id of ids) expect((await linkRow(store, id)).archived_at, `legacy link ${id} left in place`).toBeNull();
    const derived = await sql(store, `SELECT source_id, target_id FROM "_links" WHERE archived_at IS NULL AND label = 'derived-from' ORDER BY source_id`);
    expect(derived.map((l) => `${l.source_id}->${l.target_id}`).sort()).toEqual([`${n1}->${n3}`, `${n3}->${n1}`].sort());
    // Reported, not repaired: the walk still finds them.
    expect((await acyclicCycles(store)).length).toBeGreaterThanOrEqual(3);
    // And no write may add to them.
    expectCleanRefusal(await link(store, `notes/${n2}`, `notes/${n2}`, "supersedes"));
  });

  it("a hive relation declared acyclic is enforced; one declared without it is not", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    await declare(store, { name: "builds-on", inverse: "built-upon-by", source: ["notes"], target: ["notes"], behaviors: ["acyclic"] });
    await declare(store, { name: "echoes", inverse: "echoed-by", source: ["notes"], target: ["notes"] });
    await mustLink(store, `notes/${n1}`, `notes/${n2}`, "builds-on");
    expectCleanRefusal(await link(store, `notes/${n2}`, `notes/${n1}`, "builds-on"));
    await mustLink(store, `notes/${n1}`, `notes/${n2}`, "echoes");
    expect((await link(store, `notes/${n2}`, `notes/${n1}`, "echoes")).error).toBeUndefined();
    expect(await acyclicCycles(store)).toEqual([]);
  });
});

// =====================================================================
// Link immutability (update / patch / unarchive)
// =====================================================================

describe("link immutability", () => {
  it("update cannot change a link's source, target or relation", async () => {
    const store = getStore();
    const { n1, n2, n3, p1 } = await world(store);
    const id = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "references");
    const before = await linkRow(store, id);
    for (const change of [
      { label: "depends-on" },
      { target_id: n3 },
      { target_pattern: "papers", target_id: p1 },
      { source_id: n3 },
      { source_pattern: "papers", source_id: p1 },
      { source: `notes/${n3}` },
      { target: `notes/${n3}` },
    ]) {
      const r = await mut(store, "_links", "update", { id, ...change });
      expect(r.error, JSON.stringify(change)).toBe(true);
      expect(r.message, JSON.stringify(change)).toMatch(/immutable/i);
    }
    const after = await linkRow(store, id);
    for (const k of ["source_pattern", "source_id", "target_pattern", "target_id", "label"]) expect(after[k], k).toBe(before[k]);
  });

  it("patch cannot rewrite a link's label or endpoint patterns", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    const id = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "references");
    for (const [facet, match, replacement] of [
      ["label", "references", "depends-on"],
      ["target_pattern", "notes", "papers"],
      ["source_pattern", "notes", "papers"],
    ]) {
      const r = await mut(store, "_links", "patch", { id, facet, match, replacement });
      expect(r.error, facet).toBe(true);
      expect(r.message, facet).toMatch(/immutable/i);
    }
    expect((await linkRow(store, id)).label).toBe("references");
  });

  it("a plain archive and unarchive of a still-valid link succeeds", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    const id = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "references");
    expect((await mut(store, "_links", "archive", { id })).error).toBeUndefined();
    expect((await mut(store, "_links", "unarchive", { id })).error).toBeUndefined();
    expect((await linkRow(store, id)).archived_at).toBeNull();
  });

  it("unarchive re-validates: a retired relation is refused", async () => {
    const store = getStore();
    const { n1, p1 } = await world(store);
    await declare(store, { name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"] });
    const id = await mustLink(store, `notes/${n1}`, `papers/${p1}`, "cites");
    await mut(store, "_links", "archive", { id });
    const { applied } = await retire(store, "cites");
    expect(applied?.error).toBeUndefined();
    const r = await mut(store, "_links", "unarchive", { id });
    expect(r.error).toBe(true);
    expect((await linkRow(store, id)).archived_at).not.toBeNull();
  });

  it("unarchive re-validates: an endpoint that is no longer active is refused", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    const id = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "references");
    await mut(store, "_links", "archive", { id });
    await mut(store, "notes", "archive", { id: n2 });
    const r = await mut(store, "_links", "unarchive", { id });
    expect(r.error).toBe(true);
    expect((await linkRow(store, id)).archived_at).not.toBeNull();
  });

  it("unarchive re-validates: a link that would now close a cycle is refused", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    const id = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "depends-on");
    await mut(store, "_links", "archive", { id });
    await mustLink(store, `notes/${n2}`, `notes/${n1}`, "depends-on");
    expectCleanRefusal(await mut(store, "_links", "unarchive", { id }));
    expect(await acyclicCycles(store)).toEqual([]);
  });

  it("unarchive re-validates: cardinality `one` and the per-relation uniqueness are rechecked", async () => {
    const store = getStore();
    const { n1, n2, p1, p2 } = await world(store);
    await declare(store, { name: "filed-under", inverse: "files", source: ["notes"], target: ["papers"], cardinality: "one" });
    const a = await mustLink(store, `notes/${n1}`, `papers/${p1}`, "filed-under");
    await mut(store, "_links", "archive", { id: a });
    await mustLink(store, `notes/${n1}`, `papers/${p2}`, "filed-under");
    expectCleanRefusal(await mut(store, "_links", "unarchive", { id: a }));

    const r1 = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "references");
    await mut(store, "_links", "archive", { id: r1 });
    await mustLink(store, `notes/${n1}`, `notes/${n2}`, "references");
    expectCleanRefusal(await mut(store, "_links", "unarchive", { id: r1 }));
    expect(await totalityViolations(store)).toEqual([]);
  });
});

// =====================================================================
// Behavior by declaration: supersession is a declared behavior, not a literal
// =====================================================================

// Every worker source file (tests excluded), as raw text, keyed by path.
const WORKER_SOURCES = import.meta.glob(
  ["../../entities/**/*.ts", "../../shared/**/*.ts", "../../src/**/*.ts", "!../../src/__tests__/**"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;
const RELATIONS_MODULE_PATH = "../../entities/Hive/relations.ts";

/** Bodies of every string / template literal in `src`, comments skipped. A small
 *  tokenizer (not a regex) so backticks inside comments cannot mis-pair literals. */
/** `src` with line and block comments removed; string and template literals kept. */
function codeWithoutComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { const j = src.indexOf("\n", i); i = j < 0 ? n : j; continue; }
    if (c === "/" && d === "*") { const j = src.indexOf("*/", i + 2); i = j < 0 ? n : j + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1, depth = 0;
      while (j < n) {
        const ch = src[j];
        if (ch === "\\") { j += 2; continue; }
        if (c === "`") {
          if (depth === 0 && ch === "`") break;
          if (ch === "$" && src[j + 1] === "{") { depth++; j += 2; continue; }
          if (depth > 0 && ch === "{") depth++;
          if (depth > 0 && ch === "}") depth--;
        } else if (ch === c || ch === "\n") break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function stringLiterals(src: string): string[] {
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
        body += ch;
        j++;
      }
      out.push(body);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

describe("behavior by declaration", () => {
  async function supersessionWorld(store: Store) {
    await createPattern(store, "notes", "knowledge");
    const oldId = await entry(store, "notes", "We use PostgreSQL");
    const newId = await entry(store, "notes", "We use MySQL now");
    await declare(store, { name: "replaces", inverse: "replaced-by", source: ["notes"], target: ["notes"], behaviors: ["supersession"] });
    await mustLink(store, `notes/${newId}`, `notes/${oldId}`, "replaces");
    return { oldId, newId };
  }

  it("a hive relation with `supersession` annotates superseded_by on getEntry and resolve", async () => {
    const store = getStore();
    const { oldId, newId } = await supersessionWorld(store);
    const read = JSON.parse(await store.getEntry("notes", oldId));
    expect(read.superseded_by).toBe(`mnemion://entry/notes/${newId}`);
    expect(read.entry.title).toBe("We use PostgreSQL"); // demoted, never hidden
    const resolved = JSON.parse(await store.resolve(`mnemion://entry/notes/${oldId}`));
    expect(resolved.superseded_by).toBe(`mnemion://entry/notes/${newId}`);
    expect(JSON.parse(await store.getEntry("notes", newId)).superseded_by).toBeUndefined();
  });

  it("a relation without `supersession` never annotates; amending the behavior in derives it at read time", async () => {
    const store = getStore();
    await createPattern(store, "notes", "knowledge");
    const oldId = await entry(store, "notes", "old");
    const newId = await entry(store, "notes", "new");
    await declare(store, { name: "replaces", inverse: "replaced-by", source: ["notes"], target: ["notes"] });
    await mustLink(store, `notes/${newId}`, `notes/${oldId}`, "replaces");
    await mustLink(store, `notes/${newId}`, `notes/${oldId}`, "references");
    expect(JSON.parse(await store.getEntry("notes", oldId)).superseded_by).toBeUndefined();

    const { applied } = await amend(store, { name: "replaces", behaviors: ["supersession"] });
    expect(applied?.error).toBeUndefined();
    expect(JSON.parse(await store.getEntry("notes", oldId)).superseded_by).toBe(`mnemion://entry/notes/${newId}`);
  });

  it("the stale view annotates entries superseded through a hive relation", async () => {
    const store = getStore();
    const { oldId, newId } = await supersessionWorld(store);
    await sql(store, `UPDATE "notes" SET updated_at = datetime('now', '-120 days') WHERE id = ?`, oldId);
    const stale = JSON.parse(await store.getStaleEntries());
    const item = stale.stale.find((s: any) => s.pattern === "notes" && s.id === oldId);
    expect(item).toBeDefined();
    expect(item.superseded_by).toBe(`mnemion://entry/notes/${newId}`);
  });

  it("publications exclude entries superseded through a hive relation unless opted in", async () => {
    const store = getStore();
    const { oldId, newId } = await supersessionWorld(store);
    const pub = await mut(store, "_publications", "create", { path: "current", source_pattern: "notes", format: "json" });
    expect(pub.error).toBeUndefined();
    const current = JSON.parse(JSON.parse(await store.resolvePublication("current")).body);
    expect(current.entries.map((e: any) => e.id)).not.toContain(oldId);
    expect(current.entries.map((e: any) => e.id)).toContain(newId);
    await mut(store, "_publications", "create", { path: "all", source_pattern: "notes", format: "json", include_superseded: true });
    const all = JSON.parse(JSON.parse(await store.resolvePublication("all")).body);
    expect(all.entries.map((e: any) => e.id)).toContain(oldId);
  });

  it("prime demotes the target of a hive `supersession` relation by 0.3 and annotates it", async () => {
    const store = getStore();
    const { oldId, newId } = await supersessionWorld(store);
    const result = await runInDurableObject(store, async (_i, state) => {
      const db = state.storage.sql;
      const ctx: PrimeContext = {
        db,
        patternExists: (n) => db.exec(`SELECT 1 FROM _objects WHERE name = ? AND archived_at IS NULL`, n).toArray().length > 0,
        env: {
          AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
          VECTORIZE: {
            query: async () => ({
              matches: [
                { id: `notes:${oldId}`, score: 0.9, metadata: { pattern: "notes", entry_id: oldId } },
                { id: `notes:${newId}`, score: 0.8, metadata: { pattern: "notes", entry_id: newId } },
              ],
            }),
          },
        },
      };
      return prime(ctx, "which database do we use", undefined, 5);
    });
    const oldHit = result.results.find((r) => r.id === oldId)!;
    const newHit = result.results.find((r) => r.id === newId)!;
    expect(oldHit.raw_similarity).toBe(0.9);
    expect(oldHit.relevance).toBe(0.27);
    expect(oldHit.superseded_by).toBe(`mnemion://entry/notes/${newId}`);
    expect(newHit.relevance).toBe(0.8);
    expect(newHit.superseded_by).toBeUndefined();
    expect(result.results[0].id).toBe(newId);
  });

  // The structural oracle. Two rules, both evaluated over every worker source file
  // except the relations module, on string/template literal bodies (comments skipped):
  //
  //   1. No string literal anywhere is EXACTLY a kernel relation name or inverse.
  //      This catches a bound parameter (`label = ?` with "supersedes" bound), a
  //      constant (`const SUP = "supersedes"; [SUP].includes(l.label)`), and a JS
  //      comparison (`l.label === "supersedes"`). Prose that merely mentions a
  //      relation inside a sentence (the overlap guidance in data.ts / hive.ts) is
  //      not an exact literal and is allowed. Seed DATA files that write link rows
  //      (SEED_DATA_FILES) are the declared exception: labels there are data, not
  //      behavior.
  //   2. A file whose SQL touches `_links` (FROM/INTO/UPDATE/JOIN "_links") holds no
  //      literal that compares `label`, where the literal either mentions `_links`
  //      or names no table at all (a fragment concatenated onto a `_links` query).
  //      A `label` comparison on another table (e.g. `_members WHERE label = ?`)
  //      names its table and is allowed.
  //   3. No code (comments skipped) refers to KERNEL_RELATIONS or BEHAVIOR_PALETTE:
  //      reading the vocabulary's names out of the relations module to filter on
  //      them elsewhere is the same literal, one indirection removed.
  const SEED_DATA_FILES = new Set(["../../shared/core/dev-seed.ts"]);
  // Table may be quoted and schema-qualified (main._links, "main"."_links");
  // the column may be quoted ("label", `label`).
  const LINKS_SQL = /\b(?:FROM|INTO|UPDATE|JOIN)\s+(?:["`]?\w+["`]?\.)?["`]?_links["`]?(?!\w)/i;
  const LABEL_CMP = /["`]?\blabel\b["`]?\s*(?:=|==|!=|<>|\bIN\b|\bLIKE\b|\bGLOB\b|\bIS\b)/i;
  const TABLE_REF = /\b(?:FROM|INTO|UPDATE|JOIN)\s+["`]?[\w$]/i;

  it("no worker source outside the relations module names a kernel relation in a literal", () => {
    const paths = Object.keys(WORKER_SOURCES);
    // Sanity: the glob really reads the worker tree (the check is not vacuous).
    expect(paths).toContain("../../entities/Hive/hive.ts");
    expect(paths).toContain("../../entities/Hive/prime.ts");
    expect(paths).toContain("../../entities/Hive/data.ts");
    expect(paths.some((p) => p.includes("__tests__"))).toBe(false);
    for (const seed of SEED_DATA_FILES) expect(paths, `declared seed file ${seed} exists`).toContain(seed);

    const vocab = new Set(KERNEL_VOCAB);
    const offenders: string[] = [];
    for (const [path, src] of Object.entries(WORKER_SOURCES)) {
      if (path === RELATIONS_MODULE_PATH || SEED_DATA_FILES.has(path)) continue;
      for (const lit of stringLiterals(src)) if (vocab.has(lit.trim())) offenders.push(`${path}: "${lit}"`);
    }
    expect(offenders).toEqual([]);
  });

  it("no worker source that queries `_links` compares `label` in SQL outside the relations module", () => {
    const offenders: string[] = [];
    let querying = 0;
    for (const [path, src] of Object.entries(WORKER_SOURCES)) {
      if (path === RELATIONS_MODULE_PATH) continue;
      const lits = stringLiterals(src);
      if (!lits.some((l) => LINKS_SQL.test(l))) continue;
      querying++;
      for (const lit of lits)
        if (LABEL_CMP.test(lit) && (lit.includes("_links") || !TABLE_REF.test(lit)))
          offenders.push(`${path}: ${lit.replace(/\s+/g, " ").slice(0, 160)}`);
    }
    expect(querying, "at least one file outside the relations module queries _links (the rule is exercised)").toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it("no worker source outside the relations module reaches into KERNEL_RELATIONS or BEHAVIOR_PALETTE", () => {
    const offenders: string[] = [];
    for (const [path, src] of Object.entries(WORKER_SOURCES)) {
      if (path === RELATIONS_MODULE_PATH) continue;
      for (const m of codeWithoutComments(src).matchAll(/\b(?:KERNEL_RELATIONS|BEHAVIOR_PALETTE)\b/g))
        offenders.push(`${path}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});

// =====================================================================
// Integrity sweep (boot)
// =====================================================================

describe("integrity sweep", () => {
  it("archives only links whose endpoint is gone or a kernel pattern no relation admits; keeps sound and dormant links", async () => {
    const store = getStore();
    const { n1, n2, n3, p1 } = await world(store);
    await createPattern(store, "drafts");
    const d1 = await entry(store, "drafts", "draft");
    const sound = await mustLink(store, `notes/${n1}`, `papers/${p1}`, "references");
    const toArchivedEntry = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "references");
    const toArchivedPattern = await mustLink(store, `notes/${n3}`, `drafts/${d1}`, "references");
    await mut(store, "notes", "archive", { id: n2 });
    const ap = await propose(store, { type: "archive_pattern", pattern_name: "drafts" });
    expect((await apply(store, ap.change_id)).error).toBeUndefined();
    const doc = await insertDocument(store, "kept target");
    const toDocument = await mustLink(store, `notes/${n3}`, `_documents/${doc}`, "references");

    // Rows the chokepoint would never admit, planted the way a pre-registry hive holds them.
    const planted = await runInDurableObject(store, (_i, state) => {
      const db = state.storage.sql;
      const ins = (sp: string, si: number, tp: string, ti: number) => {
        db.exec(`INSERT INTO "_links" (source_pattern, source_id, target_pattern, target_id, label) VALUES (?, ?, ?, ?, 'references')`, sp, si, tp, ti);
        return (db.exec(`SELECT last_insert_rowid() AS id`).one() as { id: number }).id;
      };
      return {
        gonePattern: ins("pub-test", 3, "notes", n1),     // pattern dropped entirely (link 55)
        goneEntry: ins("notes", n3, "notes", 99999),       // entry row gone
        kernelTarget: ins("notes", n3, "_members", 1),     // _members admits no link (the owner row exists)
        kernelSource: ins("_documents", doc, "notes", n1), // no kernel pattern may be a source
      };
    });

    await boot(store);

    for (const [name, id] of Object.entries({ sound, toArchivedEntry, toArchivedPattern, toDocument }))
      expect((await linkRow(store, id)).archived_at, `${name} stays active`).toBeNull();
    for (const [name, id] of Object.entries(planted))
      expect((await linkRow(store, id)).archived_at, `${name} is swept`).not.toBeNull();
    expect(await totalityViolations(store)).toEqual([]);
  });

  it("is deterministic under cold starts: archive an entry, boot, unarchive — its links come back", async () => {
    const store = getStore();
    const { n1, n2, p1 } = await world(store);
    const out = await mustLink(store, `notes/${n2}`, `papers/${p1}`, "references");
    const inn = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "depends-on");
    await mut(store, "notes", "archive", { id: n2 });

    await boot(store); // a Durable Object cold start
    await boot(store);

    expect((await mut(store, "notes", "unarchive", { id: n2 })).error).toBeUndefined();
    expect((await linkRow(store, out)).archived_at).toBeNull();
    expect((await linkRow(store, inn)).archived_at).toBeNull();
    const r = JSON.parse(await store.resolve(`mnemion://entry/notes/${n2}`));
    expect(r.linked.find((l: any) => l.pattern === "papers" && l.id === p1)).toMatchObject({ direction: "out", relation: "references" });
    expect(r.linked.find((l: any) => l.pattern === "notes" && l.id === n1)).toMatchObject({ direction: "in", relation: "required-by" });
  });

  it("is deterministic under cold starts: archive_pattern, boot, unarchive_pattern — its links come back", async () => {
    const store = getStore();
    const { n1, p1 } = await world(store);
    const id = await mustLink(store, `notes/${n1}`, `papers/${p1}`, "references");
    const ap = await propose(store, { type: "archive_pattern", pattern_name: "notes" });
    expect((await apply(store, ap.change_id)).error).toBeUndefined();

    await boot(store);
    await boot(store);

    const up = await propose(store, { type: "unarchive_pattern", pattern_name: "notes" });
    expect((await apply(store, up.change_id)).error).toBeUndefined();
    expect((await linkRow(store, id)).archived_at).toBeNull();
    const r = JSON.parse(await store.resolve(`mnemion://entry/papers/${p1}`));
    expect(r.linked.find((l: any) => l.pattern === "notes" && l.id === n1)).toMatchObject({ direction: "in", relation: "referenced-by" });
  });
});

// =====================================================================
// Dormant links: an archived endpoint hides a link, never removes it
// =====================================================================

describe("dormant links", () => {
  it("while an endpoint is archived, the other endpoint's resolve does not list the link; unarchive restores it", async () => {
    const store = getStore();
    const { n1, n2, p1 } = await world(store);
    const id = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "depends-on");
    await mustLink(store, `notes/${n1}`, `papers/${p1}`, "references");

    await mut(store, "notes", "archive", { id: n2 });
    expect((await linkRow(store, id)).archived_at, "the link itself is untouched").toBeNull();
    const hidden = JSON.parse(await store.resolve(`mnemion://entry/notes/${n1}`));
    expect((hidden.linked ?? []).some((l: any) => l.pattern === "notes" && l.id === n2)).toBe(false);
    expect((hidden.linked ?? []).some((l: any) => l.pattern === "papers" && l.id === p1)).toBe(true);

    await mut(store, "notes", "unarchive", { id: n2 });
    const shown = JSON.parse(await store.resolve(`mnemion://entry/notes/${n1}`));
    expect(shown.linked.find((l: any) => l.pattern === "notes" && l.id === n2)).toMatchObject({ direction: "out", relation: "depends-on" });
  });

  it("an archived pattern's entries are hidden from the other endpoint's resolve until unarchived", async () => {
    const store = getStore();
    const { n1, p1 } = await world(store);
    await mustLink(store, `notes/${n1}`, `papers/${p1}`, "references");
    const ap = await propose(store, { type: "archive_pattern", pattern_name: "notes" });
    await apply(store, ap.change_id);
    const r = JSON.parse(await store.resolve(`mnemion://entry/papers/${p1}`));
    expect((r.linked ?? []).some((l: any) => l.pattern === "notes")).toBe(false);
  });

  it("prime's one-hop expansion never shows an archived endpoint", async () => {
    const store = getStore();
    await createPattern(store, "notes", "knowledge");
    const a = await entry(store, "notes", "alpha");
    const b = await entry(store, "notes", "beta");
    const c = await entry(store, "notes", "gamma");
    await mustLink(store, `notes/${a}`, `notes/${b}`, "references");
    await mustLink(store, `notes/${c}`, `notes/${a}`, "references");
    await mut(store, "notes", "archive", { id: b });
    await mut(store, "notes", "archive", { id: c });
    const result = await runInDurableObject(store, async (_i, state) => {
      const db = state.storage.sql;
      const ctx: PrimeContext = {
        db,
        patternExists: (n) => db.exec(`SELECT 1 FROM _objects WHERE name = ? AND archived_at IS NULL`, n).toArray().length > 0,
        env: {
          AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
          VECTORIZE: { query: async () => ({ matches: [{ id: `notes:${a}`, score: 0.9, metadata: { pattern: "notes", entry_id: a } }] }) },
        },
      };
      return prime(ctx, "alpha", undefined, 5);
    });
    const hit = result.results.find((r) => r.id === a)!;
    expect(hit).toBeDefined();
    expect((hit.linked ?? []).map((l) => l.id)).not.toContain(b);
    expect((hit.linked ?? []).map((l) => l.id)).not.toContain(c);
  });

  it("a dormant link still blocks a duplicate of itself", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    const id = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "references");
    await mut(store, "notes", "archive", { id: n2 });
    expectCleanRefusal(await link(store, `notes/${n1}`, `notes/${n2}`, "references"));
    await mut(store, "notes", "unarchive", { id: n2 });
    const rows = await sql(store, `SELECT id FROM "_links" WHERE archived_at IS NULL AND source_id = ? AND target_id = ? AND label = 'references'`, n1, n2);
    expect(rows.map((r) => r.id)).toEqual([id]);
  });

  it("a dormant link still counts for cardinality one, and the refusal names its endpoints", async () => {
    const store = getStore();
    const { n1, p1, p2 } = await world(store);
    await declare(store, { name: "filed-under", inverse: "files", source: ["notes"], target: ["papers"], cardinality: "one" });
    const id = await mustLink(store, `notes/${n1}`, `papers/${p1}`, "filed-under");
    await mut(store, "papers", "archive", { id: p1 });
    await boot(store);
    expect((await linkRow(store, id)).archived_at).toBeNull();

    const r = await link(store, `notes/${n1}`, `papers/${p2}`, "filed-under");
    expectCleanRefusal(r);
    expect(r.message).toContain(`notes/${n1}`);
    expect(r.message).toContain(`papers/${p1}`);
  });
});

// =====================================================================
// Resolve direction
// =====================================================================

describe("resolve direction", () => {
  it("linked items carry direction and the relation name read from the reader's side", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    await mustLink(store, `notes/${n1}`, `notes/${n2}`, "depends-on");

    const a = JSON.parse(await store.resolve(`mnemion://entry/notes/${n1}`));
    const out = a.linked.find((l: any) => l.pattern === "notes" && l.id === n2);
    expect(out).toMatchObject({ direction: "out", relation: "depends-on" });

    const b = JSON.parse(await store.resolve(`mnemion://entry/notes/${n2}`));
    const inn = b.linked.find((l: any) => l.pattern === "notes" && l.id === n1);
    expect(inn).toMatchObject({ direction: "in", relation: "required-by" });
  });

  it("one pair carrying two relations yields one linked item per relation", async () => {
    const store = getStore();
    const { n1, p1 } = await world(store);
    await mustLink(store, `notes/${n1}`, `papers/${p1}`, "references");
    await mustLink(store, `notes/${n1}`, `papers/${p1}`, "derived-from");
    const r = JSON.parse(await store.resolve(`mnemion://entry/papers/${p1}`));
    const fromN1 = r.linked.filter((l: any) => l.pattern === "notes" && l.id === n1);
    expect(fromN1.map((l: any) => l.relation).sort()).toEqual(["referenced-by", "source-of"]);
    expect(fromN1.every((l: any) => l.direction === "in")).toBe(true);
  });

  it("amending a relation's inverse changes how the target side reads it", async () => {
    const store = getStore();
    const { n1, p1 } = await world(store);
    await declare(store, { name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"] });
    await mustLink(store, `notes/${n1}`, `papers/${p1}`, "cites");
    const { applied } = await amend(store, { name: "cites", inverse: "is-cited-by" });
    expect(applied?.error).toBeUndefined();
    const r = JSON.parse(await store.resolve(`mnemion://entry/papers/${p1}`));
    expect(r.linked.find((l: any) => l.id === n1 && l.pattern === "notes")).toMatchObject({ direction: "in", relation: "is-cited-by" });
  });
});

// =====================================================================
// Relation vocabulary evolution: declare / amend / retire
// =====================================================================

describe("relation vocabulary evolution", () => {
  it("declare_relation previews, then applies, and is logged to _schema_history", async () => {
    const store = getStore();
    await world(store);
    const p = await propose(store, declareChange({ name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"] }));
    expect(p.error).toBeUndefined();
    expect(typeof p.change_id).toBe("string");
    expect(p.change_type).toBe("declare_relation");
    expect(await relationRow(store, "cites")).toBeUndefined(); // nothing before apply

    const a = await apply(store, p.change_id);
    expect(a.error).toBeUndefined();
    expect(a.applied).toBe(true);
    const row = await relationRow(store, "cites");
    expect(row).toMatchObject({ name: "cites", inverse: "cited-by", description: DESC("cites"), cardinality: "many", kernel: 0 });
    expect(await legacyOf(store, "cites")).toEqual({ legacy: false, legacy_debt: [] });
    expect(list(row.source)).toEqual(["notes"]);
    expect(list(row.target)).toEqual(["papers"]);
    expect(list(row.behaviors)).toEqual([]);
    const hist = await sql(store, `SELECT change_type FROM _schema_history WHERE change_type = 'declare_relation'`);
    expect(hist.length).toBe(1);
  });

  it("declare_relation defaults cardinality to many and accepts the Phase 1 palette", async () => {
    const store = getStore();
    await world(store);
    const change = declareChange({ name: "replaces", inverse: "replaced-by", behaviors: ["supersession", "acyclic"] });
    delete (change as any).cardinality;
    const p = await propose(store, change);
    expect(p.error).toBeUndefined();
    expect((await apply(store, p.change_id)).error).toBeUndefined();
    const row = await relationRow(store, "replaces");
    expect(row.cardinality).toBe("many");
    expect(new Set(list(row.behaviors))).toEqual(new Set(["supersession", "acyclic"]));
  });

  const REFUSALS: [string, Partial<RelSpec>, RegExp][] = [
    ["name not kebab-case", { name: "Cites Papers" }, /name/i],
    ["name reserved namespace", { name: "_cites" }, /name/i],
    ["name taken by a relation", { name: "references", inverse: "referred-to-by" }, /references/],
    ["name taken by an inverse", { name: "referenced-by", inverse: "refers-to" }, /referenced-by/],
    ["inverse missing", { inverse: undefined }, /inverse/i],
    ["inverse equal to name", { inverse: "cites" }, /inverse/i],
    ["inverse taken by a relation name", { inverse: "supersedes" }, /supersedes/],
    ["inverse taken by an inverse", { inverse: "superseded-by" }, /superseded-by/],
    ["description too short", { description: "Cites a paper." }, /description/i],
    ["description merely restates the name", { description: "cites ".repeat(25) }, /description/i],
    ["source pattern does not exist", { source: ["nosuch"] }, /nosuch/],
    ["target pattern does not exist", { target: ["nosuch"] }, /nosuch/],
    ["kernel source pattern", { source: ["_documents"] }, /_documents/],
    ["disallowed kernel target", { target: ["_members"] }, /_members/],
    ["unknown behavior", { behaviors: ["blocking"] }, /blocking/],
    ["required on a `*` source", { required: true, source: ["*"] }, /source/i],
    ["chain together with source/target/cardinality/behaviors", { chain: ["references", "depends-on"] }, /source|target|cardinality|behavio/i],
    ["cardinality outside one|many", { cardinality: "few" }, /cardinality/i],
    ["explicit null cardinality", { cardinality: null as any }, /cardinality/i],
    ["explicit null behaviors", { behaviors: null as any }, /behavio/i],
    ["explicit null inverse", { inverse: null as any }, /inverse/i],
    ["explicit null description", { description: null as any }, /description/i],
    ["explicit null source", { source: null }, /source/i],
    ["explicit null target", { target: null }, /target/i],
  ];

  it.each(REFUSALS)("declare_relation refuses: %s", async (_label, override, pattern) => {
    const store = getStore();
    await world(store);
    const change = declareChange({ name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"], ...override } as RelSpec);
    for (const [k, v] of Object.entries(change)) if (v === undefined) delete (change as any)[k];
    const p = await propose(store, change);
    expect(p.error).toBe(true);
    expect(p.message).toMatch(pattern);
    // Engine-authored, never raw SQLite text.
    expect(p.internal).toBeUndefined();
    expect(p.message).not.toMatch(/SQLITE|constraint failed/i);
    // The refusal leaves the vocabulary untouched.
    const names = (await sql(store, `SELECT name FROM "_relations" WHERE archived_at IS NULL`)).map((r) => r.name);
    expect(new Set(names)).toEqual(new Set(KERNEL_NAMES));
  });

  it("declare_relation admits _documents and _web_cache as targets", async () => {
    const store = getStore();
    await world(store);
    await declare(store, { name: "attaches", inverse: "attached-to", source: ["notes"], target: ["_documents", "_web_cache"] });
    expect(list((await relationRow(store, "attaches")).target).sort()).toEqual(["_documents", "_web_cache"]);
  });

  it("a retired name may be declared again", async () => {
    const store = getStore();
    await world(store);
    await declare(store, { name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"] });
    expect((await retire(store, "cites")).applied?.error).toBeUndefined();
    await declare(store, { name: "cites", inverse: "cited-by", source: ["papers"], target: ["papers"] });
    expect(list((await relationRow(store, "cites")).source)).toEqual(["papers"]);
  });

  it("amend_relation changes description, inverse, behaviors and cardinality, and logs it", async () => {
    const store = getStore();
    await world(store);
    await declare(store, { name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"] });
    const newDesc = DESC("cites") + " Amended to say more about when to prefer it over references.";
    const { proposed, applied } = await amend(store, {
      name: "cites", description: newDesc, inverse: "is-cited-by", behaviors: ["acyclic"], cardinality: "one",
    });
    expect(proposed.error).toBeUndefined();
    expect(applied.error).toBeUndefined();
    const row = await relationRow(store, "cites");
    expect(row).toMatchObject({ description: newDesc, inverse: "is-cited-by", cardinality: "one" });
    expect(list(row.behaviors)).toEqual(["acyclic"]);
    expect(list(row.source)).toEqual(["notes"]); // untouched
    const hist = await sql(store, `SELECT change_type FROM _schema_history WHERE change_type = 'amend_relation'`);
    expect(hist.length).toBe(1);
  });

  it("after amending the inverse, writes accept the new inverse and refuse the old one", async () => {
    const store = getStore();
    const { n1, n2, p1, p2 } = await world(store);
    await declare(store, { name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"] });
    await amend(store, { name: "cites", inverse: "is-cited-by" });
    expect((await link(store, `papers/${p1}`, `notes/${n1}`, "is-cited-by")).error).toBeUndefined();
    expect((await link(store, `papers/${p2}`, `notes/${n2}`, "cited-by")).error).toBe(true);
  });

  it("amend_relation keeps the name immutable and the quality bar", async () => {
    const store = getStore();
    await world(store);
    await declare(store, { name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"] });
    expect((await amend(store, { name: "cites", new_name: "quotes" })).proposed.error).toBe(true);
    expect((await amend(store, { name: "cites", description: "too short" })).proposed.error).toBe(true);
    expect((await amend(store, { name: "cites", inverse: "supersedes" })).proposed.error).toBe(true);
    expect((await amend(store, { name: "cites", inverse: "cites" })).proposed.error).toBe(true);
    const unknown = (await amend(store, { name: "cites", behaviors: ["blocking"] })).proposed;
    expect(unknown.error).toBe(true);
    expect(unknown.message).toMatch(/blocking/);
    expect((await amend(store, { name: "cites", cardinality: "few" })).proposed.error).toBe(true);
    expect((await amend(store, { name: "no-such-relation", description: DESC("x") })).proposed.error).toBe(true);
    expect(await relationRow(store, "quotes")).toBeUndefined();
    expect((await relationRow(store, "cites")).inverse).toBe("cited-by");
  });

  it("amend_relation refuses an explicit null for any field instead of clearing it", async () => {
    const store = getStore();
    await world(store);
    await declare(store, { name: "builds-on", inverse: "built-upon-by", source: ["notes"], target: ["notes"], behaviors: ["acyclic"], cardinality: "one" });
    const before = await relationRow(store, "builds-on");
    for (const field of ["behaviors", "cardinality", "inverse", "description"]) {
      const { proposed, applied } = await amend(store, { name: "builds-on", [field]: null });
      expect(proposed.error, `${field}: null is refused at propose`).toBe(true);
      expect(proposed.internal, field).toBeUndefined();
      expect(proposed.message, field).not.toMatch(/SQLITE|constraint failed/i);
      expect(applied, field).toBeNull();
    }
    const after = await relationRow(store, "builds-on");
    for (const k of ["inverse", "description", "cardinality", "behaviors", "source", "target"]) expect(after[k], k).toBe(before[k]);
    expect(list(after.behaviors)).toEqual(["acyclic"]);
  });

  // Phase 2: these payloads are refused for Phase 2 reasons (a required relation
  // on a `*` source; a chain that also declares stored-relation fields; new_name).
  it("over MCP, required / chain / new_name reach the engine and are refused with its message", async () => {
    const hiveId = `user:rel-mcp:${crypto.randomUUID()}`;
    const store = namedStore(hiveId);
    await declare(store, { name: "cites", inverse: "cited-by" });
    const { call } = await mcpSession(hiveId);
    const cases: Record<string, unknown>[] = [
      { ...declareChange({ name: "quotes", inverse: "quoted-by" }), required: true },
      { ...declareChange({ name: "quotes", inverse: "quoted-by" }), chain: ["references", "depends-on"] },
      { type: "amend_relation", name: "cites", new_name: "quotes" },
    ];
    for (const change of cases) {
      const engine = await propose(store, change);
      expect(engine.error, `engine refuses ${JSON.stringify(change).slice(0, 80)}`).toBe(true);
      const r = await call("propose_change", { description: "relations test", change });
      expect(r.isError, `MCP refuses ${JSON.stringify(change).slice(0, 80)}`).toBe(true);
      expect(r.content[0].text).toBe(engine.message);
    }
    expect(await relationRow(store, "quotes")).toBeUndefined();
    expect((await sql(store, `SELECT COUNT(*) AS n FROM _pending_changes`))[0].n).toBe(0);
  });

  it("kernel defaults cannot be amended or retired through change types", async () => {
    const store = getStore();
    for (const name of KERNEL_NAMES) {
      const a = (await amend(store, { name, description: DESC(name) })).proposed;
      expect(a.error, `amend ${name}`).toBe(true);
      expect(a.message, `amend ${name}`).toMatch(/kernel/i);
      const r = (await retire(store, name)).proposed;
      expect(r.error, `retire ${name}`).toBe(true);
      expect(r.message, `retire ${name}`).toMatch(/kernel/i);
    }
    expect((await sql(store, `SELECT name FROM "_relations" WHERE archived_at IS NULL AND kernel = 1`)).length).toBe(KERNEL_NAMES.length);
  });

  it("amending to cardinality one while links violate it: the preview lists them and apply is refused", async () => {
    const store = getStore();
    const { n1, p1, p2 } = await world(store);
    await declare(store, { name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"] });
    await mustLink(store, `notes/${n1}`, `papers/${p1}`, "cites");
    await mustLink(store, `notes/${n1}`, `papers/${p2}`, "cites");
    const { proposed, applied } = await amend(store, { name: "cites", cardinality: "one" });
    expect(proposed.error).toBeUndefined();
    expect(Array.isArray(proposed.preview?.violations)).toBe(true);
    expect(proposed.preview.violations.length).toBeGreaterThan(0);
    expect(proposed.preview.violations.map((v: any) => v.source)).toContain(`notes/${n1}`);
    expect(applied.error).toBe(true);
    expect((await relationRow(store, "cites")).cardinality).toBe("many");
  });

  it("adding acyclic while a cycle exists: the preview lists it and apply is refused", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    await declare(store, { name: "echoes", inverse: "echoed-by", source: ["notes"], target: ["notes"] });
    await mustLink(store, `notes/${n1}`, `notes/${n2}`, "echoes");
    await mustLink(store, `notes/${n2}`, `notes/${n1}`, "echoes");
    const { proposed, applied } = await amend(store, { name: "echoes", behaviors: ["acyclic"] });
    expect(proposed.error).toBeUndefined();
    expect(proposed.preview.violations.length).toBeGreaterThan(0);
    const ends = proposed.preview.violations.flatMap((v: any) => [v.source, v.target]);
    expect(ends).toEqual(expect.arrayContaining([`notes/${n1}`, `notes/${n2}`]));
    expect(applied.error).toBe(true);
    expect(list((await relationRow(store, "echoes")).behaviors)).toEqual([]);
    expect(await acyclicCycles(store)).toEqual([]);
  });

  it("apply re-checks: a violator that appears after propose still blocks the amend", async () => {
    const store = getStore();
    const { n1, p1, p2 } = await world(store);
    await declare(store, { name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"] });
    await mustLink(store, `notes/${n1}`, `papers/${p1}`, "cites");
    const p = await propose(store, { type: "amend_relation", name: "cites", cardinality: "one" });
    expect(p.error).toBeUndefined();
    expect(p.preview?.violations ?? []).toEqual([]);
    await mustLink(store, `notes/${n1}`, `papers/${p2}`, "cites");
    expect((await apply(store, p.change_id)).error).toBe(true);
    expect((await relationRow(store, "cites")).cardinality).toBe("many");
    expect(await totalityViolations(store)).toEqual([]);
  });

  // Owner decision (Phase 2): legacy debt is two facts, a placeholder description
  // and a migration-generated inverse. A relation stays legacy until both are paid.
  it("legacy debt: a description-only amend keeps the relation legacy, the warning naming the generated inverse", async () => {
    const store = getStore();
    await seedLegacyLinks(store);
    await boot(store);
    const { applied } = await amend(store, { name: "refines", description: DESC("refines") });
    expect(applied.error).toBeUndefined();
    expect((await relationRow(store, "refines")).description).toBe(DESC("refines"));
    expect(await legacyOf(store, "refines")).toEqual({ legacy: true, legacy_debt: ["generated inverse"] });
    const lines = await warnLines(() => boot(store));
    const mine = lines.filter((l) => l.includes("refines"));
    expect(mine.join(" | ")).toMatch(/generated inverse/);
    expect(mine.join(" | ")).not.toMatch(/placeholder description/);
    const index = JSON.parse(await store.getIndex());
    expect(index.relations.find((r: any) => r.name === "refines")).toMatchObject({ legacy: true, legacy_debt: ["generated inverse"] });
  });

  it("legacy debt: an inverse-only amend keeps the relation legacy, the warning naming the placeholder description", async () => {
    const store = getStore();
    await seedLegacyLinks(store);
    await boot(store);
    expect((await amend(store, { name: "refines", inverse: "refined-by" })).applied.error).toBeUndefined();
    expect(await legacyOf(store, "refines")).toEqual({ legacy: true, legacy_debt: ["placeholder description"] });
    const lines = (await warnLines(() => boot(store))).filter((l) => l.includes("refines"));
    expect(lines.join(" | ")).toMatch(/placeholder description/);
    expect(lines.join(" | ")).not.toMatch(/generated inverse/);
  });

  it("legacy debt: paying both, in one amend or across two, clears legacy", async () => {
    const store = getStore();
    await seedLegacyLinks(store);
    await boot(store);
    await amend(store, { name: "refines", description: DESC("refines") });
    await amend(store, { name: "refines", inverse: "refined-by" });
    expect(await legacyOf(store, "refines")).toEqual({ legacy: false, legacy_debt: [] });
    await amend(store, { name: "ethos-grounds", description: DESC("ethos-grounds"), inverse: "grounded-in-ethos-of" });
    expect(await legacyOf(store, "ethos-grounds")).toEqual({ legacy: false, legacy_debt: [] });
    const lines = await warnLines(() => boot(store));
    expect(lines.some((l) => l.includes("refines") || l.includes("ethos-grounds"))).toBe(false);
  });

  it("legacy debt: declared-from-scratch relations are never legacy; the generated inverse form is reserved", async () => {
    const store = getStore();
    await world(store);
    await declare(store, { name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"] });
    expect(await legacyOf(store, "cites")).toEqual({ legacy: false, legacy_debt: [] });
    // The migration's own naming is not an owner choice: it can't be declared or amended in.
    for (const inv of ["quotes-inverse", "quotes-inverse-2"]) {
      const p = await propose(store, declareChange({ name: "quotes", inverse: inv }));
      expect(p.error, inv).toBe(true);
      expect(p.message, inv).toMatch(/reserved|generated/i);
    }
    const a = (await amend(store, { name: "cites", inverse: "cites-inverse" })).proposed;
    expect(a.error).toBe(true);
    expect(a.message).toMatch(/reserved|generated/i);
  });

  it("legacy debt is derived, never stored: an upgraded row whose description was already amended reports its inverse debt", async () => {
    const store = getStore();
    await seedLegacyLinks(store);
    await boot(store);
    // A Phase 1 hive amended the description, which cleared the old stored flag.
    await runInDurableObject(store, (_i, state) => {
      const db = state.storage.sql;
      db.exec(`UPDATE "_relations" SET description = ? WHERE name = 'refines'`, DESC("refines"));
      try { db.exec(`UPDATE "_relations" SET legacy = 0 WHERE name = 'refines'`); } catch { /* column already gone */ }
    });
    await boot(store);
    expect(await legacyOf(store, "refines")).toEqual({ legacy: true, legacy_debt: ["generated inverse"] });
    // No stored flag remains to drift from the facts.
    expect((await sql(store, `PRAGMA table_info("_relations")`)).map((c) => c.name)).not.toContain("legacy");
  });

  it("retire_relation is refused while active links use it; the preview names them", async () => {
    const store = getStore();
    const { n1, p1 } = await world(store);
    await declare(store, { name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"] });
    const id = await mustLink(store, `notes/${n1}`, `papers/${p1}`, "cites");

    const { proposed, applied } = await retire(store, "cites");
    expect(proposed.error).toBeUndefined();
    expect(proposed.preview.violations).toEqual([expect.objectContaining({ source: `notes/${n1}`, target: `papers/${p1}` })]);
    expect(applied.error).toBe(true);
    expect(await relationRow(store, "cites")).toBeDefined();

    await mut(store, "_links", "archive", { id });
    const again = await retire(store, "cites");
    expect(again.proposed.error).toBeUndefined();
    expect(again.applied.error).toBeUndefined();
    expect(await relationRow(store, "cites")).toBeUndefined();
    expect((await link(store, `notes/${n1}`, `papers/${p1}`, "cites")).error).toBe(true);
    const hist = await sql(store, `SELECT change_type FROM _schema_history WHERE change_type = 'retire_relation'`);
    expect(hist.length).toBe(1);
  });

  it("retire_relation refuses an unknown relation", async () => {
    const store = getStore();
    const r = (await retire(store, "no-such-relation")).proposed;
    expect(r.error).toBe(true);
    expect(r.message).toContain("no-such-relation");
  });
});

// =====================================================================
// Unlink: one pair may carry several relations, so unlink must name which
// =====================================================================

const unlink = (store: Store, data: Record<string, unknown>) => mut(store, "unlink", "unlink", data);

describe("unlink", () => {
  it("with a label, archives exactly that relation's link and leaves the pair's other relations", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    const refs = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "references");
    const dep = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "depends-on");
    const back = await mustLink(store, `notes/${n2}`, `notes/${n1}`, "references");

    const r = await unlink(store, { source: `notes/${n1}`, target: `notes/${n2}`, label: "depends-on" });
    expect(r.error).toBeUndefined();
    expect(r.id).toBe(dep);
    expect((await linkRow(store, dep)).archived_at).not.toBeNull();
    expect((await linkRow(store, refs)).archived_at).toBeNull();
    expect((await linkRow(store, back)).archived_at).toBeNull();
  });

  it("an inverse label is normalized by swapping source and target, as on create", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    const refs = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "references");
    const dep = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "depends-on");
    // "n2 required-by n1" names the stored row "n1 depends-on n2".
    const r = await unlink(store, { source: `notes/${n2}`, target: `notes/${n1}`, label: "required-by" });
    expect(r.error).toBeUndefined();
    expect(r.id).toBe(dep);
    expect((await linkRow(store, dep)).archived_at).not.toBeNull();
    expect((await linkRow(store, refs)).archived_at).toBeNull();
  });

  it("with a label that has no active link on the pair, refuses cleanly and archives nothing", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    const refs = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "references");
    const dep = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "depends-on");
    for (const label of ["derived-from", "superseded-by", "no-such-relation"]) {
      expectCleanRefusal(await unlink(store, { source: `notes/${n1}`, target: `notes/${n2}`, label }));
    }
    // The reverse direction of an existing link is a different pair: refused, not matched.
    expectCleanRefusal(await unlink(store, { source: `notes/${n2}`, target: `notes/${n1}`, label: "depends-on" }));
    expect((await linkRow(store, refs)).archived_at).toBeNull();
    expect((await linkRow(store, dep)).archived_at).toBeNull();
  });

  it("without a label, archives the pair's only active link (backward compatible)", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    const refs = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "references");
    const r = await unlink(store, { source: `notes/${n1}`, target: `notes/${n2}` });
    expect(r.error).toBeUndefined();
    expect(r.id).toBe(refs);
    expect((await linkRow(store, refs)).archived_at).not.toBeNull();
  });

  it("without a label, refuses when the pair carries several relations, naming them", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    const refs = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "references");
    const dep = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "depends-on");
    const r = await unlink(store, { source: `notes/${n1}`, target: `notes/${n2}` });
    expectCleanRefusal(r);
    expect(Array.isArray(r.labels)).toBe(true);
    expect([...r.labels].sort()).toEqual(["depends-on", "references"]);
    expect(r.message).toContain("references");
    expect(r.message).toContain("depends-on");
    expect((await linkRow(store, refs)).archived_at).toBeNull();
    expect((await linkRow(store, dep)).archived_at).toBeNull();
  });

  it("refuses a malformed source or target shorthand instead of ignoring it", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    const refs = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "references");
    const explicit = { source_pattern: "notes", source_id: n1, target_pattern: "notes", target_id: n2 };
    for (const data of [
      { source: "notes", target: `notes/${n2}` },
      { source: `notes/${n1}/7`, target: `notes/${n2}` },
      { source: `notes/abc`, target: `notes/${n2}` },
      { source: `notes/${n1}`, target: "" },
      // A malformed shorthand beside valid explicit fields is still refused, never skipped.
      { ...explicit, source: "garbage" },
      { ...explicit, target: "notes/x/y", label: "references" },
    ]) {
      const r = await unlink(store, data);
      expectCleanRefusal(r);
      expect(r.message, JSON.stringify(data)).toMatch(/pattern\/id/);
    }
    expect((await linkRow(store, refs)).archived_at).toBeNull();
  });
});

// =====================================================================
// Linked targets survive GC (§4a)
// =====================================================================

describe("linked targets survive GC", () => {
  /** Archive a user pattern through the change type, then backdate the archive. */
  async function archivePatternDaysAgo(store: Store, name: string, days: number) {
    const ap = await propose(store, { type: "archive_pattern", pattern_name: name });
    expect((await apply(store, ap.change_id)).error).toBeUndefined();
    await sql(store, `UPDATE _objects SET archived_at = datetime('now', '-${days} days') WHERE name = ?`, name);
  }
  const tableExists = async (store: Store, name: string) =>
    (await sql(store, `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name)).length > 0;

  it("an archived pattern targeted by a link from outside it is not dropped after 30 days", async () => {
    const store = getStore();
    const { n1 } = await world(store);
    await createPattern(store, "drafts");
    const d1 = await entry(store, "drafts", "draft");
    const id = await mustLink(store, `notes/${n1}`, `drafts/${d1}`, "references");
    await archivePatternDaysAgo(store, "drafts", 31);

    await boot(store);
    expect(await tableExists(store, "drafts"), "the table survives").toBe(true);
    expect((await sql(store, `SELECT archived_at FROM _objects WHERE name = 'drafts'`))[0]?.archived_at, "still archived").not.toBeNull();
    expect((await linkRow(store, id)).archived_at, "the link stays active (dormant)").toBeNull();

    const up = await propose(store, { type: "unarchive_pattern", pattern_name: "drafts" });
    expect((await apply(store, up.change_id)).error).toBeUndefined();
    const r = JSON.parse(await store.resolve(`mnemion://entry/notes/${n1}`));
    expect(r.linked.find((l: any) => l.pattern === "drafts" && l.id === d1)).toMatchObject({ direction: "out", relation: "references" });
  });

  it("once the inbound link is archived, the 30-day drop proceeds (protection is derived, not sticky)", async () => {
    const store = getStore();
    const { n1 } = await world(store);
    await createPattern(store, "drafts");
    const d1 = await entry(store, "drafts", "draft");
    const id = await mustLink(store, `notes/${n1}`, `drafts/${d1}`, "references");
    expect((await mut(store, "_links", "archive", { id })).error).toBeUndefined();
    await archivePatternDaysAgo(store, "drafts", 31);
    await boot(store);
    expect(await tableExists(store, "drafts")).toBe(false);
  });

  const held = async (store: Store) => {
    const stale = JSON.parse(await store.resolve("mnemion://stale"));
    return stale.held_patterns as any[] | undefined;
  };

  it("mutually-linked archived patterns past the horizon are both held, reported in the stale view, and survive boot", async () => {
    const store = getStore();
    await createPattern(store, "drafts");
    await createPattern(store, "sketches");
    const d1 = await entry(store, "drafts", "draft"), s1 = await entry(store, "sketches", "sketch");
    await mustLink(store, `drafts/${d1}`, `sketches/${s1}`, "references");
    await mustLink(store, `sketches/${s1}`, `drafts/${d1}`, "derived-from");
    await archivePatternDaysAgo(store, "drafts", 31);
    await archivePatternDaysAgo(store, "sketches", 33);

    await boot(store);
    expect(await tableExists(store, "drafts")).toBe(true);
    expect(await tableExists(store, "sketches")).toBe(true);

    const list_ = await held(store);
    expect(Array.isArray(list_)).toBe(true);
    const drafts = list_!.find((h) => h.pattern === "drafts");
    const sketches = list_!.find((h) => h.pattern === "sketches");
    expect(drafts).toMatchObject({ pattern: "drafts", archived_at: expect.any(String) });
    expect(drafts.days_archived).toBeGreaterThanOrEqual(31);
    expect(drafts.held_by).toEqual([{ source: `sketches/${s1}`, target: `drafts/${d1}`, label: "derived-from" }]);
    expect(sketches.days_archived).toBeGreaterThanOrEqual(33);
    expect(sketches.held_by).toEqual([{ source: `drafts/${d1}`, target: `sketches/${s1}`, label: "references" }]);
  });

  it("an archived pattern held by a link from a live pattern is reported with that link", async () => {
    const store = getStore();
    const { n1 } = await world(store);
    await createPattern(store, "drafts");
    const d1 = await entry(store, "drafts", "draft");
    await mustLink(store, `notes/${n1}`, `drafts/${d1}`, "references");
    await archivePatternDaysAgo(store, "drafts", 31);
    await boot(store);
    const h = (await held(store))?.find((x) => x.pattern === "drafts");
    expect(h).toBeDefined();
    expect(h.held_by).toEqual([{ source: `notes/${n1}`, target: `drafts/${d1}`, label: "references" }]);
  });

  it("held_by lists only links from outside the pattern, never its internal links", async () => {
    const store = getStore();
    const { n1 } = await world(store);
    await createPattern(store, "drafts");
    const d1 = await entry(store, "drafts", "one"), d2 = await entry(store, "drafts", "two");
    await mustLink(store, `notes/${n1}`, `drafts/${d1}`, "references");   // from outside: holds
    await mustLink(store, `drafts/${d2}`, `drafts/${d1}`, "derived-from"); // internal: never holds
    await archivePatternDaysAgo(store, "drafts", 31);
    await boot(store);
    const h = (await held(store))?.find((x) => x.pattern === "drafts");
    expect(h, "drafts is held").toBeDefined();
    expect(h.held_by).toEqual([{ source: `notes/${n1}`, target: `drafts/${d1}`, label: "references" }]);
    expect(h.held_by.some((l: any) => l.source === `drafts/${d2}`), "the internal link is absent").toBe(false);
  });

  it("an archived pattern under the 30-day horizon is not reported; nothing held means an empty array", async () => {
    const store = getStore();
    const { n1 } = await world(store);
    expect(await held(store)).toEqual([]);
    await createPattern(store, "drafts");
    const d1 = await entry(store, "drafts", "draft");
    await mustLink(store, `notes/${n1}`, `drafts/${d1}`, "references");
    await archivePatternDaysAgo(store, "drafts", 10);
    await boot(store);
    expect(await held(store)).toEqual([]);
  });

  it("once the holding link is archived, the pattern is no longer reported and the next boot drops it", async () => {
    const store = getStore();
    const { n1 } = await world(store);
    await createPattern(store, "drafts");
    const d1 = await entry(store, "drafts", "draft");
    const id = await mustLink(store, `notes/${n1}`, `drafts/${d1}`, "references");
    await archivePatternDaysAgo(store, "drafts", 31);
    expect((await mut(store, "_links", "archive", { id })).error).toBeUndefined();
    expect(((await held(store)) ?? []).some((x) => x.pattern === "drafts")).toBe(false);
    await boot(store);
    expect(await tableExists(store, "drafts")).toBe(false);
  });

  it("an archived pattern whose only links are internal still drops after 30 days", async () => {
    const store = getStore();
    await createPattern(store, "drafts");
    const d1 = await entry(store, "drafts", "one"), d2 = await entry(store, "drafts", "two");
    const id = await mustLink(store, `drafts/${d1}`, `drafts/${d2}`, "references");
    await archivePatternDaysAgo(store, "drafts", 31);
    await boot(store);
    expect(await tableExists(store, "drafts")).toBe(false);
    await boot(store); // the next pass sweeps links whose pattern is gone
    expect((await linkRow(store, id)).archived_at).not.toBeNull();
  });

  it("a linked _web_cache row past its TTL and grace window survives GC until the link is archived", async () => {
    const store = getStore();
    const { n1 } = await world(store);
    const linked = await insertWebCache(store, "https://example.com/linked");
    const control = await insertWebCache(store, "https://example.com/unlinked");
    const linkId = await mustLink(store, `notes/${n1}`, `_web_cache/${linked}`, "references");

    // A re-fetch superseded both snapshots long ago: archived past the 7-day grace,
    // expired past their TTL, not pinned — exactly what the GC deletes.
    await sql(store, `UPDATE "_web_cache" SET archived_at = datetime('now', '-30 days'), expires_at = datetime('now', '-60 days'), pinned = 0 WHERE id IN (?, ?)`, linked, control);

    await boot(store);
    const ids = async () => (await sql(store, `SELECT id FROM "_web_cache"`)).map((r) => r.id);
    expect(await ids(), "GC really collects an unlinked row like this").not.toContain(control);
    expect(await ids(), "the linked row survives").toContain(linked);
    expect((await linkRow(store, linkId)).archived_at, "the protecting link is dormant, not swept").toBeNull();

    await boot(store);
    expect(await ids(), "protection holds on every pass").toContain(linked);

    expect((await mut(store, "_links", "archive", { id: linkId })).error).toBeUndefined();
    await boot(store);
    expect(await ids(), "archiving the link makes the row collectable again").not.toContain(linked);
  });
});

// =====================================================================
// Restore point: the first v17 boot records a PITR bookmark before touching data
// =====================================================================

/** What a constructed HiveDO did while booting on a wrapped state. */
interface BootTrace { events: string[]; restored: string[]; sent?: string[]; unpatch?: () => void }

/** Classify a SQL statement as a v17 (relations migration) effect, or null. */
function v17Effect(q: string): string | null {
  if (/DROP\s+INDEX[^;]*_links_pair_active/i.test(q)) return "v17:drop-pair-index";
  if (/CREATE\s+TABLE[^(]*"?_relations"?\s*\(/i.test(q)) return "v17:create-relations";
  if (/INSERT\s+INTO\s+"?_relations"?/i.test(q)) return "v17:write-relations";
  if (/UPDATE\s+"?_links"?\s+SET/i.test(q)) return "v17:update-links";
  // A change's own data effects (applyChange's handler.apply), for bookmark ordering.
  if (/ALTER\s+TABLE\s+"?(?!_)[\w-]+"?\s+DROP\s+COLUMN/i.test(q)) return "change:drop-column";
  if (/UPDATE\s+_objects\s+SET\s+doctrine/i.test(q)) return "change:set-doctrine";
  // v18 (Phase 2): the stored legacy flag leaves _relations.
  if (/ALTER\s+TABLE\s+"?_relations"?\s+DROP\s+COLUMN\s+"?legacy"?/i.test(q)) return "v18:drop-legacy-column";
  if (/DROP\s+TABLE\s+(IF\s+EXISTS\s+)?"?_relations"?/i.test(q)) return "v18:rebuild-relations";
  return null;
}

/**
 * Construct a real HiveDO on this DO's own storage (so its constructor runs the
 * whole boot sequence), with three storage hooks stubbed: getCurrentBookmark
 * (returns or throws per `bookmark`), onNextSessionRestoreBookmark, and abort.
 * Every SQL statement that is a v17 effect is recorded in order beside the
 * "bookmark" capture, so tests can prove the capture came first.
 */
async function bootWith(state: DurableObjectState, bookmark: () => string, trace: BootTrace): Promise<HiveDO> {
  // The runtime only accepts a real DurableObjectState, so the hooks are patched
  // onto this DO's own state/storage for the duration of the constructor (and
  // the returned instance's later calls); `unpatch` restores each original
  // property descriptor exactly.
  const storage = state.storage as any;
  const sqlReal = storage.sql;
  const sql = new Proxy(sqlReal, {
    get(t, k) {
      if (k === "exec") return (q: string, ...p: unknown[]) => { const e = v17Effect(q); if (e) trace.events.push(e); return t.exec(q, ...p); };
      const v = t[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const pending: Promise<unknown>[] = [];
  const saved: [any, string, PropertyDescriptor | undefined][] = [];
  const patch = (o: any, k: string, d: PropertyDescriptor) => {
    saved.push([o, k, Object.getOwnPropertyDescriptor(o, k)]);
    Object.defineProperty(o, k, { configurable: true, ...d });
  };
  patch(storage, "sql", { get: () => sql });
  patch(storage, "getCurrentBookmark", { value: async () => { trace.events.push("bookmark"); return bookmark(); } });
  patch(storage, "onNextSessionRestoreBookmark", { value: async (b: string) => { trace.restored.push(b); return b; } });
  patch(state, "blockConcurrencyWhile", { value: (fn: () => Promise<unknown>) => { const p = Promise.resolve().then(fn); pending.push(p); return p; } });
  patch(state, "abort", { value: () => { trace.events.push("abort"); } });
  // /ws broadcasts: one fake socket records every message the instance sends.
  patch(state, "getWebSockets", { value: () => [{ send: (m: string) => { (trace.sent ??= []).push(m); } }] });
  trace.unpatch = () => {
    for (const [o, k, d] of saved.reverse()) {
      if (d) Object.defineProperty(o, k, d); else delete o[k];
    }
  };
  const hive = new HiveDO(state, env);
  await Promise.all(pending);
  return hive;
}

/** Boot on patched hooks, run `body` with the instance and its trace, always unpatch. */
async function booted<T>(state: DurableObjectState, bookmark: () => string, body: (hive: HiveDO, trace: BootTrace) => Promise<T>): Promise<T> {
  const trace: BootTrace = { events: [], restored: [] };
  try {
    const hive = await bootWith(state, bookmark, trace);
    return await body(hive, trace);
  } finally { trace.unpatch?.(); }
}

/** Put this hive back in its pre-v17 shape: no `_relations` (table, metadata or
 *  history), the old pair-only unique index, and some links worth migrating. */
function makePreV17(db: any) {
  db.exec(`DELETE FROM _schema_history WHERE change_type = 'restore_point'`);
  db.exec(`DROP TABLE IF EXISTS "_relations"`);
  db.exec(`DELETE FROM _fields WHERE object_name = '_relations'`);
  db.exec(`DELETE FROM _objects WHERE name = '_relations'`);
  db.exec(`DROP INDEX IF EXISTS "_links_pair_active"`);
  db.exec(`CREATE UNIQUE INDEX "_links_pair_active" ON "_links" ("source_pattern", "source_id", "target_pattern", "target_id") WHERE archived_at IS NULL`);
}

const restorePoints = (db: any) =>
  db.exec(`SELECT * FROM _schema_history WHERE change_type = 'restore_point' ORDER BY id`).toArray() as any[];

/** Every migration declared in schema.ts MIGRATION_RESTORE_POINTS, read from the
 *  source (the list is module-private). */
function declaredRestorePointMigrations(): string[] {
  const block = SCHEMA_SRC.match(/\bMIGRATION_RESTORE_POINTS\b[^\n]*\]\s*=\s*\[([\s\S]*?)\n\];/);
  if (!block) throw new Error("MIGRATION_RESTORE_POINTS not found in entities/Hive/schema.ts");
  return [...block[1].matchAll(/migration:\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** Each declared restore point → the `it` in the "restore point" describe that covers it. */
const RESTORE_POINT_COVERED_BY: Record<string, string> = {
  v17: "the first v17 boot records exactly one restore_point row; later boots add none",
  v18: "a Phase 1-shaped hive records exactly one v18 restore point before the legacy column leaves; later boots add none",
};

/** Give a booted (Phase 2) hive the Phase 1 shape v18 migrates: the stored legacy flag. */
function makePhase1Relations(db: any) {
  db.exec(`DELETE FROM _schema_history WHERE change_type = 'restore_point'`);
  db.exec(`ALTER TABLE "_relations" ADD COLUMN "legacy" INTEGER NOT NULL DEFAULT 0`);
}

describe("restore point", () => {
  async function preV17Store() {
    const store = getStore();
    await seedLegacyLinks(store); // pre-registry links: unlabeled, legacy labels, supersedes
    await runInDurableObject(store, (_i, state) => makePreV17(state.storage.sql));
    return store;
  }
  const hasRelationsTable = (state: DurableObjectState) =>
    state.storage.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_relations'`).toArray().length === 1;

  it("the first v17 boot records exactly one restore_point row; later boots add none", async () => {
    const store = await preV17Store();
    await runInDurableObject(store, async (_i, state) => {
      await booted(state, () => "bm-before-v17", async () => {});
      const rows = restorePoints(state.storage.sql);
      expect(rows.length).toBe(1);
      expect(rows[0].description).toMatch(/restore point/i);
      expect(rows[0].description).toMatch(/relations/i);
      expect(rows[0].bookmark).toBe("bm-before-v17");
      expect(hasRelationsTable(state), "the migration really ran on that boot").toBe(true);

      await booted(state, () => "bm-later", async () => {});
      await booted(state, () => "bm-later-still", async () => {});
      expect(restorePoints(state.storage.sql).length).toBe(1);
      expect(restorePoints(state.storage.sql)[0].bookmark).toBe("bm-before-v17");
    });
  });

  it("a Phase 1-shaped hive records exactly one v18 restore point before the legacy column leaves; later boots add none", async () => {
    const store = getStore();
    await seedLegacyLinks(store);
    await boot(store);
    await runInDurableObject(store, async (_i, state) => {
      const db = state.storage.sql;
      makePhase1Relations(db);
      await booted(state, () => "bm-before-v18", async (_hive, trace) => {
        const first = trace.events.findIndex((e) => e.startsWith("v18:"));
        expect(first, `a v18 step ran: ${trace.events.join(", ")}`).toBeGreaterThanOrEqual(0);
        expect(trace.events.indexOf("bookmark"), "the bookmark was captured").toBeGreaterThanOrEqual(0);
        expect(trace.events.indexOf("bookmark"), `capture precedes every v18 effect: ${trace.events.join(", ")}`).toBeLessThan(first);
      });
      const rows = restorePoints(db);
      expect(rows.length, "one restore point, v18 only").toBe(1);
      expect(rows[0].description).toMatch(/restore point/i);
      expect(rows[0].description).toMatch(/v18/);
      expect(rows[0].bookmark).toBe("bm-before-v18");
      expect((db.exec(`PRAGMA table_info("_relations")`).toArray() as any[]).map((c) => c.name)).not.toContain("legacy");

      await booted(state, () => "bm-later", async () => {});
      await booted(state, () => "bm-later-still", async () => {});
      expect(restorePoints(db).length).toBe(1);
    });
  });

  // Production shape (hotfix, 2026-10-19): on a deployed Phase 1 hive the boot had
  // already built _relations' audit triggers, and they list EVERY column, including
  // `legacy`. SQLite refuses `DROP COLUMN` on a column a trigger references, so a plain
  // drop threw, migrateRelations aborted before the kernel refresh (part-of never
  // gained containment), and the column's survival made v18's restore point re-record
  // on every cold start. The fixture above adds `legacy` AFTER the triggers exist, so
  // no trigger names it; this one rebuilds the triggers so they do, as production had.
  it("a production Phase 1 hive, whose audit triggers name the legacy column, completes v18 on one boot", async () => {
    const store = getStore();
    await seedLegacyLinks(store);
    await boot(store);
    await runInDurableObject(store, async (_i, state) => {
      const db = state.storage.sql;
      makePhase1Relations(db);
      ensureAuditTriggers(db, "_relations"); // triggers now reference `legacy`, as on production
      db.exec(`UPDATE "_relations" SET behaviors = '["acyclic"]' WHERE name = 'part-of'`); // Phase 1's part-of
      const triggerSql = (db.exec(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = '_relations'`).toArray() as any[]).map((r) => r.sql).join("\n");
      expect(triggerSql, "the fixture really reproduces production: a trigger names legacy").toMatch(/legacy/);

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await booted(state, () => "bm-prod-v18", async () => {});
        await booted(state, () => "bm-prod-later", async () => {});
        await booted(state, () => "bm-prod-later-still", async () => {});
        const warned = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
        expect(warned, "the relations migration must not fail").not.toMatch(/relations migration failed/i);
      } finally {
        warn.mockRestore();
      }

      expect((db.exec(`PRAGMA table_info("_relations")`).toArray() as any[]).map((c) => c.name), "the legacy column left").not.toContain("legacy");
      const partOf = db.exec(`SELECT behaviors FROM "_relations" WHERE name = 'part-of' AND archived_at IS NULL`).toArray()[0] as any;
      expect(JSON.parse(partOf.behaviors), "the kernel refresh ran: part-of gained containment").toContain("containment");
      const rows = restorePoints(db);
      expect(rows.length, `exactly one restore point across three boots: ${rows.map((r) => r.bookmark).join(", ")}`).toBe(1);
      expect(rows[0].bookmark).toBe("bm-prod-v18");
      // The audit trail still works on _relations after the column left.
      const after = (db.exec(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = '_relations'`).toArray() as any[]).map((r) => r.sql).join("\n");
      expect(after, "audit triggers exist again").toMatch(/_audit__relations_/);
      expect(after, "and no longer name legacy").not.toMatch(/legacy/);
    });
  });

  it("a fresh hive's first boot records the v17 restore point only, never v18 too", async () => {
    const store = getStore();
    await runInDurableObject(store, async (_i, state) => {
      const db = state.storage.sql;
      makePreV17(db); // as close to empty as a constructed DO gets: no _relations at all
      await booted(state, () => "bm-fresh", async () => {});
      const rows = restorePoints(db);
      expect(rows.map((r) => r.description).join(" | ")).toMatch(/v17/);
      expect(rows.length, rows.map((r) => r.description).join(" | ")).toBe(1);
      expect(rows[0].description).not.toMatch(/v18/);
    });
  });

  it("every MIGRATION_RESTORE_POINTS entry has a covering test in this describe", () => {
    const declared = declaredRestorePointMigrations();
    expect(declared.length, "the list is read from schema.ts").toBeGreaterThan(0);
    expect(new Set(declared)).toEqual(new Set(Object.keys(RESTORE_POINT_COVERED_BY)));
    for (const [migration, title] of Object.entries(RESTORE_POINT_COVERED_BY))
      expect(THIS_FILE_SRC, `${migration} → it("${title}")`).toContain(`it(${JSON.stringify(title)}`);
  });

  it("captures the bookmark before any v17 step touches data", async () => {
    const store = await preV17Store();
    await runInDurableObject(store, async (_i, state) => {
      await booted(state, () => "bm-first", async (_hive, trace) => {
        const first = trace.events.findIndex((e) => e.startsWith("v17:"));
        expect(trace.events, "the v17 steps ran (the ordering check is not vacuous)").toEqual(
          expect.arrayContaining(["v17:create-relations", "v17:drop-pair-index", "v17:write-relations"]));
        expect(trace.events.indexOf("bookmark"), "the bookmark was captured").toBeGreaterThanOrEqual(0);
        expect(trace.events.indexOf("bookmark"), `capture precedes every v17 effect: ${trace.events.join(", ")}`).toBeLessThan(first);
      });
      expect(restorePoints(state.storage.sql)[0]?.bookmark).toBe("bm-first");
    });
  });

  it("reverting the restore point hands exactly the stored bookmark to the existing restore hook", async () => {
    const store = await preV17Store();
    await runInDurableObject(store, async (_i, state) => {
      await booted(state, () => "bm-to-restore", async (hive, trace) => {
        const row = restorePoints(state.storage.sql)[0];
        expect(row, "a restore point exists").toBeDefined();
        const r = JSON.parse(await hive.revertChange(row.id));
        expect(r.error).toBeUndefined();
        expect(r.reverted).toBe(true);
        expect(trace.restored).toEqual(["bm-to-restore"]);
        expect(trace.events).toContain("abort");
      });
    });
  });

  it("with no bookmark available, boot still succeeds, the row holds NULL, and revert says rollback is unavailable", async () => {
    const store = await preV17Store();
    await runInDurableObject(store, async (_i, state) => {
      await booted(state, () => { throw new Error("bookmarks unavailable in local dev"); }, async (hive, trace) => {
        const rows = restorePoints(state.storage.sql);
        expect(rows.length).toBe(1);
        expect(rows[0].bookmark).toBeNull();
        expect(hasRelationsTable(state), "the migration still ran").toBe(true);
        const r = JSON.parse(await hive.revertChange(rows[0].id));
        expect(r.error).toBe(true);
        expect(r.message).toMatch(/unavailable/i);
        expect(trace.restored).toEqual([]);
        expect(trace.events).not.toContain("abort");
      });
    });
  });
});

// =====================================================================
// Palette totality: every behavior in the palette has an enforcement test
// =====================================================================

const RELATIONS_MODULE = import.meta.glob("../../entities/Hive/relations.ts", { eager: true }) as Record<string, any>;


/** Each palette behavior → the describe in this file that proves the engine enforces it. */
const ENFORCED_BY: Record<string, string> = {
  supersession: "behavior by declaration",
  acyclic: "acyclicity",
  containment: "containment",
};

describe("palette totality", () => {
  it("entities/Hive/relations.ts exists and exports BEHAVIOR_PALETTE", () => {
    const mod = RELATIONS_MODULE[RELATIONS_MODULE_PATH];
    expect(mod, "entities/Hive/relations.ts must exist").toBeDefined();
    expect(mod.BEHAVIOR_PALETTE, "relations.ts must export BEHAVIOR_PALETTE").toBeTypeOf("object");
    expect(Array.isArray(mod.BEHAVIOR_PALETTE), "BEHAVIOR_PALETTE is a table keyed by behavior name").toBe(false);
  });

  it("every palette behavior maps to an enforcement describe in this file, and nothing else does", () => {
    const palette = Object.keys(RELATIONS_MODULE[RELATIONS_MODULE_PATH]?.BEHAVIOR_PALETTE ?? {});
    expect(new Set(palette)).toEqual(new Set(Object.keys(ENFORCED_BY)));
    const src = THIS_FILE_SRC;
    expect(src, "this test file reads itself").toBeTypeOf("string");
    // Anchored at line start: only a real top-level describe counts, not a mention in a string.
    const topLevelDescribe = (name: string) =>
      new RegExp(`^describe\\(${JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m");
    expect(src, "the raw source is this file").toMatch(topLevelDescribe("palette totality"));
    for (const [behavior, describeName] of Object.entries(ENFORCED_BY))
      expect(src, `${behavior} → describe("${describeName}")`).toMatch(topLevelDescribe(describeName));
  });

  it("the palette declares no behavior the engine does not yet perform (Phase 2: supersession, acyclic, containment)", () => {
    const palette = Object.keys(RELATIONS_MODULE[RELATIONS_MODULE_PATH]?.BEHAVIOR_PALETTE ?? {});
    for (const deferred of ["required", "chain", "blocking", "quiet", "rollup"])
      expect(palette).not.toContain(deferred);
    expect(new Set(palette)).toEqual(new Set(["supersession", "acyclic", "containment"]));
  });
});

// =====================================================================
// Relation declaration totality: the oracle over the whole edge store
// =====================================================================

describe("relation declaration totality", () => {
  // Boot-order guards (moved here from "legacy label migration" so a regression
  // turns this requirement red): generated inverses are order-independent, and
  // the inverse rewrite runs before the sweep.
  it("generated inverses never collide with an in-use label, whatever order the labels arrive in", async () => {
    for (const order of [["bar-inverse", "bar"], ["bar", "bar-inverse"]]) {
      const store = getStore();
      await createPattern(store, "notes");
      const a = await entry(store, "notes", "a"), b = await entry(store, "notes", "b"), c = await entry(store, "notes", "c");
      await runInDurableObject(store, (_i, state) => {
        const ins = (s: number, t: number, label: string) => state.storage.sql.exec(
          `INSERT INTO "_links" (source_pattern, source_id, target_pattern, target_id, label) VALUES ('notes', ?, 'notes', ?, ?)`, s, t, label);
        ins(a, b, order[0]); // inserted FIRST
        ins(b, c, order[1]);
      });
      await boot(store);
      const all = await sql(store, `SELECT name, inverse FROM "_relations" WHERE archived_at IS NULL`);
      expect(all.map((r) => r.name)).toEqual(expect.arrayContaining(["bar", "bar-inverse"]));
      const vocab = all.flatMap((r) => [r.name, r.inverse]);
      const names = new Set(all.map((r) => r.name));
      expect(all.filter((r) => names.has(r.inverse)), `order ${order.join(", ")}: an inverse equals a name`).toEqual([]);
      expect(new Set(vocab).size, `order ${order.join(", ")}: names and inverses are unique`).toBe(vocab.length);
      expect(await totalityViolations(store)).toEqual([]);
    }
  });

  it("an inverse-worded legacy link that canonicalizes onto a kernel source is swept in the same boot; a second boot changes nothing", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    const doc = await insertDocument(store, "legacy citation");
    const id = await runInDurableObject(store, (_i, state) => {
      const db = state.storage.sql;
      // notes/n1 referenced-by _documents/doc  ==  _documents/doc references notes/n1
      db.exec(`INSERT INTO "_links" (source_pattern, source_id, target_pattern, target_id, label) VALUES ('notes', ?, '_documents', ?, 'referenced-by')`, n1, doc);
      const linkId = (db.exec(`SELECT last_insert_rowid() AS id`).one() as { id: number }).id;
      // An inverse-worded link that canonicalizes onto sound ends, for contrast.
      db.exec(`INSERT INTO "_links" (source_pattern, source_id, target_pattern, target_id, label) VALUES ('notes', ?, 'notes', ?, 'required-by')`, n1, n2);
      return linkId;
    });

    await boot(store);
    expect(await totalityViolations(store), "relation declaration totality holds after the FIRST boot").toEqual([]);
    expect((await linkRow(store, id)).archived_at, "the kernel-source link is swept in the same boot").not.toBeNull();
    const sound = await sql(store, `SELECT * FROM "_links" WHERE archived_at IS NULL AND label = 'depends-on'`);
    expect(sound.map((l) => `${l.source_pattern}/${l.source_id}->${l.target_pattern}/${l.target_id}`)).toEqual([`notes/${n2}->notes/${n1}`]);

    const first = await edgeSnapshot(store);
    await boot(store);
    expect(await edgeSnapshot(store), "a second boot changes nothing").toEqual(first);
  });


  it("the only kernel facet nullable in DDL is _links.label, and boot leaves no active link unlabeled", async () => {
    const nullable = KERNEL_TABLES.flatMap((t) => t.facets.filter((f: any) => f.nullableInDdl).map((f) => `${t.name}.${f.name}`));
    expect(nullable).toEqual(["_links.label"]);

    const store = getStore();
    await seedLegacyLinks(store); // includes an unlabeled pre-registry link
    await boot(store);
    expect(await sql(store, `SELECT id FROM "_links" WHERE archived_at IS NULL AND (label IS NULL OR trim(label) = '')`)).toEqual([]);
  });

  it("a fresh boot reports no schema integrity drift", async () => {
    const store = getStore();
    await world(store);
    const lines = await warnLines(() => boot(store));
    expect(lines.filter((l) => /schema integrity drift/i.test(l))).toEqual([]);
  });

  it("holds after any mix of admitted and refused link writes", async () => {
    const store = getStore();
    const { n1, n2, n3, p1, p2 } = await world(store);
    const doc = await insertDocument(store, "doc");
    await declare(store, { name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"] });
    await declare(store, { name: "filed-under", inverse: "files", source: ["notes"], target: ["papers"], cardinality: "one" });

    const attempts: [string, string, string | undefined][] = [
      [`notes/${n1}`, `papers/${p1}`, "cites"],
      [`papers/${p1}`, `notes/${n1}`, "cites"],          // wrong direction
      [`notes/${n1}`, `notes/${n2}`, "made-up"],          // undeclared
      [`notes/${n1}`, `notes/${n2}`, undefined],          // missing
      [`papers/${p2}`, `notes/${n2}`, "cited-by"],        // inverse
      [`notes/${n1}`, `papers/${p1}`, "filed-under"],
      [`notes/${n1}`, `papers/${p2}`, "filed-under"],     // cardinality one
      [`notes/${n1}`, `_documents/${doc}`, "references"], // allowed kernel target
      [`_documents/${doc}`, `notes/${n3}`, "references"], // kernel source
      [`notes/${n1}`, `_members/1`, "references"],        // kernel target
      [`notes/${n3}`, `notes/${n3}`, "depends-on"],       // self cycle
    ];
    for (const [s, t, l] of attempts) {
      await link(store, s, t, l);
      expect(await totalityViolations(store), `after ${s} -[${l}]-> ${t}`).toEqual([]);
    }
    expect((await activeLinks(store)).length).toBe(4);
  });

  it("holds after the legacy migration and integrity sweep on an upgraded hive", async () => {
    const store = getStore();
    const { n1 } = await seedLegacyLinks(store);
    await runInDurableObject(store, (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO "_links" (source_pattern, source_id, target_pattern, target_id, label) VALUES ('pub-test', 3, 'notes', ?, 'ghost-label')`, n1,
      );
    });
    await boot(store);
    expect(await totalityViolations(store)).toEqual([]);
    // No relation names a pattern that does not exist.
    const patterns = new Set((await sql(store, `SELECT name FROM _objects WHERE archived_at IS NULL`)).map((r) => r.name as string));
    for (const r of await sql(store, `SELECT * FROM "_relations" WHERE archived_at IS NULL`))
      for (const p of [...list(r.source), ...list(r.target)])
        expect(p === "*" || patterns.has(p), `${r.name} names ${p}`).toBe(true);
  });
});

// #####################################################################
// PHASE 2 — composition and atomic writes (project-docs/relations.md,
// "Migration → Phase 2"; shapes pinned in "Interface (Phase 2)").
// #####################################################################

async function createPatternWith(store: Store, name: string, facets: Record<string, unknown>[], patternClass: "dataset" | "knowledge" = "dataset") {
  const p = JSON.parse(await store.proposeChange(`Create ${name}`, JSON.stringify({
    type: "create_pattern", pattern_name: name, pattern_description: `Test pattern ${name}`,
    doctrine: `Test doctrine for ${name}`, pattern_class: patternClass, facets,
  })));
  if (p.error) throw new Error(p.message);
  const a = JSON.parse(await store.applyChange(p.change_id));
  if (a.error) throw new Error(a.message);
}

const batch = async (store: Store, ops: Record<string, unknown>[]) => JSON.parse(await store.batchMutate(JSON.stringify(ops)));
const countRows = async (store: Store, table: string) => (await sql(store, `SELECT COUNT(*) AS n FROM "${table}"`))[0].n as number;

/** tasks → projects → goals, the §8 shape. `required` and `containment` on
 *  belongs-to are opt-in so each describe declares exactly what it tests. */
async function portfolio(store: Store, opts: { required?: boolean; containment?: boolean } = {}) {
  await createPattern(store, "tasks");
  await createPattern(store, "projects");
  await createPattern(store, "goals");
  const p1 = await entry(store, "projects", "project one");
  const p2 = await entry(store, "projects", "project two");
  const g1 = await entry(store, "goals", "goal one");
  const g2 = await entry(store, "goals", "goal two");
  await declare(store, {
    name: "belongs-to", inverse: "contains", source: ["tasks"], target: ["projects"], cardinality: "one",
    behaviors: opts.containment ? ["containment"] : [], ...(opts.required ? { required: true } : {}),
  });
  await declare(store, { name: "serves", inverse: "served-by", source: ["projects"], target: ["goals"] });
  return { p1, p2, g1, g2 };
}

/** Create a task carrying its project inline; returns the task id. */
async function task(store: Store, title: string, project: number): Promise<number> {
  const r = await mut(store, "tasks", "create", { title, _relate: { "belongs-to": `projects/${project}` } });
  if (r.error) throw new Error(`task create refused: ${r.message}`);
  return r.entry.id as number;
}

// =====================================================================
// Required relations
// =====================================================================

describe("required relations", () => {
  it("required is only allowed when source is an explicit list", async () => {
    const store = getStore();
    await createPattern(store, "tasks");
    await createPattern(store, "projects");
    const p = await propose(store, declareChange({ name: "belongs-to", inverse: "contains", source: ["*"], target: ["projects"], required: true }));
    expect(p.error).toBe(true);
    expect(p.message).toMatch(/required/i);
    expect(p.message).toMatch(/source/i);
    const ok = await propose(store, declareChange({ name: "belongs-to", inverse: "contains", source: ["tasks"], target: ["projects"], required: true }));
    expect(ok.error).toBeUndefined();
    expect(ok.preview?.violations ?? []).toEqual([]); // no tasks yet
    expect((await apply(store, ok.change_id)).error).toBeUndefined();
    expect((await relationRow(store, "belongs-to")).required).toBe(1);
  });

  it("a create in a required relation's source pattern must carry the link inline, or is refused naming relation and target", async () => {
    const store = getStore();
    const { p1 } = await portfolio(store, { required: true });
    const bare = await mut(store, "tasks", "create", { title: "orphan" });
    expectCleanRefusal(bare);
    expect(bare.message).toContain("belongs-to");
    expect(bare.message).toContain("projects");
    expect(bare.message).toContain("_relate");
    expect(await countRows(store, "tasks")).toBe(0);

    const ok = await mut(store, "tasks", "create", { title: "homed", _relate: { "belongs-to": `projects/${p1}` } });
    expect(ok.error).toBeUndefined();
    expect(ok.links).toEqual([expect.objectContaining({ source: `tasks/${ok.entry.id}`, target: `projects/${p1}`, label: "belongs-to" })]);
  });

  it("declaring or amending to required previews entries lacking the link and refuses at apply while any remain", async () => {
    const store = getStore();
    const { p1 } = await portfolio(store);
    const t1 = await entry(store, "tasks", "loose");
    const t2 = await entry(store, "tasks", "homed");
    await mustLink(store, `tasks/${t2}`, `projects/${p1}`, "belongs-to");

    const { proposed, applied } = await amend(store, { name: "belongs-to", required: true });
    expect(proposed.error).toBeUndefined();
    const sources = proposed.preview.violations.map((v: any) => v.source);
    expect(sources).toContain(`tasks/${t1}`);
    expect(sources).not.toContain(`tasks/${t2}`);
    expect(applied.error).toBe(true);
    expect((await relationRow(store, "belongs-to")).required).toBe(0);

    // A declare_relation with required:true meets the same preview + refusal.
    const decl = await propose(store, declareChange({ name: "pinned-to", inverse: "pins", source: ["tasks"], target: ["projects"], required: true }));
    expect(decl.error).toBeUndefined();
    expect(decl.preview.violations.map((v: any) => v.source)).toEqual(expect.arrayContaining([`tasks/${t1}`, `tasks/${t2}`]));
    expect((await apply(store, decl.change_id)).error).toBe(true);
    expect(await relationRow(store, "pinned-to")).toBeUndefined();

    // Backfill first, then flip.
    await mustLink(store, `tasks/${t1}`, `projects/${p1}`, "belongs-to");
    const again = await amend(store, { name: "belongs-to", required: true });
    expect(again.proposed.preview?.violations ?? []).toEqual([]);
    expect(again.applied.error).toBeUndefined();
    expect((await relationRow(store, "belongs-to")).required).toBe(1);

    // And off again, at any time.
    expect((await amend(store, { name: "belongs-to", required: false })).applied.error).toBeUndefined();
    expect((await relationRow(store, "belongs-to")).required).toBe(0);
  });

  it("unlinking or archiving the last required link is refused with guidance to move it; a one-batch move is allowed", async () => {
    const store = getStore();
    const { p1, p2 } = await portfolio(store, { required: true });
    const t = await task(store, "t", p1);
    const linkId = (await sql(store, `SELECT id FROM "_links" WHERE archived_at IS NULL AND source_id = ? AND label = 'belongs-to'`, t))[0].id;

    const un = await unlink(store, { source: `tasks/${t}`, target: `projects/${p1}`, label: "belongs-to" });
    expectCleanRefusal(un);
    expect(un.message).toContain("belongs-to");
    expect(un.message).toMatch(/move/i);
    const arch = await mut(store, "_links", "archive", { id: linkId });
    expectCleanRefusal(arch);
    expect(arch.message).toMatch(/move/i);
    expect((await linkRow(store, linkId)).archived_at).toBeNull();

    // Move = archive + create in one batch; required is judged on the batch's end state.
    const moved = await batch(store, [
      { pattern: "_links", operation: "archive", data: { id: linkId } },
      { pattern: "link", operation: "create", data: { source: `tasks/${t}`, target: `projects/${p2}`, label: "belongs-to" } },
    ]);
    expect(moved.error).toBeUndefined();
    const now = await sql(store, `SELECT target_id FROM "_links" WHERE archived_at IS NULL AND source_id = ? AND label = 'belongs-to'`, t);
    expect(now.map((r) => r.target_id)).toEqual([p2]);
    expect(await totalityViolations(store)).toEqual([]);
  });

  it("with cardinality many, links beyond the last may be removed; the last may not", async () => {
    const store = getStore();
    await world(store);
    await createPattern(store, "essays");
    const pa = await entry(store, "papers", "pa"), pb = await entry(store, "papers", "pb");
    await declare(store, { name: "draws-on", inverse: "drawn-on-by", source: ["essays"], target: ["papers"], required: true });
    const r = await mut(store, "essays", "create", { title: "e", _relate: { "draws-on": [`papers/${pa}`, `papers/${pb}`] } });
    expect(r.error).toBeUndefined();
    const e = r.entry.id;
    expect((await unlink(store, { source: `essays/${e}`, target: `papers/${pa}`, label: "draws-on" })).error).toBeUndefined();
    expectCleanRefusal(await unlink(store, { source: `essays/${e}`, target: `papers/${pb}`, label: "draws-on" }));
  });

  it("an archived source entry is exempt; unarchiving it without its required link is refused", async () => {
    const store = getStore();
    const { p1 } = await portfolio(store, { required: true });
    const t = await task(store, "t", p1);
    expect((await mut(store, "tasks", "archive", { id: t })).error).toBeUndefined(); // archiving the member is never blocked
    // While the task is archived the constraint does not apply to it.
    expect((await unlink(store, { source: `tasks/${t}`, target: `projects/${p1}`, label: "belongs-to" })).error).toBeUndefined();
    const back = await mut(store, "tasks", "unarchive", { id: t });
    expectCleanRefusal(back);
    expect(back.message).toContain("belongs-to");
    expect((await sql(store, `SELECT archived_at FROM tasks WHERE id = ?`, t))[0].archived_at).not.toBeNull();
  });

  it("boot reports active entries lacking a required link (pre-existing data), never repairing them", async () => {
    const store = getStore();
    await portfolio(store, { required: true });
    const raw = await runInDurableObject(store, (_i, state) => {
      state.storage.sql.exec(`INSERT INTO tasks (title) VALUES ('planted without a project')`);
      return (state.storage.sql.exec(`SELECT last_insert_rowid() AS id`).one() as { id: number }).id;
    });
    const lines = await warnLines(() => boot(store));
    expect(lines.some((l) => l.includes("belongs-to") && new RegExp(`tasks/${raw}(?!\\d)`).test(l)), lines.join(" | ")).toBe(true);
    expect((await sql(store, `SELECT archived_at FROM tasks WHERE id = ?`, raw))[0].archived_at).toBeNull();
  });

  // df-00ac1d54. Choice: required is REFUSED while any source pattern is archived.
  // Counting those entries as violations would deadlock: links can't be created
  // to or from an archived pattern's entries, so they could never be backfilled.
  it("required is refused while a source pattern is archived (declare and amend)", async () => {
    const store = getStore();
    await portfolio(store);
    await entry(store, "tasks", "would lack the link");
    const ap = await propose(store, { type: "archive_pattern", pattern_name: "tasks" });
    expect((await apply(store, ap.change_id)).error).toBeUndefined();
    const a = (await amend(store, { name: "belongs-to", required: true })).proposed;
    expect(a.error).toBe(true);
    expect(a.message).toContain("tasks");
    expect(a.message).toMatch(/archived/i);
    const d = await propose(store, declareChange({ name: "pinned-to", inverse: "pins", source: ["tasks"], target: ["projects"], required: true }));
    expect(d.error).toBe(true);
    expect(d.message).toMatch(/archived/i);
    expect((await relationRow(store, "belongs-to")).required).toBe(0);
  });

  it("unarchive_pattern of a required relation's source pattern previews entries lacking the link and refuses at apply", async () => {
    const store = getStore();
    const { p1 } = await portfolio(store, { required: true });
    const t1 = await task(store, "keeps its link", p1);
    const t2 = await task(store, "loses its link", p1);
    const ap = await propose(store, { type: "archive_pattern", pattern_name: "tasks" });
    expect((await apply(store, ap.change_id)).error).toBeUndefined();
    // While the pattern is archived, t2's link goes (simulated directly).
    await sql(store, `UPDATE "_links" SET archived_at = datetime('now') WHERE source_pattern = 'tasks' AND source_id = ?`, t2);
    const up = await propose(store, { type: "unarchive_pattern", pattern_name: "tasks" });
    expect(up.error).toBeUndefined();
    const sources = (up.preview?.violations ?? []).map((v: any) => v.source);
    expect(sources).toContain(`tasks/${t2}`);
    expect(sources).not.toContain(`tasks/${t1}`);
    expect((await apply(store, up.change_id)).error).toBe(true);
    expect((await sql(store, `SELECT archived_at FROM _objects WHERE name = 'tasks'`))[0].archived_at).not.toBeNull();
  });

  it("the read surfaces carry `required`", async () => {
    const store = getStore();
    await portfolio(store, { required: true });
    const res = JSON.parse(await store.resolve("mnemion://relations"));
    expect(res.relations.find((r: any) => r.name === "belongs-to").required).toBe(true);
    expect(res.relations.find((r: any) => r.name === "serves").required).toBe(false);
    const index = JSON.parse(await store.getIndex());
    expect(index.relations.find((r: any) => r.name === "belongs-to").required).toBe(true);
  });
});

// =====================================================================
// Containment (palette behavior)
// =====================================================================

describe("containment", () => {
  it("archiving a container with active members is refused, naming members and relation (kernel part-of and hive relations)", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    await mustLink(store, `notes/${n1}`, `notes/${n2}`, "part-of");
    const r = await mut(store, "notes", "archive", { id: n2 });
    expectCleanRefusal(r);
    expect(r.message).toContain("part-of");
    expect(r.message).toMatch(new RegExp(`notes/${n1}(?!\\d)`));
    expect((await sql(store, `SELECT archived_at FROM notes WHERE id = ?`, n2))[0].archived_at).toBeNull();

    const s2 = getStore();
    const { p1 } = await portfolio(s2, { containment: true });
    const t = await task(s2, "member", p1);
    const rp = await mut(s2, "projects", "archive", { id: p1 });
    expectCleanRefusal(rp);
    expect(rp.message).toContain("belongs-to");
    expect(rp.message).toMatch(new RegExp(`tasks/${t}(?!\\d)`));
  });

  it("archived members do not hold their container; non-containment relations never block an archive", async () => {
    const store = getStore();
    const { n1, n2, n3, p1 } = await world(store);
    await mustLink(store, `notes/${n1}`, `notes/${n2}`, "part-of");
    expectCleanRefusal(await mut(store, "notes", "archive", { id: n2 })); // control: an active member holds it
    await mut(store, "notes", "archive", { id: n1 });
    expect((await mut(store, "notes", "archive", { id: n2 })).error, "an archived member does not").toBeUndefined();
    await mustLink(store, `notes/${n3}`, `papers/${p1}`, "references");
    expect((await mut(store, "papers", "archive", { id: p1 })).error, "references never contains").toBeUndefined();
  });

  it("the same batch may archive the members or move them, in any order", async () => {
    const store = getStore();
    const { n1, n2, n3 } = await world(store);
    const l1 = await mustLink(store, `notes/${n1}`, `notes/${n2}`, "part-of");
    // Container first, member second: judged on the batch's end state.
    const both = await batch(store, [
      { pattern: "notes", operation: "archive", data: { id: n2 } },
      { pattern: "notes", operation: "archive", data: { id: n1 } },
    ]);
    expect(both.error).toBeUndefined();

    const s2 = getStore();
    const w = await world(s2);
    const lm = await mustLink(s2, `notes/${w.n1}`, `notes/${w.n2}`, "part-of");
    const moved = await batch(s2, [
      { pattern: "notes", operation: "archive", data: { id: w.n2 } },
      { pattern: "_links", operation: "archive", data: { id: lm } },
      { pattern: "link", operation: "create", data: { source: `notes/${w.n1}`, target: `notes/${w.n3}`, label: "part-of" } },
    ]);
    expect(moved.error).toBeUndefined();
    expect((await sql(s2, `SELECT target_id FROM "_links" WHERE archived_at IS NULL AND label = 'part-of'`)).map((r) => r.target_id)).toEqual([w.n3]);
    expect(l1).toBeGreaterThan(0);
    expect(n3).toBeGreaterThan(0);
  });

  it("a batch that leaves an active member under an archived container is refused and rolled back whole", async () => {
    const store = getStore();
    const { n1, n2, n3 } = await world(store);
    await mustLink(store, `notes/${n1}`, `notes/${n2}`, "part-of");
    const r = await batch(store, [
      { pattern: "notes", operation: "archive", data: { id: n3 } },
      { pattern: "notes", operation: "archive", data: { id: n2 } },
    ]);
    expect(r.error).toBe(true);
    expect(r.message).toContain("part-of");
    const archived = await sql(store, `SELECT id FROM notes WHERE archived_at IS NOT NULL`);
    expect(archived).toEqual([]); // n3's archive rolled back too
  });

  // Owner decision O2: archive_pattern on a containment target is refused while
  // active members in OTHER patterns link into its active entries.
  it("archive_pattern on a containment target previews the holding members and is refused at apply", async () => {
    const store = getStore();
    const { p1 } = await portfolio(store, { containment: true });
    const t = await task(store, "member", p1);
    const p = await propose(store, { type: "archive_pattern", pattern_name: "projects" });
    expect(p.error).toBeUndefined();
    expect(p.preview.violations).toEqual(expect.arrayContaining([expect.objectContaining({ source: `tasks/${t}`, target: `projects/${p1}`, label: "belongs-to" })]));
    const a = await apply(store, p.change_id);
    expect(a.error).toBe(true);
    expect(a.message).toContain("belongs-to");
    expect((await sql(store, `SELECT archived_at FROM _objects WHERE name = 'projects'`))[0].archived_at).toBeNull();
  });

  it("archive_pattern: archived members and same-pattern members don't hold; non-containment links never do", async () => {
    const store = getStore();
    const { p1 } = await portfolio(store, { containment: true });
    const t = await task(store, "member", p1);
    await mut(store, "tasks", "archive", { id: t });
    await mustLink(store, `projects/${p1}`, `projects/${(await entry(store, "projects", "parent"))}`, "part-of"); // internal containment
    await createPattern(store, "notes");
    const n = await entry(store, "notes", "cites a project");
    await mustLink(store, `notes/${n}`, `projects/${p1}`, "references"); // not containment
    const p = await propose(store, { type: "archive_pattern", pattern_name: "projects" });
    expect(p.preview?.violations ?? []).toEqual([]);
    const a = await apply(store, p.change_id);
    expect(a.error, a.message).toBeUndefined();
    expect((await sql(store, `SELECT archived_at FROM _objects WHERE name = 'projects'`))[0].archived_at).not.toBeNull();
  });

  it("archive_pattern re-checks at apply: a member that arrives after a clean propose blocks it", async () => {
    const store = getStore();
    const { p1 } = await portfolio(store, { containment: true });
    const p = await propose(store, { type: "archive_pattern", pattern_name: "projects" });
    expect(p.preview?.violations ?? []).toEqual([]);
    await task(store, "late member", p1);
    expect((await apply(store, p.change_id)).error).toBe(true);
    expect((await sql(store, `SELECT archived_at FROM _objects WHERE name = 'projects'`))[0].archived_at).toBeNull();
  });

  // df-6809fa29 / df-f3e97410: containment is judged on unarchive too.
  it("unarchiving a member whose container is archived is refused; doing both in one batch is fine", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    await mustLink(store, `notes/${n1}`, `notes/${n2}`, "part-of");
    await mut(store, "notes", "archive", { id: n1 });
    expect((await mut(store, "notes", "archive", { id: n2 })).error).toBeUndefined(); // the member is inactive
    const r = await mut(store, "notes", "unarchive", { id: n1 });
    expectCleanRefusal(r);
    expect(r.message).toContain("part-of");
    expect(r.message).toMatch(new RegExp(`notes/${n2}(?!\\d)`));
    expect((await sql(store, `SELECT archived_at FROM notes WHERE id = ?`, n1))[0].archived_at).not.toBeNull();
    // Container and member back together: judged on the batch's end state.
    const both = await batch(store, [
      { pattern: "notes", operation: "unarchive", data: { id: n1 } },
      { pattern: "notes", operation: "unarchive", data: { id: n2 } },
    ]);
    expect(both.error, both.message).toBeUndefined();
  });

  it("unarchiving a member whose container's PATTERN is archived is refused", async () => {
    const store = getStore();
    const { p1 } = await portfolio(store, { containment: true });
    const t = await task(store, "member", p1);
    await mut(store, "tasks", "archive", { id: t });
    const ap = await propose(store, { type: "archive_pattern", pattern_name: "projects" });
    expect((await apply(store, ap.change_id)).error).toBeUndefined();
    const r = await mut(store, "tasks", "unarchive", { id: t });
    expectCleanRefusal(r);
    expect(r.message).toContain("belongs-to");
  });

  it("unarchive_pattern of a member pattern previews members that would sit under an archived container, and apply re-checks", async () => {
    const store = getStore();
    const { p1, p2 } = await portfolio(store, { containment: true });
    const t1 = await task(store, "member one", p1);
    const t2 = await task(store, "member two", p2);
    const archiveTasks = await propose(store, { type: "archive_pattern", pattern_name: "tasks" });
    expect((await apply(store, archiveTasks.change_id)).error).toBeUndefined();
    expect((await mut(store, "projects", "archive", { id: p1 })).error).toBeUndefined(); // members are inactive now

    const up = await propose(store, { type: "unarchive_pattern", pattern_name: "tasks" });
    expect(up.error).toBeUndefined();
    expect(up.preview.violations).toEqual([expect.objectContaining({ source: `tasks/${t1}`, target: `projects/${p1}`, label: "belongs-to" })]);
    expect((await apply(store, up.change_id)).error).toBe(true);
    expect((await sql(store, `SELECT archived_at FROM _objects WHERE name = 'tasks'`))[0].archived_at).not.toBeNull();

    // Clear it, propose clean, then archive the other container before apply: re-checked.
    await mut(store, "projects", "unarchive", { id: p1 });
    const clean = await propose(store, { type: "unarchive_pattern", pattern_name: "tasks" });
    expect(clean.preview?.violations ?? []).toEqual([]);
    expect((await mut(store, "projects", "archive", { id: p2 })).error).toBeUndefined();
    expect((await apply(store, clean.change_id)).error, "apply re-checks").toBe(true);
    expect(t2).toBeGreaterThan(0);
  });

  it("amend_relation adding containment previews archived containers with active members and refuses at apply", async () => {
    const store = getStore();
    const { n1, n2, p1, p2 } = await world(store);
    await declare(store, { name: "filed-in", inverse: "files", source: ["notes"], target: ["papers"] });
    await mustLink(store, `notes/${n1}`, `papers/${p1}`, "filed-in");
    await mustLink(store, `notes/${n2}`, `papers/${p2}`, "filed-in");
    await mut(store, "papers", "archive", { id: p1 });      // archived container, active member n1
    await mut(store, "notes", "archive", { id: n2 });
    await mut(store, "papers", "archive", { id: p2 });      // archived container, archived member: fine
    const { proposed, applied } = await amend(store, { name: "filed-in", behaviors: ["containment"] });
    expect(proposed.error).toBeUndefined();
    expect(proposed.preview.violations).toEqual([expect.objectContaining({ source: `notes/${n1}`, target: `papers/${p1}`, label: "filed-in" })]);
    expect(applied.error).toBe(true);
    expect(list((await relationRow(store, "filed-in")).behaviors)).toEqual([]);
  });

  it("resolve still lists members, under the inverse name", async () => {
    const store = getStore();
    const { n1, n2 } = await world(store);
    await mustLink(store, `notes/${n1}`, `notes/${n2}`, "part-of");
    const r = JSON.parse(await store.resolve(`mnemion://entry/notes/${n2}`));
    expect(r.linked.find((l: any) => l.pattern === "notes" && l.id === n1)).toMatchObject({ direction: "in", relation: "has-part" });
  });

  it("prime recall is upward only: member → container, never container → members", async () => {
    const store = getStore();
    await createPattern(store, "notes", "knowledge");
    const member = await entry(store, "notes", "chapter");
    const container = await entry(store, "notes", "book");
    const neighbor = await entry(store, "notes", "review");
    await mustLink(store, `notes/${member}`, `notes/${container}`, "part-of");
    await mustLink(store, `notes/${neighbor}`, `notes/${container}`, "references");
    const primeOn = (id: number) => runInDurableObject(store, async (_i, state) => {
      const db = state.storage.sql;
      const ctx: PrimeContext = {
        db,
        patternExists: (n) => db.exec(`SELECT 1 FROM _objects WHERE name = ? AND archived_at IS NULL`, n).toArray().length > 0,
        env: {
          AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
          VECTORIZE: { query: async () => ({ matches: [{ id: `notes:${id}`, score: 0.9, metadata: { pattern: "notes", entry_id: id } }] }) },
        },
      };
      return prime(ctx, "anything", undefined, 5);
    });
    const fromContainer = (await primeOn(container)).results.find((r) => r.id === container)!;
    const ids = (fromContainer.linked ?? []).map((l) => l.id);
    expect(ids, "no fan-out from container to members").not.toContain(member);
    expect(ids, "other relations still expand").toContain(neighbor);
    const fromMember = (await primeOn(member)).results.find((r) => r.id === member)!;
    expect((fromMember.linked ?? []).map((l) => l.id), "a member recalls its container").toContain(container);
  });

  it("declare_relation and amend_relation accept containment", async () => {
    const store = getStore();
    await world(store);
    await declare(store, { name: "filed-in", inverse: "files", source: ["notes"], target: ["papers"], behaviors: ["containment"] });
    expect(list((await relationRow(store, "filed-in")).behaviors)).toEqual(["containment"]);
    await declare(store, { name: "cites", inverse: "cited-by", source: ["notes"], target: ["papers"] });
    expect((await amend(store, { name: "cites", behaviors: ["containment", "acyclic"] })).applied.error).toBeUndefined();
    expect(new Set(list((await relationRow(store, "cites")).behaviors))).toEqual(new Set(["containment", "acyclic"]));
  });
});

// =====================================================================
// Inline _relate on create (§5)
// =====================================================================

describe("inline _relate", () => {
  it("creates the entry and its links together, accepting names or inverses and one or many targets", async () => {
    const store = getStore();
    const { n1, p1, p2 } = await world(store);
    const r = await mut(store, "notes", "create", {
      title: "new",
      _relate: { references: [`papers/${p1}`, `papers/${p2}`], "has-part": `notes/${n1}` },
    });
    expect(r.error).toBeUndefined();
    const id = r.entry.id;
    expect(r.entry).not.toHaveProperty("_relate");
    expect(r.links).toHaveLength(3);
    for (const l of r.links) expect(Object.keys(l).sort()).toEqual(["id", "label", "source", "target"]);
    expect(r.links.map((l: any) => `${l.source} ${l.label} ${l.target}`).sort()).toEqual([
      `notes/${id} references papers/${p1}`,
      `notes/${id} references papers/${p2}`,
      `notes/${n1} part-of notes/${id}`,
    ].sort());
    const stored = await sql(store, `SELECT source_pattern, source_id, target_pattern, target_id, label FROM "_links" WHERE archived_at IS NULL ORDER BY id`);
    expect(stored).toHaveLength(3);
    expect((await sql(store, `PRAGMA table_info(notes)`)).map((c) => c.name)).not.toContain("_relate");
  });

  it("any link failure refuses cleanly and rolls back the entry too", async () => {
    const store = getStore();
    const { p1, p2 } = await world(store);
    await declare(store, { name: "filed-under", inverse: "files", source: ["notes"], target: ["papers"], cardinality: "one" });
    // Control: a sound _relate succeeds, so the refusals below are about the links.
    const control = await mut(store, "notes", "create", { title: "control", _relate: { "filed-under": `papers/${p1}` } });
    expect(control.error, control.message).toBeUndefined();
    await mut(store, "notes", "archive", { id: control.entry.id });
    await sql(store, `UPDATE "_links" SET archived_at = datetime('now') WHERE archived_at IS NULL`);
    const notesBefore = await countRows(store, "notes");
    for (const rel of [
      { "made-up": `papers/${p1}` },                          // undeclared
      { references: `papers/99999` },                         // missing target
      { references: `_members/1` },                           // inadmissible kernel target
      { "filed-under": [`papers/${p1}`, `papers/${p2}`] },    // cardinality one
      { references: "papers" },                               // malformed ref
      { references: [`papers/${p1}`, `papers/${p1}`] },       // duplicate in one create
    ]) {
      const r = await mut(store, "notes", "create", { title: "doomed", _relate: rel });
      expectCleanRefusal(r);
      expect(await countRows(store, "notes"), JSON.stringify(rel)).toBe(notesBefore);
      expect(await activeLinks(store), JSON.stringify(rel)).toEqual([]);
    }
    expectCleanRefusal(await mut(store, "notes", "create", { title: "doomed", _relate: "papers/1" }));
    expectCleanRefusal(await mut(store, "notes", "create", { title: "doomed", _relate: [`papers/${p1}`] }));
    expect(await countRows(store, "notes")).toBe(notesBefore);
  });

  it("_relate is accepted only on create", async () => {
    const store = getStore();
    const { n1, p1 } = await world(store);
    const control = await mut(store, "notes", "create", { title: "control", _relate: { references: `papers/${p1}` } });
    expect(control.error, "control: _relate works on create").toBeUndefined();
    await sql(store, `UPDATE "_links" SET archived_at = datetime('now') WHERE archived_at IS NULL`);
    const r = await mut(store, "notes", "update", { id: n1, title: "renamed", _relate: { references: `papers/${p1}` } });
    expectCleanRefusal(r);
    expect(r.message).toContain("_relate");
    expect((await sql(store, `SELECT title FROM notes WHERE id = ?`, n1))[0].title).toBe("note one");
    expect(await activeLinks(store)).toEqual([]);
  });

  it("works on batch creates, and a failure anywhere rolls the whole batch back", async () => {
    const store = getStore();
    const { p1 } = await world(store);
    const ok = await batch(store, [
      { pattern: "notes", operation: "create", data: { title: "a", _relate: { references: `papers/${p1}` } } },
      { pattern: "notes", operation: "create", data: { title: "b", _relate: { "derived-from": `papers/${p1}` } } },
    ]);
    expect(ok.error).toBeUndefined();
    expect(ok.results.map((x: any) => x.links.length)).toEqual([1, 1]);
    const before = await countRows(store, "notes");
    const linksBefore = (await activeLinks(store)).length;
    const bad = await batch(store, [
      { pattern: "notes", operation: "create", data: { title: "c", _relate: { references: `papers/${p1}` } } },
      { pattern: "notes", operation: "create", data: { title: "d", _relate: { "made-up": `papers/${p1}` } } },
    ]);
    expect(bad.error).toBe(true);
    expect(await countRows(store, "notes")).toBe(before);
    expect((await activeLinks(store)).length).toBe(linksBefore);
  });

  it("announces the links it creates over /ws, single and batch", async () => {
    const store = getStore();
    const { p1, p2 } = await world(store);
    await runInDurableObject(store, async (_i, state) => {
      await booted(state, () => "bm", async (hive, trace) => {
        const patterns = () => new Set((trace.sent ?? []).flatMap((m) => { try { return JSON.parse(m).patterns ?? []; } catch { return []; } }));
        trace.sent = [];
        const r = JSON.parse(await hive.mutate("notes", "create", JSON.stringify({ title: "single", _relate: { references: `papers/${p1}` } })));
        expect(r.error, r.message).toBeUndefined();
        expect(patterns(), "single create").toContain("_links");
        expect(patterns()).toContain("notes");
        trace.sent = [];
        const b = JSON.parse(await hive.batchMutate(JSON.stringify([
          { pattern: "notes", operation: "create", data: { title: "batched", _relate: { references: `papers/${p2}` } } },
        ])));
        expect(b.error, b.message).toBeUndefined();
        expect(patterns(), "batch create").toContain("_links");
      });
    });
  });

  it("passes through POST /api/mutate/:pattern", async () => {
    const { mutateEntry } = await import("../../shared/Routing/routes/pages");
    const store = getStore();
    const { p1 } = await world(store);
    const res = await mutateEntry({
      request: new Request("https://test.local/api/mutate/notes", { method: "POST", body: JSON.stringify({ operation: "create", data: { title: "via api", _relate: { references: `papers/${p1}` } } }) }),
      url: new URL("https://test.local/api/mutate/notes"), env: env as any, params: { pattern: "notes" }, hive: store, actor: "owner",
    });
    const body = await res.json() as any;
    expect(body.error).toBeUndefined();
    expect(body.links).toEqual([expect.objectContaining({ target: `papers/${p1}`, label: "references" })]);
  });

  it("works over MCP mutate", async () => {
    const hiveId = `user:rel-mcp:${crypto.randomUUID()}`;
    const store = namedStore(hiveId);
    const { p1 } = await world(store);
    const { call } = await mcpSession(hiveId);
    const r = await call("mutate", { pattern: "notes", operation: "create", data: { title: "via mcp", _relate: { references: `papers/${p1}` } } });
    expect(r.isError, r.content?.[0]?.text).toBeFalsy();
    const created = await sql(store, `SELECT id FROM notes WHERE title = 'via mcp'`);
    expect(created).toHaveLength(1);
    expect(await sql(store, `SELECT label FROM "_links" WHERE archived_at IS NULL AND source_id = ? AND target_id = ?`, created[0].id, p1)).toEqual([{ label: "references" }]);
  });
});

// =====================================================================
// Link shortcuts inside batches
// =====================================================================

describe("link shortcuts in batches", () => {
  it("link and unlink expand inside batchMutate exactly as in mutate", async () => {
    const store = getStore();
    const { n1, n2, p1 } = await world(store);
    await mustLink(store, `notes/${n2}`, `papers/${p1}`, "references");
    const r = await batch(store, [
      { pattern: "link", operation: "create", data: { source: `notes/${n1}`, target: `papers/${p1}`, label: "references" } },
      { pattern: "unlink", operation: "unlink", data: { source: `notes/${n2}`, target: `papers/${p1}`, label: "references" } },
    ]);
    expect(r.error).toBeUndefined();
    expect(r.results).toHaveLength(2);
    const active = await activeLinks(store);
    expect(active.map((l) => `${l.source_id}->${l.target_id}`)).toEqual([`${n1}->${p1}`]);
  });

  it("a shortcut item's operation may be omitted; the shortcut decides it", async () => {
    const store = getStore();
    const { n1, p1 } = await world(store);
    const r = await batch(store, [{ pattern: "link", data: { source: `notes/${n1}`, target: `papers/${p1}`, label: "references" } }]);
    expect(r.error).toBeUndefined();
    expect((await activeLinks(store)).length).toBe(1);
  });

  it("a refused link anywhere rolls back the whole batch", async () => {
    const store = getStore();
    const { n1, n2, p1 } = await world(store);
    const r = await batch(store, [
      { pattern: "notes", operation: "update", data: { id: n1, title: "changed" } },
      { pattern: "link", operation: "create", data: { source: `notes/${n1}`, target: `papers/${p1}`, label: "references" } },
      { pattern: "link", operation: "create", data: { source: `notes/${n2}`, target: `papers/${p1}`, label: "made-up" } },
    ]);
    expect(r.error).toBe(true);
    expect(r.message).toContain("declare_relation");
    expect(await activeLinks(store)).toEqual([]);
    expect((await sql(store, `SELECT title FROM notes WHERE id = ?`, n1))[0].title).toBe("note one");
  });

  // df-8e8a97fe: the MCP batch consent gate judges EXPANDED items.
  it("the batch consent gate judges items after shortcut expansion", async () => {
    const gate = await import("../../entities/Hive/mutate-gate");
    const kernel = await import("../../entities/Hive/kernel");
    const shortcuts = kernel.SHORTCUTS as Record<string, { pattern: string; operation: string }>;
    // Control: the gate refuses the consent-gated pattern named directly.
    expect(gate.findGatedBatchOp([{ pattern: "_members", operation: "create", data: { label: "eve", display_name: "Eve" } }] as any)).not.toBeNull();
    // A shortcut that expands to it must be judged the same.
    shortcuts.zz_invite = { pattern: "_members", operation: "create" };
    try {
      const op = gate.findGatedBatchOp([
        { pattern: "notes", operation: "create", data: { title: "harmless" } },
        { pattern: "zz_invite", data: { label: "eve", display_name: "Eve" } },
      ] as any);
      expect(op, "an expanded consent-gated item is flagged").not.toBeNull();
      // And the real shortcuts stay ungated (links and fragments are Open).
      expect(gate.findGatedBatchOp([
        { pattern: "link", data: { source: "notes/1", target: "notes/2", label: "references" } },
        { pattern: "fragment", data: { content: "x" } },
      ] as any)).toBeNull();
    } finally { delete shortcuts.zz_invite; }
  });

  it("works over MCP batch, shortcut items without an operation", async () => {
    const hiveId = `user:rel-mcp:${crypto.randomUUID()}`;
    const store = namedStore(hiveId);
    const { n1, n2, p1 } = await world(store);
    await mustLink(store, `notes/${n2}`, `papers/${p1}`, "references");
    const { call } = await mcpSession(hiveId);
    const r = await call("mutate", { operation: "batch", data: [
      { pattern: "link", data: { source: `notes/${n1}`, target: `papers/${p1}`, label: "references" } },
      { pattern: "unlink", data: { source: `notes/${n2}`, target: `papers/${p1}`, label: "references" } },
    ] });
    expect(r.isError, r.content?.[0]?.text).toBeFalsy();
    expect((await activeLinks(store)).map((l) => l.source_id)).toEqual([n1]);
  });
});

// =====================================================================
// Derived relations (chains, §3)
// =====================================================================

function chainChange(name: string, inverse: string, chain: string[], extra: Record<string, unknown> = {}) {
  return { type: "declare_relation", name, inverse, description: DESC(name), chain, ...extra };
}

describe("derived relations", () => {
  async function addresses(store: Store) {
    const ids = await portfolio(store);
    const p = await propose(store, chainChange("addresses", "addressed-by", ["belongs-to", "serves"]));
    if (p.error) throw new Error(`chain declare refused: ${p.message}`);
    const a = await apply(store, p.change_id);
    if (a.error) throw new Error(`chain apply refused: ${a.message}`);
    return ids;
  }

  it("declares a chain whose steps compose; the read surfaces mark it derived with ends taken from the chain", async () => {
    const store = getStore();
    await addresses(store);
    const row = await relationRow(store, "addresses");
    expect(row).toBeDefined();
    expect(list(row.chain)).toEqual(["belongs-to", "serves"]);
    const res = JSON.parse(await store.resolve("mnemion://relations"));
    const rel = res.relations.find((r: any) => r.name === "addresses");
    expect(rel).toMatchObject({ derived: true, chain: ["belongs-to", "serves"], source: ["tasks"], target: ["goals"], inverse: "addressed-by" });
    expect(res.relations.find((r: any) => r.name === "belongs-to").derived).toBe(false);
  });

  const CHAIN_REFUSALS: [string, Record<string, unknown>, RegExp][] = [
    ["an unknown step", chainChange("x-chain", "x-chain-of", ["belongs-to", "no-such"]), /no-such/],
    ["steps that do not compose", chainChange("x-chain", "x-chain-of", ["serves", "belongs-to"]), /compose/i],
    ["a single step", chainChange("x-chain", "x-chain-of", ["belongs-to"]), /chain/i],
    ["a derived step", chainChange("x-chain", "x-chain-of", ["addresses", "serves"]), /addresses/],
    ["cardinality on a chain", chainChange("x-chain", "x-chain-of", ["belongs-to", "serves"], { cardinality: "one" }), /cardinality/i],
    ["behaviors on a chain", chainChange("x-chain", "x-chain-of", ["belongs-to", "serves"], { behaviors: ["acyclic"] }), /behavio/i],
    ["required on a chain", chainChange("x-chain", "x-chain-of", ["belongs-to", "serves"], { required: true }), /required/i],
    ["source/target on a chain", chainChange("x-chain", "x-chain-of", ["belongs-to", "serves"], { source: ["tasks"], target: ["goals"] }), /source|target/i],
  ];

  it.each(CHAIN_REFUSALS)("declare_relation refuses a chain with %s", async (_label, change, pattern) => {
    const store = getStore();
    await addresses(store);
    const p = await propose(store, change);
    expect(p.error).toBe(true);
    expect(p.message).toMatch(pattern);
    expect(await relationRow(store, "x-chain")).toBeUndefined();
  });

  it("a derived label can never be written: link, inverse wording and _relate are refused, naming the stored relations", async () => {
    const store = getStore();
    const { p1, g1 } = await addresses(store);
    const t = await task(store, "t", p1);
    for (const r of [
      await link(store, `tasks/${t}`, `goals/${g1}`, "addresses"),
      await link(store, `goals/${g1}`, `tasks/${t}`, "addressed-by"),
      await mut(store, "tasks", "create", { title: "x", _relate: { "belongs-to": `projects/${p1}`, addresses: `goals/${g1}` } }),
    ]) {
      expectCleanRefusal(r);
      expect(r.message).toContain("belongs-to");
      expect(r.message).toContain("serves");
    }
    expect(await sql(store, `SELECT id FROM "_links" WHERE label IN ('addresses', 'addressed-by')`)).toEqual([]);
    expect(await totalityViolations(store)).toEqual([]);
  });

  it("resolve derives chain items in both directions, flagged derived, deduplicated, through active entries only", async () => {
    const store = getStore();
    const { p1, p2, g1, g2 } = await addresses(store);
    const t = await task(store, "t", p1);
    await mustLink(store, `projects/${p1}`, `goals/${g1}`, "serves");
    await mustLink(store, `projects/${p1}`, `goals/${g2}`, "serves");
    await mustLink(store, `projects/${p2}`, `goals/${g1}`, "serves");

    const fromTask = JSON.parse(await store.resolve(`mnemion://entry/tasks/${t}`)).linked;
    const derived = fromTask.filter((l: any) => l.derived);
    expect(derived.map((l: any) => `${l.pattern}/${l.id}`).sort()).toEqual([`goals/${g1}`, `goals/${g2}`].sort());
    for (const l of derived) expect(l).toMatchObject({ direction: "out", relation: "addresses", derived: true });
    expect(fromTask.find((l: any) => l.pattern === "projects" && l.id === p1)).toMatchObject({ relation: "belongs-to" });
    expect(fromTask.find((l: any) => l.pattern === "projects").derived ?? false).toBe(false);

    const fromGoal = JSON.parse(await store.resolve(`mnemion://entry/goals/${g1}`)).linked;
    expect(fromGoal.filter((l: any) => l.derived)).toEqual([expect.objectContaining({ pattern: "tasks", id: t, direction: "in", relation: "addressed-by", derived: true })]);

    // An archived intermediate hides the derivation (dormant links never derive).
    await runInDurableObject(store, (_i, state) => { state.storage.sql.exec(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`, p1); });
    const hidden = JSON.parse(await store.resolve(`mnemion://entry/tasks/${t}`)).linked ?? [];
    expect(hidden.filter((l: any) => l.derived)).toEqual([]);
  });

  it("a stored relation used by an active chain cannot be retired; the chain itself can", async () => {
    const store = getStore();
    await addresses(store);
    const r = await retire(store, "serves");
    expect(r.proposed.error).toBe(true);
    expect(r.proposed.message).toContain("addresses");
    const c = await retire(store, "addresses");
    expect(c.proposed.error).toBeUndefined();
    expect(c.applied.error).toBeUndefined();
    expect(await relationRow(store, "addresses")).toBeUndefined();
    expect((await retire(store, "serves")).applied?.error).toBeUndefined();
  });
});

// =====================================================================
// drop_facet
// =====================================================================

describe("drop_facet", () => {
  async function notebook(store: Store) {
    await createPatternWith(store, "notebook", [{ name: "title", type: "text" }, { name: "scratch", type: "text" }, { name: "rank", type: "integer" }]);
    for (const [title, scratch] of [["a", "x"], ["b", null], ["c", "z"]]) {
      const r = await mut(store, "notebook", "create", { title, ...(scratch ? { scratch } : {}) });
      if (r.error) throw new Error(r.message);
    }
  }

  it("previews the data loss, then drops the column and its _fields row, logged with a bookmark", async () => {
    const store = getStore();
    await notebook(store);
    const p = await propose(store, { type: "drop_facet", pattern_name: "notebook", facet: "scratch" });
    expect(p.error).toBeUndefined();
    expect(p.preview.non_null_values).toBe(2);
    expect((await sql(store, `PRAGMA table_info(notebook)`)).map((c) => c.name)).toContain("scratch"); // nothing before apply

    const a = await apply(store, p.change_id);
    expect(a.error).toBeUndefined();
    expect((await sql(store, `PRAGMA table_info(notebook)`)).map((c) => c.name)).not.toContain("scratch");
    expect(await sql(store, `SELECT name FROM _fields WHERE object_name = 'notebook' AND name = 'scratch'`)).toEqual([]);
    const hist = await sql(store, `SELECT bookmark FROM _schema_history WHERE change_type = 'drop_facet'`);
    expect(hist).toHaveLength(1);
    expect(hist[0].bookmark, "logged with a PITR bookmark like every change").toBeTruthy();

    // The pattern keeps working: entries remain, writes and updates succeed, the facet is gone.
    expect(await countRows(store, "notebook")).toBe(3);
    const c = await mut(store, "notebook", "create", { title: "d", rank: 1 });
    expect(c.error).toBeUndefined();
    expect((await mut(store, "notebook", "update", { id: c.entry.id, title: "d2" })).error).toBeUndefined();
    expect((await mut(store, "notebook", "create", { title: "e", scratch: "nope" })).error).toBe(true);
    const schema = JSON.parse(await store.resolve("mnemion://schema/notebook"));
    expect(schema.facets.map((f: any) => f.name)).not.toContain("scratch");
  });

  const DROP_REFUSALS: [string, Record<string, unknown>, RegExp][] = [
    ["a kernel pattern", { pattern_name: "_links", facet: "label" }, /kernel/i],
    ["a kernel column", { pattern_name: "notebook", facet: "created_at" }, /kernel/i],
    ["the id column", { pattern_name: "notebook", facet: "id" }, /kernel/i],
    ["a facet that does not exist", { pattern_name: "notebook", facet: "ghost" }, /ghost/],
    ["a pattern that does not exist", { pattern_name: "nosuch", facet: "title" }, /nosuch/],
  ];

  it.each(DROP_REFUSALS)("refuses %s", async (_label, change, pattern) => {
    const store = getStore();
    await notebook(store);
    const p = await propose(store, { type: "drop_facet", ...change });
    expect(p.error).toBe(true);
    expect(p.message).toMatch(pattern);
  });

  // Owner decision O3: drop_facet is refused while anything names the facet.
  // Each case plants one reference; the preview lists it, apply is refused, and
  // removing the reference lets the drop through.
  const FACET_REFERENCES: [string, string, (store: Store) => Promise<() => Promise<void>>][] = [
    ["memory_policy", "memory-policy exclusive_facets", async (store) => {
      const p = await propose(store, { type: "set_memory_policy", pattern_name: "notebook", policy: { exclusive_facets: ["scratch"] } });
      expect((await apply(store, p.change_id)).error).toBeUndefined();
      return async () => { const c = await propose(store, { type: "set_memory_policy", pattern_name: "notebook", policy: null }); await apply(store, c.change_id); };
    }],
    ["view", "a _views config", async (store) => {
      const v = await mut(store, "_views", "create", { pattern: "notebook", name: "grid", view_type: "table", config: JSON.stringify({ columns: ["title", "scratch"] }) });
      expect(v.error, v.message).toBeFalsy();
      return async () => { await mut(store, "_views", "archive", { id: v.entry.id }); };
    }],
    ["publication", "a _publications filter", async (store) => {
      const pub = await mut(store, "_publications", "create", { path: "nb", source_pattern: "notebook", format: "json", filters: JSON.stringify(["scratch=x"]) });
      expect(pub.error, pub.message).toBeUndefined();
      return async () => { await mut(store, "_publications", "archive", { id: pub.entry.id }); };
    }],
    ["publication", "a _publications template", async (store) => {
      const pub = await mut(store, "_publications", "create", { path: "nbt", source_pattern: "notebook", format: "html", template: "<p>{{scratch}}</p>" });
      expect(pub.error, pub.message).toBeUndefined();
      return async () => { await mut(store, "_publications", "archive", { id: pub.entry.id }); };
    }],
    ["input", "an _inputs body_facet", async (store) => {
      const i = await mut(store, "_inputs", "create", { path: "nb-in", target_pattern: "notebook", body_facet: "scratch", visibility: "private" });
      expect(i.error, i.message).toBeFalsy();
      return async () => { await mut(store, "_inputs", "archive", { id: i.entry.id }); };
    }],
    ["input", "an _inputs facet_mapping key", async (store) => {
      const i = await mut(store, "_inputs", "create", { path: "nb-map", target_pattern: "notebook", facet_mapping: JSON.stringify({ title: "body.title", scratch: "body.note" }), visibility: "private" });
      expect(i.error, i.message).toBeFalsy();
      return async () => { await mut(store, "_inputs", "archive", { id: i.entry.id }); };
    }],
    ["upload_token", "an active, unconsumed upload token's target_facet", async (store) => {
      const id = (await sql(store, `SELECT id FROM notebook ORDER BY id LIMIT 1`))[0].id;
      const t = await mut(store, "_access_tokens", "create", { scope: "upload", constraints: JSON.stringify({ target_pattern: "notebook", target_id: id, target_facet: "scratch" }) });
      expect(t.error, t.message).toBeFalsy();
      return async () => { await mut(store, "_access_tokens", "archive", { id: t.entry.id }); };
    }],
    ["clipboard", "a _clipboards rule", async (store) => {
      const c = await mut(store, "_clipboards", "create", { name: "nb", target_pattern: "notebook", fields: [{ facet: "scratch", min_length: 1 }] });
      expect(c.error, c.message).toBeFalsy();
      return async () => { await mut(store, "_clipboards", "archive", { id: c.entry.id }); };
    }],
  ];

  it.each(FACET_REFERENCES)("is refused while %s (%s) names the facet; preview lists it, apply re-checks", async (kind, _label, plant) => {
    const store = getStore();
    await notebook(store);
    const remove = await plant(store);
    const p = await propose(store, { type: "drop_facet", pattern_name: "notebook", facet: "scratch" });
    expect(p.error).toBeUndefined();
    expect(p.preview.facet_references).toEqual(expect.arrayContaining([expect.objectContaining({ kind })]));
    const a = await apply(store, p.change_id);
    expect(a.error).toBe(true);
    expect((await sql(store, `PRAGMA table_info(notebook)`)).map((c) => c.name)).toContain("scratch");
    await remove();
    const again = await propose(store, { type: "drop_facet", pattern_name: "notebook", facet: "scratch" });
    expect(again.preview?.facet_references ?? []).toEqual([]);
    expect((await apply(store, again.change_id)).error).toBeUndefined();
  });

  it("an upload token whose expires_at is stored in a non-ISO form, later today, still counts as live", async () => {
    const store = getStore();
    await notebook(store);
    const id = (await sql(store, `SELECT id FROM notebook ORDER BY id LIMIT 1`))[0].id;
    const t = await mut(store, "_access_tokens", "create", { scope: "upload", constraints: JSON.stringify({ target_pattern: "notebook", target_id: id, target_facet: "scratch" }) });
    expect(t.error, t.message).toBeFalsy();
    // "YYYY-MM-DD HH:MM:SS", the last second of today: compared as text against an
    // ISO "…T…Z" now, the space sorts before "T" and the token would look expired.
    await sql(store, `UPDATE "_access_tokens" SET expires_at = strftime('%Y-%m-%d 23:59:59', 'now') WHERE id = ?`, t.entry.id);
    const p = await propose(store, { type: "drop_facet", pattern_name: "notebook", facet: "scratch" });
    expect(p.error, p.message).toBeUndefined();
    expect(p.preview.facet_references).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "upload_token" })]));
    expect((await apply(store, p.change_id)).error).toBe(true);
    expect((await sql(store, `PRAGMA table_info(notebook)`)).map((c) => c.name)).toContain("scratch");
  });

  it("re-checks references at apply: one planted after a clean propose blocks the drop", async () => {
    const store = getStore();
    await notebook(store);
    const p = await propose(store, { type: "drop_facet", pattern_name: "notebook", facet: "scratch" });
    expect(p.error, "control: the clean drop is proposable").toBeUndefined();
    expect(p.preview.facet_references).toEqual([]);
    await mut(store, "_views", "create", { pattern: "notebook", name: "late", view_type: "table", config: JSON.stringify({ columns: ["scratch"] }) });
    expect((await apply(store, p.change_id)).error).toBe(true);
    expect((await sql(store, `PRAGMA table_info(notebook)`)).map((c) => c.name)).toContain("scratch");
  });

  // Owner decision O4: a reference facet is retired in Phase 3, not dropped here.
  it("refuses a reference facet, pointing to the Phase 3 retirement", async () => {
    const store = getStore();
    await createPattern(store, "goals");
    await createPatternWith(store, "plans", [{ name: "title", type: "text" }, { name: "goal_id", type: "integer", links: { pattern: "goals" } }]);
    const p = await propose(store, { type: "drop_facet", pattern_name: "plans", facet: "goal_id" });
    expect(p.error).toBe(true);
    expect(p.message).toMatch(/reference/i);
    expect(p.message).toMatch(/Phase 3|declare_relation|relation/i);
  });

  it("refuses dropping a pattern's only facet", async () => {
    const store = getStore();
    await createPattern(store, "solo");
    const p = await propose(store, { type: "drop_facet", pattern_name: "solo", facet: "title" });
    expect(p.error).toBe(true);
    expect(p.message).toMatch(/only facet|last facet|at least one/i);
  });

  it("reverting the drop restores the state BEFORE it: the bookmark is captured before the column goes", async () => {
    const store = getStore();
    await notebook(store);
    await runInDurableObject(store, async (_i, state) => {
      await booted(state, () => "bm-before-drop", async (hive, trace) => {
        const p = JSON.parse(await hive.proposeChange("drop", JSON.stringify({ type: "drop_facet", pattern_name: "notebook", facet: "scratch" })));
        expect(p.error, p.message).toBeUndefined();
        trace.events.length = 0;
        expect(JSON.parse(await hive.applyChange(p.change_id)).error).toBeUndefined();
        const drop = trace.events.indexOf("change:drop-column");
        expect(drop, `the drop ran: ${trace.events.join(", ")}`).toBeGreaterThanOrEqual(0);
        const bm = trace.events.indexOf("bookmark");
        expect(bm, "a bookmark was captured").toBeGreaterThanOrEqual(0);
        expect(bm, `captured before the column was dropped: ${trace.events.join(", ")}`).toBeLessThan(drop);
        const row = state.storage.sql.exec(`SELECT id, bookmark FROM _schema_history WHERE change_type = 'drop_facet'`).toArray()[0] as any;
        expect(row.bookmark).toBe("bm-before-drop");
        const r = JSON.parse(await hive.revertChange(row.id));
        expect(r.reverted).toBe(true);
        expect(trace.restored).toEqual(["bm-before-drop"]);
      });
    });
  });
});

// =====================================================================
// Change bookmarks: a schema-history bookmark is the state BEFORE the change
// =====================================================================

describe("change bookmarks", () => {
  it("applyChange captures the PITR bookmark before the change's first data effect (set_doctrine)", async () => {
    const store = getStore();
    await createPattern(store, "notes");
    await runInDurableObject(store, async (_i, state) => {
      await booted(state, () => "bm-before-doctrine", async (hive, trace) => {
        const p = JSON.parse(await hive.proposeChange("doctrine", JSON.stringify({ type: "set_doctrine", pattern_name: "notes", doctrine: "a new doctrine" })));
        expect(p.error, p.message).toBeUndefined();
        trace.events.length = 0;
        expect(JSON.parse(await hive.applyChange(p.change_id)).error).toBeUndefined();
        const effect = trace.events.indexOf("change:set-doctrine");
        expect(effect, `the change ran: ${trace.events.join(", ")}`).toBeGreaterThanOrEqual(0);
        expect(trace.events.indexOf("bookmark"), `captured before the change: ${trace.events.join(", ")}`).toBeGreaterThanOrEqual(0);
        expect(trace.events.indexOf("bookmark")).toBeLessThan(effect);
        const row = state.storage.sql.exec(`SELECT bookmark FROM _schema_history WHERE change_type = 'set_doctrine'`).toArray()[0] as any;
        expect(row.bookmark).toBe("bm-before-doctrine");
      });
    });
  });

  it("the same holds for declare_relation", async () => {
    const store = getStore();
    await createPattern(store, "notes");
    await runInDurableObject(store, async (_i, state) => {
      await booted(state, () => "bm-before-declare", async (hive, trace) => {
        const p = JSON.parse(await hive.proposeChange("declare", JSON.stringify(declareChange({ name: "echoes", inverse: "echoed-by", source: ["notes"], target: ["notes"] }))));
        expect(p.error, p.message).toBeUndefined();
        trace.events.length = 0;
        expect(JSON.parse(await hive.applyChange(p.change_id)).error).toBeUndefined();
        const effect = trace.events.indexOf("v17:write-relations"); // INSERT INTO _relations
        expect(effect, `the change ran: ${trace.events.join(", ")}`).toBeGreaterThanOrEqual(0);
        expect(trace.events.indexOf("bookmark"), `captured before the change: ${trace.events.join(", ")}`).toBeGreaterThanOrEqual(0);
        expect(trace.events.indexOf("bookmark")).toBeLessThan(effect);
      });
    });
  });
});

// =====================================================================
// Canonical datetime storage (§8 engine fix)
// =====================================================================

describe("canonical datetime", () => {
  async function events(store: Store) {
    await createPatternWith(store, "events", [{ name: "title", type: "text" }, { name: "when", type: "datetime" }], "dataset");
  }
  // Owner decision O1: the rule covers `datetime` facets in every pattern class.
  async function journal(store: Store) {
    await createPatternWith(store, "journal", [{ name: "title", type: "text" }, { name: "note", type: "text" }, { name: "when", type: "datetime" }], "knowledge");
  }
  const storedK = async (store: Store, id: number) => (await sql(store, `SELECT "when" FROM journal WHERE id = ?`, id))[0].when;
  const stored = async (store: Store, id: number) => (await sql(store, `SELECT "when" FROM events WHERE id = ?`, id))[0].when;

  // Owner ruling 2026-10-19 (df-79a5e65f): only an unambiguous calendar day or a
  // full timestamp is a date. Periods and impossible dates are refused, never
  // resolved or rolled over: resolving a period is the writer's job.
  const NOT_A_DAY: [string, string, boolean][] = [
    ["year only", "2026", true],
    ["year-month", "2026-03", true],
    ["year/month", "2026/03", true],
    ["month and year", "March 2026", true],
    ["Feb 30 (Date.parse rolls it to March)", "2026-02-30", false],
    ["month 13", "2026-13-01", false],
    ["April 31", "2026-04-31", false],
    ["not a date", "soonish", false],
    ["empty", "", false],
  ];

  it.each(NOT_A_DAY)("refuses %s in every pattern class, writing nothing", async (_label, input, period) => {
    const store = getStore();
    await events(store);
    await journal(store);
    for (const pattern of ["events", "journal"]) {
      const before = (await sql(store, `SELECT COUNT(*) AS n FROM "${pattern}"`))[0].n;
      const r = await mut(store, pattern, "create", { title: input, when: input });
      expect(r.error, `${pattern}: ${JSON.stringify(input)}`).toBe(true);
      expect(r.message, pattern).toMatch(/full date|calendar date|valid date/i);
      if (period) expect(r.message, pattern).toMatch(/writer/i);
      expect((await sql(store, `SELECT COUNT(*) AS n FROM "${pattern}"`))[0].n, `${pattern}: nothing written`).toBe(before);
      // An update is held to the same rule and leaves the stored value alone.
      const ok = await mut(store, pattern, "create", { title: "anchor", when: "2026-03-07" });
      expect(ok.error, ok.message).toBeUndefined();
      expect((await mut(store, pattern, "update", { id: ok.entry.id, when: input })).error, `${pattern} update`).toBe(true);
      expect((await sql(store, `SELECT "when" FROM "${pattern}" WHERE id = ?`, ok.entry.id))[0].when).toBe("2026-03-07");
    }
  });

  it("the upload path refuses a partial date too, writing nothing and leaving the token usable", async () => {
    const store = getStore();
    await createPatternWith(store, "logbook", [{ name: "title", type: "text" }, { name: "when", type: "text" }], "knowledge");
    const id = (await mut(store, "logbook", "create", { title: "x", when: "kept" })).entry.id;
    const tok = await mut(store, "_access_tokens", "create", { scope: "upload", constraints: JSON.stringify({ target_pattern: "logbook", target_id: id, target_facet: "when" }) });
    expect(tok.error, tok.message).toBeFalsy();
    await sql(store, `UPDATE _fields SET type = 'datetime' WHERE object_name = 'logbook' AND name = 'when'`);
    const r = JSON.parse(await store.consumeUpload(tok.entry.token, "2026-03"));
    expect(r.error).toBe(true);
    expect((await sql(store, `SELECT "when" FROM logbook WHERE id = ?`, id))[0].when).toBe("kept");
    const ok = JSON.parse(await store.consumeUpload(tok.entry.token, "2026-03-07"));
    expect(ok.error, "the refused upload did not consume the token").toBeUndefined();
    expect((await sql(store, `SELECT "when" FROM logbook WHERE id = ?`, id))[0].when).toBe("2026-03-07");
  });

  it("a date-only input is stored as YYYY-MM-DD", async () => {
    const store = getStore();
    await events(store);
    for (const input of ["2026-03-07", "March 7, 2026", "7 March 2026"]) {
      const r = await mut(store, "events", "create", { title: input, when: input });
      expect(r.error, input).toBeUndefined();
      expect(await stored(store, r.entry.id), input).toBe("2026-03-07");
      expect(r.entry.when, input).toBe("2026-03-07");
    }
  });

  it("an input with a time is stored as a full ISO 8601 UTC timestamp", async () => {
    const store = getStore();
    await events(store);
    for (const [input, want] of [
      ["2026-03-07T14:30:00Z", "2026-03-07T14:30:00.000Z"],
      ["2026-03-07T14:30:00+02:00", "2026-03-07T12:30:00.000Z"],
      ["2026-03-07 14:30", "2026-03-07T14:30:00.000Z"],
    ] as const) {
      const r = await mut(store, "events", "create", { title: input, when: input });
      expect(r.error, input).toBeUndefined();
      expect(await stored(store, r.entry.id), input).toBe(want);
    }
  });

  it("relative phrases stay refused", async () => {
    const store = getStore();
    await events(store);
    for (const input of ["next week", "tomorrow", "this week", "Q2 2026"]) {
      const r = await mut(store, "events", "create", { title: input, when: input });
      expect(r.error, input).toBe(true);
    }
    expect(await countRows(store, "events")).toBe(0);
  });

  it("updates and batch creates canonicalize too", async () => {
    const store = getStore();
    await events(store);
    const r = await mut(store, "events", "create", { title: "a", when: "2026-01-01" });
    expect((await mut(store, "events", "update", { id: r.entry.id, when: "March 7, 2026" })).error).toBeUndefined();
    expect(await stored(store, r.entry.id)).toBe("2026-03-07");
    const b = await batch(store, [{ pattern: "events", operation: "create", data: { title: "b", when: "April 8, 2026" } }]);
    expect(b.error).toBeUndefined();
    expect(await stored(store, b.results[0].entry.id)).toBe("2026-04-08");
  });

  it("knowledge patterns too: datetime facets are canonicalized and relative phrases refused; text facets stay advisory", async () => {
    const store = getStore();
    await journal(store);
    for (const [input, want] of [
      ["March 7, 2026", "2026-03-07"],
      ["2026-03-07", "2026-03-07"],
      ["2026-03-07T14:30:00+02:00", "2026-03-07T12:30:00.000Z"],
    ] as const) {
      const r = await mut(store, "journal", "create", { title: input, when: input });
      expect(r.error, input).toBeUndefined();
      expect(await storedK(store, r.entry.id), input).toBe(want);
    }
    const before = await countRows(store, "journal");
    for (const input of ["next week", "tomorrow", "Q2 2026"]) {
      expect((await mut(store, "journal", "create", { title: input, when: input })).error, input).toBe(true);
    }
    expect(await countRows(store, "journal")).toBe(before);
    // Prose stays prose: a text facet in a knowledge pattern is never coerced or refused.
    const prose = await mut(store, "journal", "create", { title: "plans", note: "next week, probably" });
    expect(prose.error).toBeUndefined();
    expect((await sql(store, `SELECT note FROM journal WHERE id = ?`, prose.entry.id))[0].note).toBe("next week, probably");
  });

  it("knowledge patterns: updates canonicalize, and existing values stay untouched until written", async () => {
    const store = getStore();
    await journal(store);
    const r = await mut(store, "journal", "create", { title: "a", when: "2026-01-01" });
    expect((await mut(store, "journal", "update", { id: r.entry.id, when: "April 8, 2026" })).error).toBeUndefined();
    expect(await storedK(store, r.entry.id)).toBe("2026-04-08");
    const id = await runInDurableObject(store, (_i, state) => {
      state.storage.sql.exec(`INSERT INTO journal (title, "when") VALUES ('legacy', 'sometime in spring')`);
      return (state.storage.sql.exec(`SELECT last_insert_rowid() AS id`).one() as { id: number }).id;
    });
    await boot(store);
    expect((await mut(store, "journal", "update", { id, title: "legacy, retitled" })).error).toBeUndefined();
    expect(await storedK(store, id), "an unrelated write leaves the stored value alone").toBe("sometime in spring");
  });

  it("an upload token can't target a datetime facet; one whose facet became datetime canonicalizes or refuses at consume", async () => {
    const store = getStore();
    await createPatternWith(store, "logbook", [{ name: "title", type: "text" }, { name: "when", type: "text" }], "knowledge");
    const r = await mut(store, "logbook", "create", { title: "x" });
    const id = r.entry.id;
    const mint = (facet: string) => mut(store, "_access_tokens", "create", { scope: "upload", constraints: JSON.stringify({ target_pattern: "logbook", target_id: id, target_facet: facet }) });
    const ok = await mint("when");          // a text facet today
    const bad = await mint("when");
    expect(ok.error, ok.message).toBeFalsy();
    // The facet's type drifts to datetime after mint (as no change type does today):
    await sql(store, `UPDATE _fields SET type = 'datetime' WHERE object_name = 'logbook' AND name = 'when'`);
    expect((await mint("when")).error, "minting against a datetime facet is refused").toBe(true);
    const up = JSON.parse(await store.consumeUpload(ok.entry.token, "March 7, 2026"));
    expect(up.error, up.message).toBeUndefined();
    expect((await sql(store, `SELECT "when" FROM logbook WHERE id = ?`, id))[0].when).toBe("2026-03-07");
    const rel = JSON.parse(await store.consumeUpload(bad.entry.token, "next week"));
    expect(rel.error).toBe(true);
    expect((await sql(store, `SELECT "when" FROM logbook WHERE id = ?`, id))[0].when, "a refused upload writes nothing").toBe("2026-03-07");
  });

  it("existing non-canonical values are left untouched until that facet is written", async () => {
    const store = getStore();
    await events(store);
    const id = await runInDurableObject(store, (_i, state) => {
      state.storage.sql.exec(`INSERT INTO events (title, "when") VALUES ('legacy', 'March 7, 2026')`);
      return (state.storage.sql.exec(`SELECT last_insert_rowid() AS id`).one() as { id: number }).id;
    });
    await boot(store); // no migration rewrites it
    const q = JSON.parse(await store.query("events", JSON.stringify([`id=${id}`]), "", "", 10, false));
    expect(q.entries[0].when, "reads return the stored value as-is").toBe("March 7, 2026");
    expect((await mut(store, "events", "update", { id, title: "legacy, retitled" })).error).toBeUndefined();
    expect(await stored(store, id), "writing another facet leaves it alone").toBe("March 7, 2026");
    expect((await mut(store, "events", "update", { id, when: "March 7, 2026" })).error).toBeUndefined();
    expect(await stored(store, id), "writing the facet canonicalizes it").toBe("2026-03-07");
  });
});
