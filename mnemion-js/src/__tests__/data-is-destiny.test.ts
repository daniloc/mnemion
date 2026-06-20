// data-is-destiny — the decidable "no-hybrid" core, as a live-schema totality.
//
// The doctrine ("store truth once, derive its consequences") is semantic in
// general, but has a DECIDABLE slice: a pattern must not STORE an aggregate of
// rows it also RETAINS. `findStoredDerivedAggregates` checks it over the live
// `_fields` schema. This oracle asserts the real composed schema carries no such
// hybrid (a build ratchet — a feature that adds one fails here), plus a fixture
// proving the detector FIRES on the hybrid and stays SILENT on the legitimate
// bare-counter fork the convergence experiment surfaced (a counter with no
// retained instances is the stored truth, not a denormalization).
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";
import { findStoredDerivedAggregates } from "../../entities/Hive/schema";

function getStore(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName(`did:${Math.random()}`);
  return env.MNEMION_HIVE.get(id);
}

async function createPattern(store: DurableObjectStub<HiveDO>, name: string, facets: any[]) {
  const p = JSON.parse(await store.proposeChange(`Create ${name}`, JSON.stringify({
    type: "create_pattern", pattern_name: name, pattern_description: `Test ${name}`, doctrine: "d", facets,
  })));
  if (p.error) throw new Error(p.message);
  const a = JSON.parse(await store.applyChange(p.change_id));
  if (a.error) throw new Error(a.message);
}

describe("data-is-destiny no-hybrid totality", () => {
  it("the live composed schema stores no aggregate of rows it retains", async () => {
    const store = getStore();
    await store.getIndex(); // instantiate the DO → boot → schema seed
    const violations = await runInDurableObject(store, (_i, state) =>
      findStoredDerivedAggregates(state.storage.sql),
    );
    // iterate the live result (the totality domain) — fail naming any survivor.
    for (const v of violations) expect(v, v).toBeUndefined();
    expect(violations).toEqual([]);
  });

  it("fires on a stored aggregate beside retained rows; silent on a bare counter", async () => {
    const store = getStore();
    // HYBRID: `lists.item_count` stored, while `items` rows reference `lists` —
    // the source rows are retained, so the count is derivable → a denormalization.
    await createPattern(store, "lists", [{ name: "title", type: "text" }, { name: "item_count", type: "number" }]);
    await createPattern(store, "items", [{ name: "list", type: "number", links: { pattern: "lists" } }]);
    // LEGITIMATE fork: a bare counter, no retained instances — the stored truth.
    await createPattern(store, "likes", [{ name: "like_count", type: "number" }]);
    const violations = await runInDurableObject(store, (_i, state) =>
      findStoredDerivedAggregates(state.storage.sql),
    );
    expect(violations.some((v) => v.includes(`"lists".item_count`)), "hybrid must be flagged").toBe(true);
    expect(violations.some((v) => v.includes("likes")), "bare counter must be silent").toBe(false);
  });
});
