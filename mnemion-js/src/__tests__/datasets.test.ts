// Tabular datasets: pattern_class, strict write-time validation, and query
// aggregation. Datasets are the "records aggregated by computation" texture —
// distinct from knowledge patterns (recalled by meaning). These tests cover the
// HiveDO RPC surface the MCP tools sit on.

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";

function getStore(): DurableObjectStub<HiveDO> {
  // Unique per describe-block name so isolatedStorage rollback isn't relied on
  // across the suite; a fresh id keeps pattern names from colliding.
  const id = env.MNEMION_HIVE.idFromName(`ds:${Math.random()}`);
  return env.MNEMION_HIVE.get(id);
}

async function createPattern(
  store: DurableObjectStub<HiveDO>,
  name: string,
  facets: { name: string; type: string; required?: boolean; options?: string[] }[],
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

// === Pattern class surfacing ===

describe("pattern_class", () => {
  it("defaults to knowledge and is omitted from the index", async () => {
    const store = getStore();
    await createPattern(store, "notes", [{ name: "body", type: "text" }]);
    const index = JSON.parse(await store.getIndex());
    const pat = index.patterns.find((p: any) => p.name === "notes");
    expect(pat.pattern_class).toBeUndefined();
    const schema = JSON.parse(await store.getSchema("notes"));
    expect(schema.pattern_class).toBe("knowledge");
  });

  it("surfaces dataset class in index and schema", async () => {
    const store = getStore();
    await createPattern(store, "readings", [{ name: "value", type: "number" }], "dataset");
    const index = JSON.parse(await store.getIndex());
    expect(index.patterns.find((p: any) => p.name === "readings").pattern_class).toBe("dataset");
    expect(JSON.parse(await store.getSchema("readings")).pattern_class).toBe("dataset");
  });

  it("rejects an unknown class", async () => {
    const store = getStore();
    const r = JSON.parse(await store.proposeChange("bad", JSON.stringify({
      type: "create_pattern", pattern_name: "x", doctrine: "d",
      pattern_class: "spreadsheet", facets: [{ name: "a", type: "text" }],
    })));
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/Invalid pattern_class/);
  });

  it("converts a pattern with set_class", async () => {
    const store = getStore();
    await createPattern(store, "metrics", [{ name: "value", type: "number" }]);
    const proposed = JSON.parse(await store.proposeChange("to dataset", JSON.stringify({
      type: "set_class", pattern_name: "metrics", pattern_class: "dataset",
    })));
    expect(proposed.error).toBeUndefined();
    await store.applyChange(proposed.change_id);
    expect(JSON.parse(await store.getSchema("metrics")).pattern_class).toBe("dataset");
  });
});

// === Strict validation (dataset only) ===

describe("dataset write validation", () => {
  it("rejects a non-numeric value for a number facet", async () => {
    const store = getStore();
    await createPattern(store, "readings", [{ name: "value", type: "number" }], "dataset");
    const r = await create(store, "readings", { value: "banana" });
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/number/);
  });

  it("coerces a numeric string to a number", async () => {
    const store = getStore();
    await createPattern(store, "readings", [{ name: "value", type: "number" }], "dataset");
    const r = await create(store, "readings", { value: "5" });
    expect(r.error).toBeUndefined();
    expect(r.entry.value).toBe(5);
  });

  it("rejects a non-integer for an integer facet", async () => {
    const store = getStore();
    await createPattern(store, "counts", [{ name: "n", type: "integer" }], "dataset");
    expect((await create(store, "counts", { n: 2.5 })).error).toBe(true);
    expect((await create(store, "counts", { n: 3 })).entry.n).toBe(3);
  });

  it("coerces booleans to 0/1", async () => {
    const store = getStore();
    await createPattern(store, "flags", [{ name: "on", type: "boolean" }], "dataset");
    expect((await create(store, "flags", { on: true })).entry.on).toBe(1);
    expect((await create(store, "flags", { on: "false" })).entry.on).toBe(0);
  });

  it("rejects an unparseable datetime", async () => {
    const store = getStore();
    await createPattern(store, "events", [{ name: "at", type: "datetime" }], "dataset");
    expect((await create(store, "events", { at: "not a date" })).error).toBe(true);
    expect((await create(store, "events", { at: "2026-01-15" })).error).toBeUndefined();
  });

  it("enforces required facets on create", async () => {
    const store = getStore();
    await createPattern(store, "expenses", [
      { name: "amount", type: "number", required: true },
      { name: "category", type: "text" },
    ], "dataset");
    const missing = await create(store, "expenses", { category: "food" });
    expect(missing.error).toBe(true);
    expect(missing.message).toMatch(/required/);
    expect((await create(store, "expenses", { amount: 9.5, category: "food" })).error).toBeUndefined();
  });

  it("leaves knowledge patterns permissive", async () => {
    const store = getStore();
    await createPattern(store, "loose", [{ name: "value", type: "number" }]); // knowledge
    const r = await create(store, "loose", { value: "banana" });
    expect(r.error).toBeUndefined();
    expect(r.entry.value).toBe("banana");
  });
});

// === Aggregation ===

describe("query aggregation", () => {
  async function seedExpenses(store: DurableObjectStub<HiveDO>) {
    await createPattern(store, "expenses", [
      { name: "amount", type: "number", required: true },
      { name: "category", type: "text" },
      { name: "spent_at", type: "datetime" },
    ], "dataset");
    const rows = [
      { amount: 10, category: "food", spent_at: "2026-01-15" },
      { amount: 20, category: "food", spent_at: "2026-01-20" },
      { amount: 5, category: "transit", spent_at: "2026-02-03" },
    ];
    for (const row of rows) {
      const r = await create(store, "expenses", row);
      if (r.error) throw new Error(r.message);
    }
  }

  it("groups and sums", async () => {
    const store = getStore();
    await seedExpenses(store);
    const r = JSON.parse(await store.query(
      "expenses", "", "", "-total", 100, false,
      "category", JSON.stringify([{ fn: "sum", facet: "amount", as: "total" }]),
    ));
    expect(r.aggregate).toBe(true);
    expect(r.group_by).toEqual(["category"]);
    const byCat = Object.fromEntries(r.rows.map((x: any) => [x.category, x.total]));
    expect(byCat).toEqual({ food: 30, transit: 5 });
  });

  it("computes a whole-set aggregate with no group_by", async () => {
    const store = getStore();
    await seedExpenses(store);
    const r = JSON.parse(await store.query(
      "expenses", "", "", "", 100, false, "",
      JSON.stringify([{ fn: "count" }, { fn: "avg", facet: "amount", as: "mean" }]),
    ));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].count).toBe(3);
    expect(Math.round(r.rows[0].mean * 100) / 100).toBeCloseTo(11.67, 1);
  });

  it("buckets a datetime facet by month", async () => {
    const store = getStore();
    await seedExpenses(store);
    const r = JSON.parse(await store.query(
      "expenses", "", "", "spent_at", 100, false, "spent_at:month", "",
    ));
    const byMonth = Object.fromEntries(r.rows.map((x: any) => [x.spent_at, x.count]));
    expect(byMonth).toEqual({ "2026-01": 2, "2026-02": 1 });
  });

  it("respects filters before aggregating", async () => {
    const store = getStore();
    await seedExpenses(store);
    const r = JSON.parse(await store.query(
      "expenses", JSON.stringify(["category=food"]), "", "", 100, false,
      "", JSON.stringify([{ fn: "sum", facet: "amount", as: "total" }]),
    ));
    expect(r.rows[0].total).toBe(30);
  });

  it("rejects an unknown aggregate function", async () => {
    const store = getStore();
    await seedExpenses(store);
    const r = JSON.parse(await store.query(
      "expenses", "", "", "", 100, false, "", JSON.stringify([{ fn: "median", facet: "amount" }]),
    ));
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/Unknown aggregate function/);
  });

  it("rejects grouping by an unknown facet", async () => {
    const store = getStore();
    await seedExpenses(store);
    const r = JSON.parse(await store.query("expenses", "", "", "", 100, false, "nope", ""));
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/unknown facet/);
  });
});
