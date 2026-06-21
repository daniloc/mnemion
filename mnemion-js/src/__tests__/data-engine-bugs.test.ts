// Regression tests for five confirmed data-engine correctness bugs.
//
// Each `describe` below maps to one bug; the test is written so it would FAIL
// against the pre-fix code and pass against the fix. Scope is the data engine
// (entities/Hive/data.ts) plus the embed-after-mutate wiring in hive.ts.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";
import { query as engineQuery, type DataContext } from "../../entities/Hive/data";

function getStore(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName(`user:test:${crypto.randomUUID()}`);
  return env.MNEMION_HIVE.get(id);
}

async function createPattern(
  store: DurableObjectStub<HiveDO>,
  name: string,
  facets: { name: string; type: string; required?: boolean }[],
  pattern_class?: "knowledge" | "dataset",
) {
  const proposed = JSON.parse(await store.proposeChange(`Create ${name}`, JSON.stringify({
    type: "create_pattern",
    pattern_name: name,
    pattern_description: `Test ${name}`,
    doctrine: `Doctrine for ${name}`,
    pattern_class,
    facets,
  })));
  if (proposed.error) throw new Error(proposed.message);
  const applied = JSON.parse(await store.applyChange(proposed.change_id));
  if (applied.error) throw new Error(applied.message);
  return applied;
}

const create = (store: DurableObjectStub<HiveDO>, pattern: string, data: Record<string, unknown>) =>
  store.mutate(pattern, "create", JSON.stringify(data)).then(JSON.parse);
const mutate = (store: DurableObjectStub<HiveDO>, pattern: string, op: string, data: Record<string, unknown>) =>
  store.mutate(pattern, op, JSON.stringify(data)).then(JSON.parse);
const query = (store: DurableObjectStub<HiveDO>, pattern: string, filter: string[]) =>
  store.query(pattern, JSON.stringify(filter), "", "", 100, false).then(JSON.parse);

// === BUG 1: archive/unarchive must reach the Vectorize GC/re-embed wiring ===
//
// archive() and unarchive() return { operation, pattern, id, uri } with NO
// `entry` key. embedAfterMutate was called with `result.entry?.id` (undefined),
// so its `if (!id) return` bailed: archive never GC'd the vector, unarchive
// never re-embedded. The fix passes `result.entry?.id ?? result.id`. We spy on
// the DO instance's embedAfterMutate (the call site that the bug lived in) so we
// assert the resolved id without a real AI/Vectorize round-trip — instance
// methods are spyable even where ESM namespace exports may not be.

describe("BUG 1: archive/unarchive embed wiring", () => {
  afterEach(() => vi.restoreAllMocks());

  it("archive passes the entry id into embedAfterMutate (so removeEntry can GC)", async () => {
    const store = getStore();
    await createPattern(store, "notes1", [{ name: "body", type: "text" }]);
    const created = await create(store, "notes1", { body: "alpha" });
    expect(created.entry.id).toBeDefined();
    const id = created.entry.id;

    await runInDurableObject(store, async (instance) => {
      const spy = vi.spyOn(instance as any, "embedAfterMutate");
      const archived = JSON.parse(await instance.mutate("notes1", "archive", JSON.stringify({ id })));
      expect(archived.error).toBeUndefined();
      // Pre-fix the third arg (id) was undefined → embedAfterMutate bailed and the
      // vector was orphaned. It must now be the real id.
      expect(spy).toHaveBeenCalled();
      const args = spy.mock.calls.find((c) => c[1] === "archive")!;
      expect(args[0]).toBe("notes1");
      expect(args[2]).toBe(id);
    });
  });

  it("unarchive passes the entry id into embedAfterMutate (so it re-embeds)", async () => {
    const store = getStore();
    await createPattern(store, "notes2", [{ name: "body", type: "text" }]);
    const created = await create(store, "notes2", { body: "beta" });
    const id = created.entry.id;
    await mutate(store, "notes2", "archive", { id });

    await runInDurableObject(store, async (instance) => {
      const spy = vi.spyOn(instance as any, "embedAfterMutate");
      const unarchived = JSON.parse(await instance.mutate("notes2", "unarchive", JSON.stringify({ id })));
      expect(unarchived.error).toBeUndefined();
      // unarchive !== "archive" → embedAfterMutate's else branch → embedEntry(id).
      // Pre-fix the id was undefined → bailed → no re-embed.
      expect(spy).toHaveBeenCalled();
      const args = spy.mock.calls.find((c) => c[1] === "unarchive")!;
      expect(args[0]).toBe("notes2");
      expect(args[2]).toBe(id);
    });
  });
});

// === BUG 2: ~ filter and search must escape LIKE wildcards ===

describe("BUG 2: LIKE wildcard escaping", () => {
  it("~ filter treats _ as a literal, not a single-char wildcard", async () => {
    const store = getStore();
    await createPattern(store, "things", [{ name: "name", type: "text" }]);
    await create(store, "things", { name: "a_b" });
    await create(store, "things", { name: "axb" });

    const r = await query(store, "things", ["name~a_b"]);
    expect(r.error).toBeUndefined();
    const names = r.entries.map((e: any) => e.name).sort();
    // Literal "a_b" matches; "axb" (where _ would wildcard-match x) must NOT.
    expect(names).toEqual(["a_b"]);
  });

  it("~ filter treats % as a literal, not a multi-char wildcard", async () => {
    const store = getStore();
    await createPattern(store, "things2", [{ name: "name", type: "text" }]);
    await create(store, "things2", { name: "50%off" });
    await create(store, "things2", { name: "50somethingoff" });

    const r = await query(store, "things2", ["name~50%off"]);
    const names = r.entries.map((e: any) => e.name);
    expect(names).toEqual(["50%off"]);
  });

  it("search treats _ as a literal, not a wildcard", async () => {
    const store = getStore();
    await createPattern(store, "docs1", [{ name: "body", type: "text" }]);
    await create(store, "docs1", { body: "match a_b here" });
    await create(store, "docs1", { body: "no match axb here" });

    const r = JSON.parse(await store.search("a_b", JSON.stringify(["docs1"]), 20));
    expect(r.count).toBe(1);
    expect(r.results[0].entry.body).toContain("a_b");
  });
});

// === BUG 3: filter field must be validated against the pattern's columns ===

describe("BUG 3: filter field validation", () => {
  it("returns a clean error for a filter on a non-existent column", async () => {
    const store = getStore();
    await createPattern(store, "things3", [{ name: "name", type: "text" }]);
    const r = await query(store, "things3", ["nope=x"]);
    expect(r.error).toBe(true);
    // A clean validation message, not a raw SQL "no such column" throw.
    expect(r.message).toMatch(/unknown facet|nope/i);
    expect(r.message).not.toMatch(/Query failed/);
  });

  it("still accepts a filter on a real facet", async () => {
    const store = getStore();
    await createPattern(store, "things4", [{ name: "name", type: "text" }]);
    await create(store, "things4", { name: "hello" });
    const r = await query(store, "things4", ["name=hello"]);
    expect(r.error).toBeUndefined();
    expect(r.count).toBe(1);
  });
});

// === BUG 4: unarchive needs the changes()==0 not-found guard ===

describe("BUG 4: unarchive not-found guard", () => {
  it("errors when unarchiving a never-existing id", async () => {
    const store = getStore();
    await createPattern(store, "things5", [{ name: "name", type: "text" }]);
    const r = await mutate(store, "things5", "unarchive", { id: 9999 });
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/not found|not archived/i);
  });

  it("errors when unarchiving an already-active entry", async () => {
    const store = getStore();
    await createPattern(store, "things6", [{ name: "name", type: "text" }]);
    const created = await create(store, "things6", { name: "active" });
    const r = await mutate(store, "things6", "unarchive", { id: created.entry.id });
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/not found|not archived/i);
  });
});

// === BUG 5: patch must not clear a dataset's required facet ===

describe("BUG 5: patch required-facet guard on datasets", () => {
  it("rejects a patch that empties a required text facet on a dataset", async () => {
    const store = getStore();
    await createPattern(store, "records1", [
      { name: "title", type: "text", required: true },
    ], "dataset");
    const created = await create(store, "records1", { title: "keep" });
    // Replace the entire value with "" → would clear the required facet.
    const r = await mutate(store, "records1", "patch", {
      id: created.entry.id, facet: "title", match: "keep", replacement: "",
    });
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/required/i);
  });

  it("still allows a non-emptying patch on a required dataset facet", async () => {
    const store = getStore();
    await createPattern(store, "records2", [
      { name: "title", type: "text", required: true },
    ], "dataset");
    const created = await create(store, "records2", { title: "keep" });
    const r = await mutate(store, "records2", "patch", {
      id: created.entry.id, facet: "title", match: "keep", replacement: "kept",
    });
    expect(r.error).toBeUndefined();
    expect(r.entry.title).toBe("kept");
  });
});

// === Write-path errors are structured, symmetric with the read path ===
//
// A DB write throw (here a UNIQUE-index collision on _charter.key) must surface
// as the SAME { error, message } the read paths return — never a raw throw out
// of the RPC/MCP boundary. _charter is Open write-class with a unique active
// `key` index and no app-level dedup, so a duplicate key fails at SQL.
describe("write-path DB errors return structured errors (not raw throws)", () => {
  it("single mutate: a UNIQUE violation returns { error, message } instead of throwing", async () => {
    const store = getStore();
    const first = await mutate(store, "_charter", "create", { key: "dup_key_single", value: "a" });
    expect(first.error).toBeUndefined();

    // The contract under test: this must RESOLVE with a structured error, not reject.
    const r = await mutate(store, "_charter", "create", { key: "dup_key_single", value: "b" });
    expect(r.error).toBe(true);
    expect(typeof r.message).toBe("string");
    expect(r.message).toMatch(/Mutate failed/);
  });

  it("batch mutate: a UNIQUE violation rolls back atomically and returns a structured error", async () => {
    const store = getStore();
    const r = await store.batchMutate(JSON.stringify([
      { pattern: "_charter", operation: "create", data: { key: "dup_key_batch", value: "a" } },
      { pattern: "_charter", operation: "create", data: { key: "dup_key_batch", value: "b" } },
    ])).then(JSON.parse);
    // Structured error, not a raw throw across the boundary.
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/Batch mutate failed/);
    // Atomic: the first op must NOT have partially committed.
    const rows = await query(store, "_charter", ["key=dup_key_batch"]);
    expect(rows.entries.length).toBe(0);
  });
});

// === Unauthenticated public routes must not 500 on agent-mutated kernel config ===
//
// Both `_publications.filters` and `_inputs.facet_mapping` are validated only in
// ON_CREATE; an `update` can plant malformed JSON post-create. The malformed value
// is then JSON.parse'd at request time on UNAUTHENTICATED served routes (GET /p,
// POST /i). Pre-fix that parse was outside the engine's try/catch → an unhandled
// SyntaxError/TypeError propagated to the router as a 500 — a persistent,
// agent-armed public DoS. The fix moves the guard to the consumption chokepoint:
// a malformed value yields the engine's structured { error, message }, never a throw.
describe("public routes fail closed on malformed agent-mutated kernel config", () => {
  async function makePublication(store: DurableObjectStub<HiveDO>, path: string) {
    // notes pattern + one entry, then a publication projecting it.
    await createPattern(store, "pubnotes", [{ name: "title", type: "text", required: true }]);
    await create(store, "pubnotes", { title: "hello" });
    const pub = await mutate(store, "_publications", "create", {
      path, source_pattern: "pubnotes", format: "json",
    });
    if (pub.error) throw new Error(pub.message);
    return pub.entry;
  }

  it("(a) malformed _publications.filters (set via update) → clean 404, not a throw/500", async () => {
    const store = getStore();
    const pub = await makePublication(store, "broken-filters");

    // Plant malformed JSON via update — ON_CREATE validated filters, but update
    // re-runs no such hook, so the bad value lands in the column.
    const upd = await mutate(store, "_publications", "update", {
      id: pub.id, version: pub.version, filters: "status=done",  // not a JSON array
    });
    expect(upd.error).toBeUndefined();

    // The served path (servedQuery → query()'s now-guarded filter parse →
    // resolvePublication) must RESOLVE, never reject. Pre-fix the unguarded
    // JSON.parse threw out of the engine → router 500. Post-fix the engine
    // returns a structured error, which resolvePublication maps to a clean 404.
    const raw = await store.resolvePublication("broken-filters");
    const result = JSON.parse(raw);
    expect(result.found).toBe(false);
    // No raw parse/SQLite text ever rides out on the served path.
    expect(raw).not.toMatch(/SyntaxError|Unexpected token|SQLITE/i);
  });

  it("(a') filters that is valid JSON but the wrong shape (not array of strings) → clean 404", async () => {
    const store = getStore();
    const pub = await makePublication(store, "wrong-shape-filters");
    const upd = await mutate(store, "_publications", "update", {
      id: pub.id, version: pub.version, filters: JSON.stringify({ status: "done" }),  // object, not array
    });
    expect(upd.error).toBeUndefined();

    const result = JSON.parse(await store.resolvePublication("wrong-shape-filters"));
    expect(result.found).toBe(false);
  });

  it("(b) malformed _inputs.facet_mapping (set via update) → structured error from processInput, not a 500", async () => {
    const store = getStore();
    await createPattern(store, "innotes", [{ name: "title", type: "text" }]);
    const input = await mutate(store, "_inputs", "create", {
      path: "ingest-x", target_pattern: "innotes", facet_mapping: JSON.stringify({ title: "$.body.title" }),
    });
    if (input.error) throw new Error(input.message);

    // Plant malformed JSON post-create (ON_CREATE no longer guards on update).
    const upd = await mutate(store, "_inputs", "update", {
      id: input.entry.id, version: input.entry.version, facet_mapping: "{not json",
    });
    expect(upd.error).toBeUndefined();

    // POST /i/{path} routes through processInput — must resolve to a structured error.
    const raw = await store.processInput("ingest-x", JSON.stringify({ title: "hi" }), "{}", "{}");
    const result = JSON.parse(raw);
    expect(result.error).toBe(true);
    expect(result.message).toMatch(/facet_mapping/i);
  });

  it("(b') facet_mapping that is valid JSON but not an object (array) → structured error", async () => {
    const store = getStore();
    await createPattern(store, "innotes2", [{ name: "title", type: "text" }]);
    const input = await mutate(store, "_inputs", "create", {
      path: "ingest-y", target_pattern: "innotes2", facet_mapping: JSON.stringify({ title: "$.body.title" }),
    });
    const upd = await mutate(store, "_inputs", "update", {
      id: input.entry.id, version: input.entry.version, facet_mapping: JSON.stringify(["title"]),
    });
    expect(upd.error).toBeUndefined();

    const result = JSON.parse(await store.processInput("ingest-y", "{}", "{}", "{}"));
    expect(result.error).toBe(true);
    expect(result.message).toMatch(/facet_mapping/i);
  });
});

// === Read-path errors are generic — no raw SQLite text leaks on the served plane ===
//
// query()/aggregate() run untrusted via servedQuery. A DB-level throw (here a
// SQL type error from comparing text against a value the engine couldn't reject
// up front) must surface as a GENERIC "Query failed" — never an interpolated
// err.message echoing table/column names. Mirrors executeMutate's hardening so
// the served path can't leak schema by construction, not by caller discipline.
describe("read-path errors return a generic message with no raw SQLite text", () => {
  // Build a minimal trusted DataContext whose db.exec throws a SQLite-flavored
  // error mentioning a table/column — exactly what would leak if interpolated.
  function ctxThatThrows(): DataContext {
    return {
      db: {
        exec() {
          throw new Error('SQLITE_ERROR: no such column: secret_token in table "_access_tokens"');
        },
      } as any,
      patternExists: () => true,
      listPatterns: () => ["notes"],
      entryExists: () => true,
      hasKernelVersion: () => true,
      facetMeta: () => ({ type: "text" }),
      patternClass: () => "knowledge",
      actor: "owner",
      trusted: true,
    };
  }

  // The raw SQLite vocabulary the genericized catch must NEVER surface.
  const leaks = /SQLITE|no such column|secret_token|_access_tokens/;

  it("query: a DB throw returns 'Query failed' with no raw err.message", () => {
    const result = JSON.parse(engineQuery(ctxThatThrows(), "notes", "", "", "", 100, false));
    expect(result.error).toBe(true);
    expect(result.message).toBe("Query failed");
    expect(result.message).not.toMatch(leaks);
  });

  it("query (count_only): a DB throw returns 'Query failed' with no raw err.message", () => {
    const result = JSON.parse(engineQuery(ctxThatThrows(), "notes", "", "", "", 100, true));
    expect(result.error).toBe(true);
    expect(result.message).toBe("Query failed");
    expect(result.message).not.toMatch(leaks);
  });

  it("aggregate: a DB throw returns 'Aggregate failed' with no raw err.message", () => {
    // group_by routes into aggregate(); the exec throw lands in its catch.
    const result = JSON.parse(engineQuery(ctxThatThrows(), "notes", "", "", "", 100, false, "title"));
    expect(result.error).toBe(true);
    expect(result.message).toBe("Aggregate failed");
    expect(result.message).not.toMatch(leaks);
  });
});
