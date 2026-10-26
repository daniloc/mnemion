// A facet declares what its values ARE, once, so no reader re-decides it:
// `resolution: "day"` on a datetime (a time of day is refused at write) and
// `closed` on a select (the options that end an item). evolution.ts declares and
// validates them, data.ts enforces the day rule at the write chokepoint, the
// index and schema publish them, and the review reads `closed` instead of a
// hard-coded set.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";
import { computeReview } from "../../entities/Hive/review";

type Store = DurableObjectStub<HiveDO>;

function getStore(): Store {
  return env.MNEMION_HIVE.get(env.MNEMION_HIVE.idFromName(`facet-decl:${crypto.randomUUID()}`));
}

const propose = async (store: Store, change: Record<string, unknown>) =>
  JSON.parse(await store.proposeChange(`test ${change.type}`, JSON.stringify(change)));
const apply = async (store: Store, id: string) => JSON.parse(await store.applyChange(id));

async function change(store: Store, spec: Record<string, unknown>) {
  const p = await propose(store, spec);
  if (p.error) throw new Error(`propose refused: ${p.message}`);
  const a = await apply(store, p.change_id);
  if (a.error) throw new Error(`apply refused: ${a.message}`);
  return a;
}

const mut = (store: Store, pattern: string, op: string, data: Record<string, unknown>) =>
  store.mutate(pattern, op, JSON.stringify(data)).then(JSON.parse);

const TASKS = {
  type: "create_pattern", pattern_name: "tasks", pattern_description: "t", doctrine: "t",
  facets: [
    { name: "title", type: "text" },
    { name: "deadline", type: "datetime", resolution: "day" },
    { name: "status", type: "select", options: ["open", "doing", "done", "dropped"], closed: ["done", "dropped"] },
  ],
};

describe("facet declarations", () => {
  it("validates resolution and closed at declaration", async () => {
    const store = getStore();
    const bad = async (facet: Record<string, unknown>) =>
      (await propose(store, { ...TASKS, pattern_name: "x", facets: [facet] })).message as string;
    expect(await bad({ name: "a", type: "text", resolution: "day" })).toMatch(/not type datetime/);
    expect(await bad({ name: "a", type: "datetime", resolution: "week" })).toMatch(/"day" or "instant"/);
    expect(await bad({ name: "a", type: "text", closed: ["x"] })).toMatch(/not type select/);
    expect(await bad({ name: "a", type: "select", options: ["open", "done"], closed: ["gone"] })).toMatch(/not options: gone/);
    expect(await bad({ name: "a", type: "select", options: ["open", "done"], closed: ["open", "done"] })).toMatch(/at least one option must stay open/);
  });

  it("publishes the declarations in the index and the schema", async () => {
    const store = getStore();
    await change(store, TASKS);
    const index = JSON.parse(await store.getIndex());
    const tasks = index.patterns.find((p: any) => p.name === "tasks");
    expect(tasks.facets.find((f: any) => f.name === "deadline").resolution).toBe("day");
    expect(tasks.facets.find((f: any) => f.name === "status").closed).toEqual(["done", "dropped"]);
    expect(tasks.facets.find((f: any) => f.name === "title").resolution).toBeUndefined();
    const schema = JSON.parse(await store.getSchema("tasks"));
    expect(schema.facets.find((f: any) => f.name === "deadline").resolution).toBe("day");
  });

  it("a day-resolution facet refuses a time of day at write and keeps calendar days", async () => {
    const store = getStore();
    await change(store, TASKS);
    const ok = await mut(store, "tasks", "create", { title: "a", deadline: "2026-10-28", status: "open" });
    expect(ok.error).toBeFalsy();
    expect(ok.entry.deadline).toBe("2026-10-28");
    const refused = await mut(store, "tasks", "create", { title: "b", deadline: "2026-10-28T20:00:00-07:00", status: "open" });
    expect(refused).toMatchObject({ error: true, message: expect.stringMatching(/resolution: day/) });
    const updated = await mut(store, "tasks", "update", { id: ok.entry.id, deadline: "2026-10-29 18:00" });
    expect(updated).toMatchObject({ error: true });
  });

  it("set_resolution is refused while stored values carry a time, and set_options carries closed", async () => {
    const store = getStore();
    await change(store, { ...TASKS, facets: [{ name: "title", type: "text" }, { name: "deadline", type: "datetime" }, { name: "status", type: "select", options: ["open", "done"] }] });
    const timed = await mut(store, "tasks", "create", { title: "timed", deadline: "2026-10-28T20:00:00Z", status: "open" });
    const p = await propose(store, { type: "set_resolution", pattern_name: "tasks", facet: "deadline", resolution: "day" });
    expect(p.preview.violations).toHaveLength(1);
    expect(p.preview.violations[0].reason).toMatch(/timestamp, not a day/);
    expect((await apply(store, p.change_id)).error).toBe(true);
    await mut(store, "tasks", "update", { id: timed.entry.id, deadline: "2026-10-28" });
    await change(store, { type: "set_resolution", pattern_name: "tasks", facet: "deadline", resolution: "day" });
    expect((await mut(store, "tasks", "update", { id: timed.entry.id, deadline: "2026-10-28T09:00:00Z" })).error).toBe(true);

    await change(store, { type: "set_options", pattern_name: "tasks", facet_name: "status", options: ["open", "done", "dropped"], closed: ["done", "dropped"] });
    let status = JSON.parse(await store.getSchema("tasks")).facets.find((f: any) => f.name === "status");
    expect(status.closed).toEqual(["done", "dropped"]);
    // Options that no longer hold the closed values must say so.
    expect((await propose(store, { type: "set_options", pattern_name: "tasks", facet_name: "status", options: ["open", "finished"] })).message).toMatch(/pass closed explicitly/);
    await change(store, { type: "set_options", pattern_name: "tasks", facet_name: "status", options: ["open", "finished"], closed: ["finished"] });
    status = JSON.parse(await store.getSchema("tasks")).facets.find((f: any) => f.name === "status");
    expect(status.closed).toEqual(["finished"]);
    await change(store, { type: "set_options", pattern_name: "tasks", facet_name: "status", options: ["open", "finished"], closed: null });
    status = JSON.parse(await store.getSchema("tasks")).facets.find((f: any) => f.name === "status");
    expect(status.closed).toBeUndefined();
  });

  it("the review reads closed from the declaration, not a hard-coded set", async () => {
    const store = getStore();
    // "parked" is not in the fallback set, "done" is; the declaration decides.
    await change(store, { ...TASKS, facets: [
      { name: "title", type: "text" },
      { name: "deadline", type: "datetime", resolution: "day" },
      { name: "status", type: "select", options: ["open", "done", "parked"], closed: ["parked"] },
    ] });
    await mut(store, "tasks", "create", { title: "parked", deadline: "2020-01-01", status: "parked" });
    const done = await mut(store, "tasks", "create", { title: "done but open by declaration", deadline: "2020-01-01", status: "done" });
    const review = await runInDurableObject(store, (_i, state) => computeReview({ db: state.storage.sql, now: new Date("2026-10-28T12:00:00Z") }));
    expect(review.work[0].overdue.map((b) => b.id)).toEqual([done.entry.id]);
  });

  it("an undeclared closed set closes nothing, and the review says so", async () => {
    const store = getStore();
    await change(store, { ...TASKS, facets: [
      { name: "title", type: "text" },
      { name: "deadline", type: "datetime", resolution: "day" },
      { name: "status", type: "select", options: ["open", "done"] },
    ] });
    await mut(store, "tasks", "create", { title: "done", deadline: "2020-01-01", status: "done" });
    const review = await runInDurableObject(store, (_i, state) => computeReview({ db: state.storage.sql, now: new Date("2026-10-28T12:00:00Z") }));
    expect(review.work[0].closed_declared).toBe(false);
    expect(review.work[0].totals.overdue).toBe(1); // "done" is not closed until declared
    expect(review.message).toMatch(/tasks.status declares no closed values/);
  });
});
