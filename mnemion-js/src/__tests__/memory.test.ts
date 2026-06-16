// Contradiction management & decay: supersession links, memory policy,
// decay weighting, stale view, maintenance passes.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../hive";
import { decayMultiplier } from "../prime";

function getStore(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName(`user:test:${crypto.randomUUID()}`);
  return env.MNEMION_HIVE.get(id);
}

async function createPattern(
  store: DurableObjectStub<HiveDO>,
  name: string,
  facets: { name: string; type: string; required?: boolean }[],
) {
  const result = await store.proposeChange(
    `Create ${name}`,
    JSON.stringify({
      type: "create_pattern",
      pattern_name: name,
      pattern_description: `Test pattern: ${name}`,
      doctrine: `Test doctrine for ${name}`,
      facets,
    })
  );
  const parsed = JSON.parse(result);
  if (parsed.error) throw new Error(parsed.message);
  return JSON.parse(await store.applyChange(parsed.change_id));
}

async function createEntry(store: DurableObjectStub<HiveDO>, pattern: string, data: Record<string, unknown>) {
  return JSON.parse(await store.mutate(pattern, "create", JSON.stringify(data)));
}

async function setPolicy(store: DurableObjectStub<HiveDO>, pattern: string, policy: unknown) {
  const result = await store.proposeChange(
    `Set memory policy on ${pattern}`,
    JSON.stringify({ type: "set_memory_policy", pattern_name: pattern, policy })
  );
  const parsed = JSON.parse(result);
  if (parsed.error) throw new Error(parsed.message);
  return JSON.parse(await store.applyChange(parsed.change_id));
}

/** Backdate a row's timestamp via direct SQL (kernel columns aren't writable through mutate). */
async function backdate(store: DurableObjectStub<HiveDO>, table: string, id: number, column: string, days: number) {
  await runInDurableObject(store, async (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE "${table}" SET "${column}" = datetime('now', '-${days} days') WHERE id = ?`, id
    );
  });
}

// === Decay math (pure) ===

describe("decayMultiplier", () => {
  it("returns 1 with no half-life", () => {
    expect(decayMultiplier(100, null)).toBe(1);
    expect(decayMultiplier(100, 0)).toBe(1);
  });

  it("returns 1 for fresh entries", () => {
    expect(decayMultiplier(0, 30)).toBe(1);
    expect(decayMultiplier(-5, 30)).toBe(1);
  });

  it("halves per half-life", () => {
    expect(decayMultiplier(30, 30)).toBeCloseTo(0.5);
    expect(decayMultiplier(60, 30)).toBeCloseTo(0.25);
  });

  it("floors at 0.05 so old-but-relevant can still surface", () => {
    expect(decayMultiplier(3000, 30)).toBe(0.05);
  });
});

// === Memory policy via schema evolution ===

describe("set_memory_policy", () => {
  it("sets, surfaces in index, and clears", async () => {
    const store = getStore();
    await createPattern(store, "decisions", [{ name: "topic", type: "text", required: true }]);

    await setPolicy(store, "decisions", { half_life_days: 30, conflict_check: "annotate", exclusive_facets: ["topic"] });
    let index = JSON.parse(await store.getIndex());
    let pat = index.patterns.find((p: any) => p.name === "decisions");
    expect(pat.memory_policy).toEqual({ half_life_days: 30, conflict_check: "annotate", exclusive_facets: ["topic"] });

    await setPolicy(store, "decisions", null);
    index = JSON.parse(await store.getIndex());
    pat = index.patterns.find((p: any) => p.name === "decisions");
    expect(pat.memory_policy).toBeUndefined();
  });

  it("rejects invalid policies", async () => {
    const store = getStore();
    await createPattern(store, "notes", [{ name: "body", type: "text", required: true }]);

    const bad = async (policy: unknown) => {
      const r = JSON.parse(await store.proposeChange("bad", JSON.stringify({ type: "set_memory_policy", pattern_name: "notes", policy })));
      expect(r.error).toBe(true);
      return r.message;
    };

    expect(await bad({ half_life_days: -3 })).toMatch(/positive number/);
    expect(await bad({ conflict_check: "block" })).toMatch(/annotate.*off/);
    expect(await bad({ exclusive_facets: ["nope"] })).toMatch(/does not exist/);
    expect(await bad({ bogus_field: 1 })).toMatch(/Unknown policy field/);

    // Kernel patterns can't carry policy
    const r = JSON.parse(await store.proposeChange("bad", JSON.stringify({ type: "set_memory_policy", pattern_name: "_links", policy: { half_life_days: 5 } })));
    expect(r.error).toBe(true);
  });

  it("records the change in schema history", async () => {
    const store = getStore();
    await createPattern(store, "journal", [{ name: "body", type: "text", required: true }]);
    await setPolicy(store, "journal", { half_life_days: 14 });
    const history = JSON.parse(await store.getHistory(5));
    expect(history.history.some((h: any) => h.change_type === "set_memory_policy")).toBe(true);
  });
});

// === Exclusive facet advisories ===

describe("exclusive facets", () => {
  it("surfaces possible_overlap on duplicate value, advisory only", async () => {
    const store = getStore();
    await createPattern(store, "decisions", [{ name: "topic", type: "text", required: true }, { name: "body", type: "text" }]);
    await setPolicy(store, "decisions", { exclusive_facets: ["topic"] });

    const first = await createEntry(store, "decisions", { topic: "database", body: "We use PostgreSQL" });
    expect(first.error).toBeUndefined();
    expect(first.possible_overlap).toBeUndefined();

    const second = await createEntry(store, "decisions", { topic: "database", body: "We switched to MySQL" });
    expect(second.error).toBeUndefined(); // never blocks
    expect(second.entry.id).toBeTypeOf("number");
    expect(second.possible_overlap).toHaveLength(1);
    expect(second.possible_overlap[0]).toMatchObject({ pattern: "decisions", id: first.entry.id, reason: "exclusive_facet", facet: "topic" });
    expect(second.overlap_guidance).toMatch(/supersedes/);
  });

  it("stays quiet for distinct values and archived entries", async () => {
    const store = getStore();
    await createPattern(store, "decisions", [{ name: "topic", type: "text", required: true }]);
    await setPolicy(store, "decisions", { exclusive_facets: ["topic"] });

    const first = await createEntry(store, "decisions", { topic: "hosting" });
    const other = await createEntry(store, "decisions", { topic: "auth" });
    expect(other.possible_overlap).toBeUndefined();

    await store.mutate("decisions", "archive", JSON.stringify({ id: first.entry.id }));
    const again = await createEntry(store, "decisions", { topic: "hosting" });
    expect(again.possible_overlap).toBeUndefined();
  });
});

// === Supersession ===

describe("supersession", () => {
  it("annotates superseded entries on read, never hides them", async () => {
    const store = getStore();
    await createPattern(store, "facts", [{ name: "body", type: "text", required: true }]);
    const old = await createEntry(store, "facts", { body: "We use PostgreSQL" });
    const next = await createEntry(store, "facts", { body: "We use MySQL now" });

    const link = JSON.parse(await store.mutate("link", "create", JSON.stringify({
      source: `facts/${next.entry.id}`, target: `facts/${old.entry.id}`, label: "supersedes",
    })));
    expect(link.error).toBeUndefined();

    const oldRead = JSON.parse(await store.getEntry("facts", old.entry.id));
    expect(oldRead.superseded_by).toBe(`mnemion://entry/facts/${next.entry.id}`);
    expect(oldRead.entry.body).toBe("We use PostgreSQL"); // still fully readable

    const nextRead = JSON.parse(await store.getEntry("facts", next.entry.id));
    expect(nextRead.superseded_by).toBeUndefined();

    // resolve() path carries the same annotation
    const resolved = JSON.parse(await store.resolve(`mnemion://entry/facts/${old.entry.id}`));
    expect(resolved.superseded_by).toBe(`mnemion://entry/facts/${next.entry.id}`);
  });

  it("archiving the link removes the annotation", async () => {
    const store = getStore();
    await createPattern(store, "facts", [{ name: "body", type: "text", required: true }]);
    const a = await createEntry(store, "facts", { body: "alpha" });
    const b = await createEntry(store, "facts", { body: "beta" });
    await store.mutate("link", "create", JSON.stringify({ source: `facts/${b.entry.id}`, target: `facts/${a.entry.id}`, label: "supersedes" }));
    await store.mutate("unlink", "unlink", JSON.stringify({ source: `facts/${b.entry.id}`, target: `facts/${a.entry.id}` }));

    const read = JSON.parse(await store.getEntry("facts", a.entry.id));
    expect(read.superseded_by).toBeUndefined();
  });
});

// === Stale view ===

describe("stale view", () => {
  it("lists entries past the horizon, flags superseded, respects ?days", async () => {
    const store = getStore();
    await createPattern(store, "notes", [{ name: "body", type: "text", required: true }]);
    const old = await createEntry(store, "notes", { body: "ancient note" });
    const fresh = await createEntry(store, "notes", { body: "fresh note" });
    await backdate(store, "notes", old.entry.id, "updated_at", 120);

    // Default horizon (90 days, no policy): only the backdated entry
    const stale = JSON.parse(await store.getStaleEntries());
    const ids = stale.stale.map((s: any) => `${s.pattern}/${s.id}`);
    expect(ids).toContain(`notes/${old.entry.id}`);
    expect(ids).not.toContain(`notes/${fresh.entry.id}`);
    expect(stale.stale[0].preview).toMatch(/ancient/);

    // Supersession flag
    await store.mutate("link", "create", JSON.stringify({ source: `notes/${fresh.entry.id}`, target: `notes/${old.entry.id}`, label: "supersedes" }));
    const flagged = JSON.parse(await store.getStaleEntries());
    const item = flagged.stale.find((s: any) => s.id === old.entry.id);
    expect(item.superseded_by).toBe(`mnemion://entry/notes/${fresh.entry.id}`);

    // ?days override through resolve
    const wide = JSON.parse(await store.resolve("mnemion://stale?days=1"));
    expect(wide.stale.length).toBeGreaterThanOrEqual(1);
  });

  it("uses 3x half_life as the horizon when policy is set", async () => {
    const store = getStore();
    await createPattern(store, "journal", [{ name: "body", type: "text", required: true }]);
    await setPolicy(store, "journal", { half_life_days: 10 });
    const e = await createEntry(store, "journal", { body: "a month old" });
    await backdate(store, "journal", e.entry.id, "updated_at", 40); // > 30 = 3 × 10

    const stale = JSON.parse(await store.getStaleEntries());
    expect(stale.stale.some((s: any) => s.pattern === "journal" && s.id === e.entry.id)).toBe(true);
    expect(stale.stale.find((s: any) => s.pattern === "journal").horizon_days).toBe(30);
  });

  it("excludes kernel patterns", async () => {
    const store = getStore();
    const stale = JSON.parse(await store.getStaleEntries(0 as any));
    expect(stale.stale.every((s: any) => !s.pattern.startsWith("_"))).toBe(true);
  });
});

// === Maintenance status ===

describe("maintenance", () => {
  it("fresh hive is not overdue", async () => {
    const store = getStore();
    const status = JSON.parse(await store.getMaintenanceStatus());
    expect(status.last_pass_at).toBeNull();
    expect(status.interval_days).toBe(14);
    expect(status.overdue).toBe(false);
  });

  it("becomes overdue once the hive is older than the interval with no pass", async () => {
    const store = getStore();
    await createPattern(store, "notes", [{ name: "body", type: "text", required: true }]);
    // Backdate the hive's birth (first schema change)
    await runInDurableObject(store, async (_i, state) => {
      state.storage.sql.exec(`UPDATE _schema_history SET created_at = datetime('now', '-30 days')`);
    });
    const status = JSON.parse(await store.getMaintenanceStatus());
    expect(status.overdue).toBe(true);
  });

  it("recording a pass resets the clock; charter overrides the interval", async () => {
    const store = getStore();
    const pass = JSON.parse(await store.mutate("_maintenance_passes", "create", JSON.stringify({ summary: "reviewed stale, superseded 2 entries" })));
    expect(pass.error).toBeUndefined();

    let status = JSON.parse(await store.getMaintenanceStatus());
    expect(status.days_since_last_pass).toBe(0);
    expect(status.overdue).toBe(false);

    await backdate(store, "_maintenance_passes", pass.entry.id, "created_at", 5);
    status = JSON.parse(await store.getMaintenanceStatus());
    expect(status.days_since_last_pass).toBe(5);
    expect(status.overdue).toBe(false); // default interval 14

    await store.mutate("_charter", "create", JSON.stringify({ key: "maintenance_interval_days", value: "3" }));
    status = JSON.parse(await store.getMaintenanceStatus());
    expect(status.interval_days).toBe(3);
    expect(status.overdue).toBe(true);
  });

  it("requires a summary on _maintenance_passes", async () => {
    const store = getStore();
    const r = JSON.parse(await store.mutate("_maintenance_passes", "create", JSON.stringify({})));
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/summary/);
  });

  it("rides the prime response when overdue", async () => {
    const store = getStore();
    const pass = JSON.parse(await store.mutate("_maintenance_passes", "create", JSON.stringify({ summary: "old pass" })));
    await backdate(store, "_maintenance_passes", pass.entry.id, "created_at", 60);

    const primed = JSON.parse(await store.prime("anything relevant", "", 5));
    expect(primed.maintenance).toBeDefined();
    expect(primed.maintenance.last_pass_days_ago).toBe(60);
    expect(primed.maintenance.message).toMatch(/mnemion:\/\/stale/);
  });

  it("stays quiet on prime when current", async () => {
    const store = getStore();
    await store.mutate("_maintenance_passes", "create", JSON.stringify({ summary: "just now" }));
    const primed = JSON.parse(await store.prime("anything relevant", "", 5));
    expect(primed.maintenance).toBeUndefined();
  });
});

// === Internal write protection ===

describe("write protection", () => {
  it("_entry_access_log is system-managed", async () => {
    const store = getStore();
    const r = JSON.parse(await store.mutate("_entry_access_log", "create", JSON.stringify({ pattern: "x", entry_id: 1 })));
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/managed by the system/);
  });
});

// === Conflict check degrades gracefully without AI ===

describe("semantic conflict check", () => {
  it("creates cleanly when AI/Vectorize are unavailable", async () => {
    const store = getStore();
    await createPattern(store, "ideas", [{ name: "body", type: "text", required: true }]);
    const a = await createEntry(store, "ideas", { body: "decentralized memory for agents" });
    const b = await createEntry(store, "ideas", { body: "decentralized memory for agents" });
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    // best-effort path: no advisory without embeddings, but creation never fails
  });
});
