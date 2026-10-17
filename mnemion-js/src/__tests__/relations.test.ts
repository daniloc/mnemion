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
import type { HiveDO } from "../../entities/Hive/hive";
import { initializeSchema } from "../../entities/Hive/schema";
import { prime, type PrimeContext } from "../../entities/Hive/prime";
// This file reads its own source to prove each palette behavior names a describe that
// exists. A ?raw default import, not import.meta.glob: Vite drops the importing file
// from its own glob results, so a self-glob is always empty.
import THIS_FILE_SRC from "./relations.test.ts?raw";
import { getAgentByName } from "agents";

type Store = DurableObjectStub<HiveDO>;

// === The design's fixed vocabulary (project-docs/relations.md, "Kernel defaults") ===

const KERNEL_DEFAULTS = [
  { name: "supersedes", inverse: "superseded-by", behaviors: ["supersession", "acyclic"] },
  { name: "references", inverse: "referenced-by", behaviors: [] as string[] },
  { name: "depends-on", inverse: "required-by", behaviors: ["acyclic"] },
  { name: "derived-from", inverse: "source-of", behaviors: ["acyclic"] },
  // Phase 1: acyclic only — containment arrives in Phase 2.
  { name: "part-of", inverse: "has-part", behaviors: ["acyclic"] },
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
 * every ACTIVE link's label names an ACTIVE relation, its endpoints satisfy that
 * relation's source/target, both endpoint rows EXIST (present in their pattern's
 * table; an archived entry or pattern still exists, which makes the link dormant,
 * not dangling), and a cardinality-`one` relation holds at most one active link per
 * source entry. Returns human-readable violations (empty = holds).
 */
async function totalityViolations(store: Store): Promise<string[]> {
  const rels = await sql(store, `SELECT * FROM "_relations" WHERE archived_at IS NULL`);
  const byName = new Map(rels.map((r) => [r.name as string, r]));
  const out: string[] = [];
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
      expect(r.legacy, k.name).toBe(0);
      expect(String(r.description).length, `${k.name} description meets the quality bar`).toBeGreaterThanOrEqual(120);
    }
    // No behavior is declared before the engine performs it: part-of has no containment yet.
    expect(list(rows.find((x) => x.name === "part-of")!.behaviors)).not.toContain("containment");
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
    expect(refines.legacy).toBe(1);
    expect(String(refines.description).length).toBeGreaterThan(0);
    expect(String(refines.inverse).length).toBeGreaterThan(0);
    expect(refines.inverse).not.toBe("refines");

    const ethos = await relationRow(store, "ethos-grounds");
    expect(new Set(list(ethos.source))).toEqual(new Set(["axioms", "notes"]));
    expect(list(ethos.target)).toEqual(["frames"]);
    expect(ethos.legacy).toBe(1);

    const inspired = await relationRow(store, "Inspired By");
    expect(inspired, "a non-kebab legacy label is declared verbatim").toBeDefined();
    expect(inspired.legacy).toBe(1);

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

  it("warns at boot for every legacy description until it is amended", async () => {
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

    const { proposed, applied } = await amend(store, { name: "refines", description: DESC("refines") });
    expect(proposed.error).toBeUndefined();
    expect(applied.error).toBeUndefined();
    expect((await relationRow(store, "refines")).legacy).toBe(0);

    const warn2 = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await boot(store);
      const text = warn2.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(text).toContain("ethos-grounds");   // still legacy
      expect(text).not.toContain("refines");     // paid down
    } finally { warn2.mockRestore(); }
  });

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
  const SEED_DATA_FILES = new Set(["../../shared/core/dev-seed.ts"]);
  const LINKS_SQL = /\b(?:FROM|INTO|UPDATE|JOIN)\s+"?_links"?(?!\w)/i;
  const LABEL_CMP = /\blabel\s*(?:=|==|!=|<>|\bIN\b|\bLIKE\b|\bGLOB\b|\bIS\b)/i;
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
    expect(row).toMatchObject({ name: "cites", inverse: "cited-by", description: DESC("cites"), cardinality: "many", kernel: 0, legacy: 0 });
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
    ["behavior containment is not yet supported", { behaviors: ["containment"] }, /not yet supported/i],
    ["unknown behavior", { behaviors: ["blocking"] }, /blocking/],
    ["required is not yet supported", { required: true }, /not yet supported/i],
    ["chain is not yet supported", { chain: ["references", "depends-on"] }, /not yet supported/i],
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
    const contain = (await amend(store, { name: "cites", behaviors: ["containment"] })).proposed;
    expect(contain.error).toBe(true);
    expect(contain.message).toMatch(/not yet supported/i);
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

  it("amending a legacy relation's description clears the legacy flag", async () => {
    const store = getStore();
    await seedLegacyLinks(store);
    await boot(store);
    expect((await relationRow(store, "refines")).legacy).toBe(1);
    const { applied } = await amend(store, { name: "refines", description: DESC("refines") });
    expect(applied.error).toBeUndefined();
    const row = await relationRow(store, "refines");
    expect(row.legacy).toBe(0);
    expect(row.description).toBe(DESC("refines"));
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
// Palette totality: every behavior in the palette has an enforcement test
// =====================================================================

const RELATIONS_MODULE = import.meta.glob("../../entities/Hive/relations.ts", { eager: true }) as Record<string, any>;


/** Each palette behavior → the describe in this file that proves the engine enforces it. */
const ENFORCED_BY: Record<string, string> = {
  supersession: "behavior by declaration",
  acyclic: "acyclicity",
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

  it("the Phase 1 palette declares no behavior the engine does not yet perform", () => {
    const palette = Object.keys(RELATIONS_MODULE[RELATIONS_MODULE_PATH]?.BEHAVIOR_PALETTE ?? {});
    for (const deferred of ["containment", "required", "chain", "blocking", "quiet", "rollup"])
      expect(palette).not.toContain(deferred);
    expect(palette.length).toBe(2);
  });
});

// =====================================================================
// Relation declaration totality: the oracle over the whole edge store
// =====================================================================

describe("relation declaration totality", () => {
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
