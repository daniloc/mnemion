// Alignment view (shared/core/alignment-view.ts): the weekly review's
// "unaligned" read — projects serving no goal, goals nothing serves — derived
// from `serves` links (project-docs/relations.md, decision 2, question 5).
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";
import { alignmentRelation, alignmentView } from "../../shared/core/alignment-view";

type Store = DurableObjectStub<HiveDO>;

const getStore = (): Store => env.MNEMION_HIVE.get(env.MNEMION_HIVE.idFromName(`alignment:${crypto.randomUUID()}`));

const json = async (p: Promise<string>) => JSON.parse(await p);

async function createPattern(store: Store, name: string) {
  const p = await json(store.proposeChange(`Create ${name}`, JSON.stringify({
    type: "create_pattern", pattern_name: name, pattern_description: `Test pattern ${name}`,
    doctrine: `Test doctrine for ${name}`, pattern_class: "dataset", facets: [{ name: "title", type: "text" }],
  })));
  if (p.error) throw new Error(p.message);
  const a = await json(store.applyChange(p.change_id));
  if (a.error) throw new Error(a.message);
}

const mut = (store: Store, pattern: string, op: string, data: Record<string, unknown>) =>
  json(store.mutate(pattern, op, JSON.stringify(data)));

async function entry(store: Store, pattern: string, title: string): Promise<number> {
  const r = await mut(store, pattern, "create", { title });
  if (r.error) throw new Error(r.message);
  return r.entry.id as number;
}

const SERVES = {
  type: "declare_relation", name: "serves", inverse: "served-by", source: ["projects"], target: ["goals"],
  cardinality: "many", behaviors: [],
  description: "The source initiative advances the target goal: doing the source moves the goal forward. A project may serve several goals. Example: projects/1 serves goals/1.",
};

const REL = (over: Record<string, unknown>) => ({
  name: "serves", inverse: "served-by", source: ["projects"], target: ["goals"], cardinality: "many", derived: false, ...over,
});
const link = (s: number, t: number, label = "serves") =>
  ({ source_pattern: "projects", source_id: s, target_pattern: "goals", target_id: t, label });
const P = (id: number) => ({ pattern: "projects", id });
const G = (id: number) => ({ pattern: "goals", id });

describe("alignment view", () => {
  it("finds the stored serves relation with explicit ends, else null", () => {
    expect(alignmentRelation([REL({})])?.name).toBe("serves");
    expect(alignmentRelation([REL({ name: "references" })])).toBeNull();
    expect(alignmentRelation([REL({ derived: true })])).toBeNull();
    expect(alignmentRelation([REL({ source: ["*"] })])).toBeNull();
    expect(alignmentRelation([REL({ target: [] })])).toBeNull();
    expect(alignmentRelation([])).toBeNull();
    expect(alignmentRelation(undefined)).toBeNull();
  });

  it("lists sources with no link and targets nothing links to, ignoring other labels and inactive ends", () => {
    const view = alignmentView(REL({}), [P(1), P(2), P(3)], [G(10), G(11), G(12)], [
      link(1, 10),
      link(1, 11),
      link(2, 12, "references"), // another relation doesn't align anything
      link(9, 12),               // source not active (archived project): goal 12 stays unserved
      link(3, 99),               // target not active: project 3 stays unaligned
    ]);
    expect(view).toEqual({
      relation: "serves", sources: ["projects"], targets: ["goals"],
      unaligned: [P(2), P(3)], unserved: [G(12)],
    });
    expect(alignmentView(REL({}), [], [], [])).toEqual({ relation: "serves", sources: ["projects"], targets: ["goals"], unaligned: [], unserved: [] });
  });

  it("reads the hive's real query output", async () => {
    const store = getStore();
    await createPattern(store, "projects");
    await createPattern(store, "goals");
    const p = await json(store.proposeChange("declare serves", JSON.stringify(SERVES)));
    expect((await json(store.applyChange(p.change_id))).error).toBeUndefined();
    const aligned = await entry(store, "projects", "aligned");
    const catchAll = await entry(store, "projects", "catch-all");
    const gone = await entry(store, "projects", "archived");
    const fed = await entry(store, "goals", "fed");
    const orphan = await entry(store, "goals", "fed only by an archived project");
    expect((await mut(store, "link", "create", { source: `projects/${aligned}`, target: `goals/${fed}`, label: "serves" })).error).toBeUndefined();
    expect((await mut(store, "link", "create", { source: `projects/${gone}`, target: `goals/${orphan}`, label: "serves" })).error).toBeUndefined();
    expect((await mut(store, "projects", "archive", { id: gone })).error).toBeUndefined();

    const relation = alignmentRelation((await json(store.resolve("mnemion://relations"))).relations)!;
    expect(relation).not.toBeNull();
    const ids = async (pattern: string) =>
      (await json(store.query(pattern, "", "id", "id", 1000, false))).entries.map((e: { id: number }) => ({ pattern, id: e.id }));
    const links = (await json(store.query("_links", JSON.stringify(["label=serves"]), "", "", 1000, false))).entries;
    const view = alignmentView(relation, await ids("projects"), await ids("goals"), links);
    expect(view.unaligned).toEqual([P(catchAll)]);
    expect(view.unserved).toEqual([G(orphan)]);
  });
});
