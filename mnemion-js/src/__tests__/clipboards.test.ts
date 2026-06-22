// Clipboards — validated job-dispatch forms. A clipboard binds a deterministically-
// validated form to a target dataset pattern; each create/update on that pattern is a
// SUBMISSION, validated collect-all at the mutate chokepoint and scored against a
// composable numeric completion contract whose progress is DERIVED from the log.
//
// Two layers under test: (1) the TOTALITY oracle — the constraint/metric/op keys the
// engines enforce are a complete, internally-consistent home (a rule that could be
// stored but isn't enforced would be fail-OPEN); (2) the behavior through the HiveDO
// RPC surface the MCP `mutate` tool sits on.

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";
import { CONSTRAINT_RULES, CONSTRAINT_KEYS, COMPARISON_OPS, COMPARISON_OP_KEYS } from "../../entities/Hive/constraints";
import { COMPLETION_METRICS, COMPLETION_METRIC_KEYS } from "../../entities/Hive/completion";

function getStore(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName(`clip:${Math.random()}`);
  return env.MNEMION_HIVE.get(id);
}

async function createPattern(
  store: DurableObjectStub<HiveDO>,
  name: string,
  facets: { name: string; type: string; required?: boolean; options?: string[] }[],
  pattern_class: "knowledge" | "dataset" = "dataset",
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

const defineClipboard = (store: DurableObjectStub<HiveDO>, spec: Record<string, unknown>) =>
  store.mutate("_clipboards", "create", JSON.stringify(spec)).then(JSON.parse);

const submit = (store: DurableObjectStub<HiveDO>, pattern: string, data: Record<string, unknown>) =>
  store.mutate(pattern, "create", JSON.stringify(data)).then(JSON.parse);

const facetsOf = (vs: { facet: string }[]) => new Set(vs.map((v) => v.facet));

// === Totality oracle ===
//
// One declarative home per engine; the definition hook DERIVES its accepted-key set
// from these same registries (it imports CONSTRAINT_KEYS / COMPLETION_METRIC_KEYS /
// COMPARISON_OP_KEYS), so acceptance == enforcement BY CONSTRUCTION. This asserts each
// home is internally TOTAL: every exported key maps to an implemented function and
// vice-versa — a key declared without a rule (fail-open) or a rule with no key (dead)
// fails here. The behavioral fail-closed half is the "unknown key" tests below.

describe("clipboard constraint and metric keysets are total", () => {
  it("constraint keys ⇔ implemented rules", () => {
    expect([...CONSTRAINT_KEYS].sort()).toEqual(Object.keys(CONSTRAINT_RULES).sort());
    for (const k of CONSTRAINT_KEYS) expect(typeof CONSTRAINT_RULES[k]).toBe("function");
  });
  it("comparison op keys ⇔ implemented ops", () => {
    expect([...COMPARISON_OP_KEYS].sort()).toEqual(Object.keys(COMPARISON_OPS).sort());
    for (const k of COMPARISON_OP_KEYS) expect(typeof COMPARISON_OPS[k]).toBe("function");
  });
  it("completion metric keys ⇔ implemented metrics", () => {
    expect([...COMPLETION_METRIC_KEYS].sort()).toEqual(Object.keys(COMPLETION_METRICS).sort());
    for (const k of COMPLETION_METRIC_KEYS) expect(typeof COMPLETION_METRICS[k].compute).toBe("function");
  });
});

// === Definition validation (fail-closed) ===

describe("clipboard definition validation", () => {
  it("rejects an unknown constraint key (fail closed)", async () => {
    const store = getStore();
    await createPattern(store, "contacts", [{ name: "email", type: "text" }]);
    const r = await defineClipboard(store, {
      name: "c", target_pattern: "contacts",
      fields: [{ facet: "email", regexp: "x" }], // typo'd key — must not silently store
    });
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/unknown constraint "regexp"/);
  });

  it("rejects an unknown completion metric (fail closed)", async () => {
    const store = getStore();
    await createPattern(store, "contacts", [{ name: "email", type: "text" }]);
    const r = await defineClipboard(store, {
      name: "c", target_pattern: "contacts",
      completion: { conditions: [{ metric: "tally", op: ">=", value: 5 }] },
    });
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/metric "tally" is unknown/);
  });

  it("requires a dataset-class target", async () => {
    const store = getStore();
    await createPattern(store, "loose", [{ name: "email", type: "text" }], "knowledge");
    const r = await defineClipboard(store, { name: "c", target_pattern: "loose" });
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/must be a dataset-class pattern/);
  });

  it("rejects a field referencing a non-existent facet", async () => {
    const store = getStore();
    await createPattern(store, "contacts", [{ name: "email", type: "text" }]);
    const r = await defineClipboard(store, {
      name: "c", target_pattern: "contacts", fields: [{ facet: "ghost", min_length: 2 }],
    });
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/facet "ghost" which does not exist/);
  });

  it("rejects a second clipboard for an already-bound pattern", async () => {
    const store = getStore();
    await createPattern(store, "contacts", [{ name: "email", type: "text" }]);
    expect((await defineClipboard(store, { name: "a", target_pattern: "contacts" })).error).toBeUndefined();
    const r = await defineClipboard(store, { name: "b", target_pattern: "contacts" });
    expect(r.error).toBe(true); // the partial unique index is the fail-closed floor
  });
});

// === Submission validation: collect-all ===

describe("a clipboard submission collects every field violation", () => {
  async function bind(store: DurableObjectStub<HiveDO>) {
    await createPattern(store, "contacts", [
      { name: "email", type: "text" },
      { name: "age", type: "integer" },
      { name: "code", type: "text" },
      { name: "start", type: "integer" },
      { name: "end", type: "integer" },
    ]);
    const d = await defineClipboard(store, {
      name: "intake",
      target_pattern: "contacts",
      fields: [
        { facet: "email", required: true, pattern: "^[^@]+@[^@]+$" },
        { facet: "age", min: 18, max: 120 },
        { facet: "code", min_length: 8, max_length: 8 },
      ],
      cross_field: [{ left_facet: "end", op: ">=", right_facet: "start" }],
      unique_on: [["email"]],
    });
    expect(d.error).toBeUndefined();
  }

  it("reports every problem at once, not first-fail", async () => {
    const store = getStore();
    await bind(store);
    const r = await submit(store, "contacts", {
      email: "not-an-email", age: 5, code: "x", start: 10, end: 3,
    });
    expect(r.error).toBe(true);
    expect(r.submission).toBe("rejected");
    // email (regex), age (min), code (min_length), end (cross-field) — all four.
    const f = facetsOf(r.violations);
    expect(f.has("email")).toBe(true);
    expect(f.has("age")).toBe(true);
    expect(f.has("code")).toBe(true);
    expect(f.has("end")).toBe(true);
    expect(r.violations.length).toBeGreaterThanOrEqual(4);
    // The MCP mutate tool surfaces only `message` on an error result, so the loud
    // collect-all list MUST be folded into the message (not only the structured
    // array) — assert every failing facet is named there.
    for (const facet of ["email", "age", "code", "end"]) expect(r.message).toContain(facet);
  });

  it("accepts a fully valid submission", async () => {
    const store = getStore();
    await bind(store);
    const r = await submit(store, "contacts", {
      email: "a@b.co", age: 30, code: "ABCD1234", start: 1, end: 9,
    });
    expect(r.error).toBeUndefined();
    expect(r.submission).toBe("accepted");
  });

  it("dedupes a fanout via composite uniqueness (race-free on one DO)", async () => {
    const store = getStore();
    await bind(store);
    const first = await submit(store, "contacts", { email: "dup@x.co", age: 20, code: "AAAA1111", start: 1, end: 2 });
    expect(first.error).toBeUndefined();
    const second = await submit(store, "contacts", { email: "dup@x.co", age: 21, code: "BBBB2222", start: 1, end: 2 });
    expect(second.error).toBe(true);
    expect(facetsOf(second.violations).has("email")).toBe(true);
  });

  it("rejects patch on a clipboard-bound pattern", async () => {
    const store = getStore();
    await bind(store);
    const ok = await submit(store, "contacts", { email: "p@x.co", age: 40, code: "CCCC3333", start: 1, end: 2 });
    const r = await store.mutate("contacts", "patch",
      JSON.stringify({ id: ok.entry.id, facet: "code", match: "CCCC3333", replacement: "DDDD4444" })).then(JSON.parse);
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/clipboard-bound/);
  });
});

// === Completion progress (derived from the log) ===

describe("clipboard completion progress is derived from the submission log", () => {
  async function bindCount(store: DurableObjectStub<HiveDO>, target = 3) {
    await createPattern(store, "answers", [
      { name: "respondent", type: "text" },
      { name: "value", type: "integer" },
    ]);
    const d = await defineClipboard(store, {
      name: "survey",
      target_pattern: "answers",
      completion: { require: "all", conditions: [{ metric: "count", op: ">=", value: target }] },
    });
    expect(d.error).toBeUndefined();
  }

  it("reports a running tally and flips complete when the quota is met", async () => {
    const store = getStore();
    await bindCount(store, 3);
    const r1 = await submit(store, "answers", { respondent: "a", value: 1 });
    expect(r1.progress.complete).toBe(false);
    expect(r1.progress.conditions[0]).toMatchObject({ metric: "count", current: 1, target: 3, satisfied: false });
    await submit(store, "answers", { respondent: "b", value: 2 });
    const r3 = await submit(store, "answers", { respondent: "c", value: 3 });
    expect(r3.progress.complete).toBe(true);
    expect(r3.progress.conditions[0].current).toBe(3);
  });

  it("derives count from non-archived rows, not a stored counter", async () => {
    const store = getStore();
    await bindCount(store, 3);
    const a = await submit(store, "answers", { respondent: "a", value: 1 });
    await submit(store, "answers", { respondent: "b", value: 2 });
    await submit(store, "answers", { respondent: "c", value: 3 });
    // Archive one, then submit again: a stored counter would read 4; a derived
    // COUNT of non-archived rows reads 3.
    await store.mutate("answers", "archive", JSON.stringify({ id: a.entry.id }));
    const r = await submit(store, "answers", { respondent: "d", value: 4 });
    expect(r.progress.conditions[0].current).toBe(3);
  });

  it("covers a required source set (sources_covered) and supports require:any", async () => {
    const store = getStore();
    await createPattern(store, "coverage", [
      { name: "source", type: "text" },
      { name: "note", type: "text" },
    ]);
    await defineClipboard(store, {
      name: "cov",
      target_pattern: "coverage",
      completion: {
        require: "any",
        conditions: [
          { metric: "sources_covered", op: ">=", value: 2, source_facet: "source", required: ["x", "y", "z"] },
          { metric: "count", op: ">=", value: 99 },
        ],
      },
    });
    await submit(store, "coverage", { source: "x", note: "1" });
    const r = await submit(store, "coverage", { source: "y", note: "2" });
    const cov = r.progress.conditions.find((c: any) => c.metric === "sources_covered");
    expect(cov.current).toBe(2);
    expect(cov.satisfied).toBe(true);
    // require:any → complete once sources_covered holds, even though count (≥99) doesn't.
    expect(r.progress.complete).toBe(true);
  });
});

// === Review fixes: whole-row re-validation on update/unarchive, and definition guards ===

describe("clipboard update and unarchive re-validate the whole row", () => {
  async function bind(store: DurableObjectStub<HiveDO>) {
    await createPattern(store, "ranges", [
      { name: "label", type: "text" },
      { name: "start", type: "integer" },
      { name: "end", type: "integer" },
    ]);
    const d = await defineClipboard(store, {
      name: "rng",
      target_pattern: "ranges",
      cross_field: [{ left_facet: "end", op: ">=", right_facet: "start" }],
      unique_on: [["label"]],
    });
    expect(d.error).toBeUndefined();
  }

  it("rejects a partial update that violates a cross-field rule via the UNSUPPLIED operand", async () => {
    const store = getStore();
    await bind(store);
    const ok = await submit(store, "ranges", { label: "a", start: 1, end: 9 });
    expect(ok.error).toBeUndefined();
    // Update ONLY end → 0. The merged row {start:1, end:0} violates end >= start, even
    // though `start` isn't in the payload — the whole-row check must catch it.
    const bad = await store.mutate("ranges", "update", JSON.stringify({ id: ok.entry.id, end: 0 })).then(JSON.parse);
    expect(bad.error).toBe(true);
    expect(facetsOf(bad.violations).has("end")).toBe(true);
  });

  it("rejects an unarchive that would duplicate a unique group created while archived", async () => {
    const store = getStore();
    await bind(store);
    const a = await submit(store, "ranges", { label: "dup", start: 1, end: 2 });
    await store.mutate("ranges", "archive", JSON.stringify({ id: a.entry.id }));
    const b = await submit(store, "ranges", { label: "dup", start: 3, end: 4 }); // ok while `a` archived
    expect(b.error).toBeUndefined();
    const un = await store.mutate("ranges", "unarchive", JSON.stringify({ id: a.entry.id })).then(JSON.parse);
    expect(un.error).toBe(true);
    expect(facetsOf(un.violations).has("label")).toBe(true);
  });
});

describe("clipboard definition guards (fail closed)", () => {
  it("rejects a completion condition with period_days <= 0", async () => {
    const store = getStore();
    await createPattern(store, "ev", [{ name: "v", type: "integer" }]);
    const r = await defineClipboard(store, {
      name: "e", target_pattern: "ev",
      completion: { conditions: [{ metric: "distinct_periods", op: ">=", value: 3, period_days: 0 }] },
    });
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/period_days/);
  });

  it("rejects an empty required source set", async () => {
    const store = getStore();
    await createPattern(store, "cov2", [{ name: "source", type: "text" }]);
    const r = await defineClipboard(store, {
      name: "c2", target_pattern: "cov2",
      completion: { conditions: [{ metric: "sources_covered", op: ">=", value: 1, source_facet: "source", required: [] }] },
    });
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/required/);
  });

  it("rejects a numeric constraint on a non-numeric facet", async () => {
    const store = getStore();
    await createPattern(store, "txt", [{ name: "name", type: "text" }]);
    const r = await defineClipboard(store, {
      name: "t", target_pattern: "txt", fields: [{ facet: "name", min: 1, max: 5 }],
    });
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/min\/max only apply to a numeric facet/);
  });
});
