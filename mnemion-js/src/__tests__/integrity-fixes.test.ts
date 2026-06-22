// Regression tests for the project-integrity review fixes (the behavioral ones
// reachable through the HiveDO RPC surface).

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";

function getStore(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName(`integ:${Math.random()}`);
  return env.MNEMION_HIVE.get(id);
}

async function createPattern(
  store: DurableObjectStub<HiveDO>,
  name: string,
  facets: { name: string; type: string; required?: boolean }[],
  pattern_class: "knowledge" | "dataset" = "knowledge",
) {
  const p = JSON.parse(await store.proposeChange(`Create ${name}`, JSON.stringify({
    type: "create_pattern", pattern_name: name, pattern_description: `t ${name}`, doctrine: "d", pattern_class, facets,
  })));
  if (p.error) throw new Error(p.message);
  const a = JSON.parse(await store.applyChange(p.change_id));
  if (a.error) throw new Error(a.message);
}
const mut = (s: DurableObjectStub<HiveDO>, p: string, op: string, d: Record<string, unknown>) =>
  s.mutate(p, op, JSON.stringify(d)).then(JSON.parse);

describe("number/integer facets reject empty/blank instead of coercing to 0", () => {
  it("rejects an empty string for a required number facet (was silently 0)", async () => {
    const store = getStore();
    await createPattern(store, "expenses", [{ name: "amount", type: "number", required: true }], "dataset");
    const bad = await mut(store, "expenses", "create", { amount: "" });
    expect(bad.error).toBe(true);
    // a valid numeric string still coerces
    const ok = await mut(store, "expenses", "create", { amount: "5" });
    expect(ok.error).toBeUndefined();
    expect(ok.entry.amount).toBe(5);
  });
});

describe("hyphenated facets are filterable", () => {
  it("filters on a facet whose name contains a hyphen", async () => {
    const store = getStore();
    await createPattern(store, "events", [{ name: "due-date", type: "text" }]);
    await mut(store, "events", "create", { "due-date": "2026-06-22" });
    await mut(store, "events", "create", { "due-date": "2026-01-01" });
    const r = JSON.parse(await store.query("events", JSON.stringify(["due-date=2026-06-22"]), "", "", 100, false));
    expect(r.error).toBeUndefined();
    expect(r.entries.length).toBe(1);
    expect(r.entries[0]["due-date"]).toBe("2026-06-22");
  });
});

describe("query limit is clamped (a negative limit is not passed through)", () => {
  it("treats a negative limit as the default, not unlimited", async () => {
    const store = getStore();
    await createPattern(store, "notes", [{ name: "body", type: "text" }]);
    for (let i = 0; i < 3; i++) await mut(store, "notes", "create", { body: `n${i}` });
    const r = JSON.parse(await store.query("notes", "", "", "", -1, false));
    expect(r.error).toBeUndefined();
    expect(r.count).toBe(3); // not a negative count / error from LIMIT -1 garbage
  });
});

describe("_links cannot target a kernel pattern", () => {
  it("rejects a link whose target is a kernel pattern", async () => {
    const store = getStore();
    await createPattern(store, "tasks", [{ name: "title", type: "text" }]);
    const t = await mut(store, "tasks", "create", { title: "a" });
    const r = await mut(store, "link", "create", { source: `tasks/${t.entry.id}`, target: "_members/1", label: "x" });
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/kernel pattern/);
  });
});

describe("_members role/status are re-validated on update", () => {
  it("rejects setting role:owner via update (the create-time reservation is not bypassable)", async () => {
    const store = getStore();
    const m = await mut(store, "_members", "create", { label: "partner", display_name: "Partner" });
    expect(m.error).toBeUndefined();
    const bad = await mut(store, "_members", "update", { id: m.entry.id, role: "owner" });
    expect(bad.error).toBe(true);
    expect(bad.message).toMatch(/owner.*reserved|reserved/i);
    const badStatus = await mut(store, "_members", "update", { id: m.entry.id, status: "banana" });
    expect(badStatus.error).toBe(true);
  });
});
