// Totality oracle: the facet-name reservation partitions the kernel columns.
//
// The kernel columns (id/version/created_at/updated_at/archived_at/created_by/
// updated_by) split into two declared sets: FACET_RESERVED_COLUMNS (a same-named
// facet would collide with the auto-added column → forbidden) and
// USER_OVERRIDABLE_KERNEL_COLUMNS (currently just `version`, which create_pattern
// lets a user redefine). The guard lives at the propose_change chokepoint —
// evolution.ts `validateFacets`, reached by BOTH create_pattern and add_facet.
//
// This iterates BOTH halves derived from the canonical KERNEL_COLUMNS: every
// reserved column is rejected, every overridable column is allowed, and the two
// sets partition KERNEL_COLUMNS exactly. Re-narrow the reservation, mis-declare a
// column overridable, or add a kernel column to neither set, and this fails. It
// locks the historical bug (created_by/updated_by were nameable) AND the regression
// where `version` was over-reserved, breaking the user-version-field feature.
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";
import { KERNEL_COLUMNS, FACET_RESERVED_COLUMNS, USER_OVERRIDABLE_KERNEL_COLUMNS } from "../../entities/Hive/kernel-columns";

function getStore(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName(`evo:${Math.random()}`);
  return env.MNEMION_HIVE.get(id);
}

describe("facet-kernel-collision totality", () => {
  it("reserved ∪ overridable partition the kernel columns exactly", () => {
    // structural totality: no kernel column falls through, none is in both sets.
    for (const col of KERNEL_COLUMNS) {
      const reserved = FACET_RESERVED_COLUMNS.has(col);
      const overridable = USER_OVERRIDABLE_KERNEL_COLUMNS.has(col);
      expect(reserved !== overridable, `kernel column "${col}" must be in exactly one of reserved/overridable`).toBe(true);
    }
    expect(FACET_RESERVED_COLUMNS.size + USER_OVERRIDABLE_KERNEL_COLUMNS.size).toBe(KERNEL_COLUMNS.length);
  });

  it("create_pattern rejects a facet named after ANY reserved kernel column", async () => {
    const store = getStore();
    for (const col of FACET_RESERVED_COLUMNS) {
      const r = JSON.parse(await store.proposeChange(`bad ${col}`, JSON.stringify({
        type: "create_pattern",
        pattern_name: `p_${col}`,
        pattern_description: "x",
        doctrine: "d",
        facets: [{ name: col, type: "text" }],
      })));
      expect(r.error, `facet "${col}" must be rejected on create_pattern`).toBe(true);
      expect(r.message).toMatch(/kernel-provided column/);
    }
  });

  it("add_facet rejects a facet named after ANY reserved kernel column", async () => {
    const store = getStore();
    const base = JSON.parse(await store.proposeChange("base", JSON.stringify({
      type: "create_pattern", pattern_name: "base", pattern_description: "x", doctrine: "d",
      facets: [{ name: "body", type: "text" }],
    })));
    await store.applyChange(base.change_id);
    for (const col of FACET_RESERVED_COLUMNS) {
      const r = JSON.parse(await store.proposeChange(`add ${col}`, JSON.stringify({
        type: "add_facet", pattern_name: "base", facets: [{ name: col, type: "text" }],
      })));
      expect(r.error, `facet "${col}" must be rejected on add_facet`).toBe(true);
      expect(r.message).toMatch(/kernel-provided column/);
    }
  });

  it("every user-overridable kernel column IS allowed as a facet", async () => {
    const store = getStore();
    for (const col of USER_OVERRIDABLE_KERNEL_COLUMNS) {
      const r = JSON.parse(await store.proposeChange(`override ${col}`, JSON.stringify({
        type: "create_pattern", pattern_name: `ov_${col}`, pattern_description: "x", doctrine: "d",
        facets: [{ name: col, type: "text" }],
      })));
      expect(r.error, `overridable column "${col}" must be allowed as a facet`).toBeFalsy();
    }
  });

  it("a non-kernel facet name is still accepted (positive control)", async () => {
    const store = getStore();
    const r = JSON.parse(await store.proposeChange("ok", JSON.stringify({
      type: "create_pattern", pattern_name: "okpat", pattern_description: "x", doctrine: "d",
      facets: [{ name: "title", type: "text" }],
    })));
    expect(r.error).toBeFalsy();
  });
});

// A required facet added to an EXISTING pattern needs a default_value: SQLite
// rejects `ALTER TABLE ADD COLUMN <c> NOT NULL` with no default, so without this
// guard propose_change would succeed and apply_change would always throw — the
// change would be permanently un-appliable. The check lives in the add_facet
// validate path ONLY (create_pattern's CREATE TABLE allows NOT NULL w/o default).
describe("add_facet required-without-default guard", () => {
  async function makeBase(store: DurableObjectStub<HiveDO>) {
    const base = JSON.parse(await store.proposeChange("base", JSON.stringify({
      type: "create_pattern", pattern_name: "rbase", pattern_description: "x", doctrine: "d",
      facets: [{ name: "body", type: "text" }],
    })));
    await store.applyChange(base.change_id);
  }

  it("rejects add_facet {required:true} with no default_value at propose time", async () => {
    const store = getStore();
    await makeBase(store);
    const r = JSON.parse(await store.proposeChange("add req", JSON.stringify({
      type: "add_facet", pattern_name: "rbase",
      facets: [{ name: "priority", type: "text", required: true }],
    })));
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/default_value/);
  });

  it("accepts a required facet that supplies a default_value (and applies cleanly)", async () => {
    const store = getStore();
    await makeBase(store);
    const proposed = JSON.parse(await store.proposeChange("add req+default", JSON.stringify({
      type: "add_facet", pattern_name: "rbase",
      facets: [{ name: "priority", type: "text", required: true, default_value: "normal" }],
    })));
    expect(proposed.error).toBeFalsy();
    const applied = JSON.parse(await store.applyChange(proposed.change_id));
    expect(applied.error).toBeFalsy();
  });

  it("still accepts an optional facet with no default_value", async () => {
    const store = getStore();
    await makeBase(store);
    const r = JSON.parse(await store.proposeChange("add opt", JSON.stringify({
      type: "add_facet", pattern_name: "rbase",
      facets: [{ name: "note", type: "text" }],
    })));
    expect(r.error).toBeFalsy();
  });
});
