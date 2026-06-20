// Totality oracle: a facet can NEVER be named after a kernel column.
//
// Kernel columns (id/version/created_at/updated_at/archived_at/created_by/
// updated_by) are auto-added to every pattern table, so a facet sharing one of
// those names would collide with / shadow the auto-provided column. The guard
// lives at the propose_change chokepoint — evolution.ts `validateFacets`, reached
// by BOTH create_pattern and add_facet — and reserves the FULL `KERNEL_COLUMN_SET`.
//
// This iterates the canonical KERNEL_COLUMNS list, so "every kernel column is
// un-nameable as a facet" is checked exhaustively: add a kernel column, or
// re-narrow the reservation to a subset, and this fails. It locks the historical
// bug where version/created_by/updated_by were NOT reserved and so were nameable.
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";
import { KERNEL_COLUMNS } from "../../entities/Hive/kernel-columns";

function getStore(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName(`evo:${Math.random()}`);
  return env.MNEMION_HIVE.get(id);
}

describe("facet-kernel-collision totality", () => {
  it("create_pattern rejects a facet named after ANY kernel column", async () => {
    const store = getStore();
    for (const col of KERNEL_COLUMNS) {
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

  it("add_facet rejects a facet named after ANY kernel column", async () => {
    const store = getStore();
    const base = JSON.parse(await store.proposeChange("base", JSON.stringify({
      type: "create_pattern", pattern_name: "base", pattern_description: "x", doctrine: "d",
      facets: [{ name: "body", type: "text" }],
    })));
    await store.applyChange(base.change_id);
    for (const col of KERNEL_COLUMNS) {
      const r = JSON.parse(await store.proposeChange(`add ${col}`, JSON.stringify({
        type: "add_facet", pattern_name: "base", facets: [{ name: col, type: "text" }],
      })));
      expect(r.error, `facet "${col}" must be rejected on add_facet`).toBe(true);
      expect(r.message).toMatch(/kernel-provided column/);
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
