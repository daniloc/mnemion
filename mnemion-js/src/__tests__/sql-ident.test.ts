// Tests for the enshrined SQL-identifier chokepoint (shared/core/sql.ts) and a
// behavioral check that routing the data engine through it left query/filter/sort
// working end-to-end.
//
// quoteIdent is the single transition map raw-string → SQL-identifier: it fuses
// validation (IDENTIFIER_RE) with quoting, so a raw unvalidated identifier — or an
// injection-bearing one — physically can't reach SQL. The unit tests pin the
// grammar + throw behavior; the DO test proves the fused chokepoint doesn't break
// a normal query.

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";
import { quoteIdent } from "../../shared/core/sql";

describe("quoteIdent — grammar", () => {
  it("returns a double-quoted identifier for valid names", () => {
    expect(quoteIdent("col")).toBe('"col"');
    expect(quoteIdent("tasks")).toBe('"tasks"');
    expect(quoteIdent("_members")).toBe('"_members"'); // leading underscore (kernel table)
    expect(quoteIdent("due-date")).toBe('"due-date"'); // hyphen is allowed
    expect(quoteIdent("a1")).toBe('"a1"');             // digit after a letter
    // Hyphens are part of the grammar, so `a--b` is a legitimate identifier — and
    // double-quoting it (`"a--b"`) renders the `--` inert as a SQL comment anyway.
    expect(quoteIdent("a--b")).toBe('"a--b"');
  });

  it("accepts the snake_case kernel columns", () => {
    for (const col of ["id", "version", "created_at", "updated_at", "archived_at", "created_by", "updated_by"]) {
      expect(quoteIdent(col)).toBe(`"${col}"`);
    }
  });

  it("THROWS on injection attempts and malformed identifiers", () => {
    const bad = [
      'x"; DROP TABLE y --', // quote-break + statement injection
      'x")',                 // quote-break
      "a b",                 // space
      "1col",                // leading digit
      "",                    // empty
      "UPPER",               // uppercase (grammar is lowercase-only)
      "a;b",                 // semicolon
      "a'b",                 // single quote
    ];
    for (const name of bad) {
      expect(() => quoteIdent(name), name).toThrow(/Invalid SQL identifier/);
    }
  });

  it("THROWS on a non-string", () => {
    expect(() => quoteIdent(undefined as any)).toThrow(/Invalid SQL identifier/);
    expect(() => quoteIdent(null as any)).toThrow(/Invalid SQL identifier/);
  });
});

// === Behavioral: the data engine still works through the chokepoint ===

function getStore(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName(`user:test:${crypto.randomUUID()}`);
  return env.MNEMION_HIVE.get(id);
}

async function createPattern(
  store: DurableObjectStub<HiveDO>,
  name: string,
  facets: { name: string; type: string; required?: boolean }[],
) {
  const proposed = JSON.parse(await store.proposeChange(`Create ${name}`, JSON.stringify({
    type: "create_pattern",
    pattern_name: name,
    pattern_description: `Test ${name}`,
    doctrine: `Doctrine for ${name}`,
    facets,
  })));
  if (proposed.error) throw new Error(proposed.message);
  const applied = JSON.parse(await store.applyChange(proposed.change_id));
  if (applied.error) throw new Error(applied.message);
  return applied;
}

const create = (store: DurableObjectStub<HiveDO>, pattern: string, data: Record<string, unknown>) =>
  store.mutate(pattern, "create", JSON.stringify(data)).then(JSON.parse);

describe("data engine end-to-end through quoteIdent", () => {
  it("create → filtered, sorted query returns rows", async () => {
    const store = getStore();
    await createPattern(store, "facts", [
      { name: "label", type: "text" },
      { name: "rank", type: "number" },
    ]);
    await create(store, "facts", { label: "gamma", rank: 3 });
    await create(store, "facts", { label: "alpha", rank: 1 });
    await create(store, "facts", { label: "beta", rank: 2 });

    // filter (rank > 1) + sort (-rank, descending), projected facets — every one
    // of these interpolates an identifier through quoteIdent now.
    const res = JSON.parse(await store.query(
      "facts",
      JSON.stringify(["rank>1"]),
      "label,rank",
      "-rank",
      100,
      false,
    ));
    expect(res.error).toBeUndefined();
    expect(res.entries.map((e: any) => e.label)).toEqual(["gamma", "beta"]);
    expect(res.entries[0].rank).toBe(3);
  });

  it("search across text facets returns rows", async () => {
    const store = getStore();
    await createPattern(store, "notes_s", [{ name: "body", type: "text" }]);
    await create(store, "notes_s", { body: "the quick brown fox" });
    await create(store, "notes_s", { body: "lazy dog" });

    const res = JSON.parse(await store.search("brown", JSON.stringify(["notes_s"]), 20));
    expect(res.count).toBe(1);
    expect(res.results[0].entry.body).toContain("brown");
  });
});
