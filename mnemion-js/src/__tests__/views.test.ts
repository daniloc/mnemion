import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";
import {
  validateViewSpec,
  VIEW_TYPES,
  VIEW_PALETTE,
  DEFAULT_VIEW_TYPE,
  isViewType,
} from "../../shared/core/view-palette";
import { KERNEL_TABLES } from "../../entities/Hive/schema";

function getStore(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName(`user:test:${crypto.randomUUID()}`);
  return env.MNEMION_HIVE.get(id);
}

async function createPattern(store: DurableObjectStub<HiveDO>, name: string, facets: { name: string; type: string }[]) {
  const r = await store.proposeChange(`Create ${name}`, JSON.stringify({
    type: "create_pattern", pattern_name: name, pattern_description: `t ${name}`, doctrine: `d ${name}`, facets,
  }));
  const p = JSON.parse(r);
  if (p.error) throw new Error(p.message);
  const a = JSON.parse(await store.applyChange(p.change_id));
  if (a.error) throw new Error(a.message);
}

const view = (store: DurableObjectStub<HiveDO>, data: Record<string, unknown>, op = "create") =>
  store.mutate("_views", op, JSON.stringify(data)).then(JSON.parse);

// === Pure validator (the SSOT's enforcement logic) ===

describe("validateViewSpec", () => {
  const facets = new Set(["title", "status", "body"]);
  const has = (n: string) => facets.has(n);

  it("accepts a valid board spec", () => {
    expect(validateViewSpec("board", JSON.stringify({ group_by: "status", title: "title" }), has, { enforceRequired: true })).toEqual([]);
  });

  it("rejects an unknown view_type", () => {
    const errs = validateViewSpec("grid", null, has);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("not a valid view");
  });

  it("rejects a config key the view does not use", () => {
    const errs = validateViewSpec("list", JSON.stringify({ group_by: "status" }), has);
    expect(errs.join()).toContain('"group_by" is not used by the list view');
  });

  it("rejects a facet role referencing a missing facet", () => {
    const errs = validateViewSpec("table", JSON.stringify({ columns: ["title", "ghost"] }), has);
    expect(errs.join()).toContain('facet "ghost"');
  });

  it("enforces required keys only on create", () => {
    expect(validateViewSpec("board", null, has, { enforceRequired: true }).join()).toContain("group_by is required");
    expect(validateViewSpec("board", null, has, { enforceRequired: false })).toEqual([]);
  });

  it("rejects malformed JSON config", () => {
    expect(validateViewSpec("table", "{nope", has).join()).toContain("valid JSON");
  });

  it("rejects a non-object config", () => {
    expect(validateViewSpec("table", "[1,2]", has).join()).toContain("must be a JSON object");
  });

  it("skips facet-existence when the pattern is unknown (null predicate)", () => {
    expect(validateViewSpec("table", JSON.stringify({ columns: ["anything"] }), null)).toEqual([]);
  });
});

// === Totality: the palette is the single source the schema enum derives from ===

describe("view palette totality", () => {
  it("the _views view_type enum equals the palette keys", () => {
    const viewsTable = KERNEL_TABLES.find((t: { name: string }) => t.name === "_views")!;
    const vtFacet = viewsTable.facets.find((f: { name: string }) => f.name === "view_type")!;
    expect([...(vtFacet.options as string[])].sort()).toEqual([...VIEW_TYPES].sort());
  });

  it("the column default is a real view type", () => {
    expect(isViewType(DEFAULT_VIEW_TYPE)).toBe(true);
  });

  it("every view type declares config help", () => {
    for (const id of VIEW_TYPES) {
      expect(VIEW_PALETTE[id].help.length).toBeGreaterThan(0);
    }
  });
});

// === Kernel enforcement at the mutate chokepoint (fail-closed) ===

describe("_views kernel validation", () => {
  it("accepts a valid view and rejects the failure modes", async () => {
    const store = getStore();
    await createPattern(store, "widgets", [
      { name: "title", type: "text" },
      { name: "stage", type: "text" },
    ]);

    expect((await view(store, { pattern: "widgets", name: "default", view_type: "board", config: JSON.stringify({ group_by: "stage", title: "title" }) })).error).toBeFalsy();

    expect((await view(store, { pattern: "widgets", name: "a", view_type: "grid" })).message).toContain("not a valid view");
    expect((await view(store, { pattern: "widgets", name: "b", view_type: "table", config: JSON.stringify({ columns: ["title", "ghost"] }) })).message).toContain('facet "ghost"');
    expect((await view(store, { pattern: "widgets", name: "c", view_type: "board" })).message).toContain("group_by is required");
    expect((await view(store, { pattern: "widgets", name: "d", view_type: "table", config: "{bad" })).message).toContain("valid JSON");
    expect((await view(store, { pattern: "ghosts", name: "e", view_type: "table" })).message).toContain("does not exist");
  });

  it("validates facet references on a partial (config-only) update", async () => {
    const store = getStore();
    await createPattern(store, "gadgets", [
      { name: "title", type: "text" },
      { name: "body", type: "text" },
    ]);
    const created = await view(store, { pattern: "gadgets", name: "default", view_type: "table", config: JSON.stringify({ columns: ["title"] }) });
    expect(created.error).toBeFalsy();
    const id = created.entry.id;

    // config-only update carrying no pattern/view_type — must still resolve them
    // from the row and reject a bad facet.
    expect((await view(store, { id, config: JSON.stringify({ columns: ["title", "nope"] }) }, "update")).message).toContain('facet "nope"');
    expect((await view(store, { id, config: JSON.stringify({ columns: ["body", "title"] }) }, "update")).error).toBeFalsy();
  });
});
