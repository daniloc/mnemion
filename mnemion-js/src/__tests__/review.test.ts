// The derived review: hook due-ness, overdue/due/stalled work, alignment gaps —
// computed at read time from entries, links and the calendar (review.ts).

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";
import { computeReview, localClock, reviewsPatternSpec, HOOKS, type Review } from "../../entities/Hive/review";

type Store = DurableObjectStub<HiveDO>;

function getStore(): Store {
  return env.MNEMION_HIVE.get(env.MNEMION_HIVE.idFromName(`review:${crypto.randomUUID()}`));
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

async function createPattern(store: Store, name: string, facets: Record<string, unknown>[] = [{ name: "title", type: "text" }]) {
  await change(store, {
    type: "create_pattern", pattern_name: name, pattern_description: `Test pattern ${name}`,
    doctrine: `Test doctrine for ${name}`, facets,
  });
}

const DESC = (name: string) =>
  `Test relation "${name}": the source entry stands in a specific, documented relationship to the target entry. ` +
  `Use it when no kernel default fits the connection. Example, in canonical direction: notes/1 ${name} papers/2.`;

async function declare(store: Store, spec: Record<string, unknown>) {
  await change(store, { type: "declare_relation", description: DESC(String(spec.name)), cardinality: "many", behaviors: [], ...spec });
}

async function entry(store: Store, pattern: string, data: Record<string, unknown>): Promise<number> {
  const r = JSON.parse(await store.mutate(pattern, "create", JSON.stringify(data)));
  if (r.error) throw new Error(r.message);
  return r.entry.id as number;
}

async function charter(store: Store, key: string, value: string) {
  await entry(store, "_charter", { key, value });
}

async function backdate(store: Store, table: string, id: number, column: string, days: number) {
  await runInDurableObject(store, async (_instance, state) => {
    state.storage.sql.exec(`UPDATE "${table}" SET "${column}" = datetime('now', '-${days} days') WHERE id = ?`, id);
  });
}

/** The review as of a fixed instant, straight from the module (the DO wraps the same call). */
async function reviewAt(store: Store, now: Date): Promise<Review> {
  return runInDurableObject(store, (_instance, state) => computeReview({ db: state.storage.sql, now }));
}

const ids = (list: { id: number }[]) => list.map((e) => e.id).sort((a, b) => a - b);

// Wednesday 2026-10-28 12:00 UTC: Monday is the 26th, Sunday the 1st of November.
const WED_NOON = new Date("2026-10-28T12:00:00Z");

const TASK_FACETS = [
  { name: "title", type: "text" },
  { name: "deadline", type: "datetime" },
  { name: "status", type: "select", options: ["open", "in-progress", "done", "dropped"] },
];

describe("derived review", () => {
  it("classifies open work by deadline and last touch, and ignores closed entries", async () => {
    const store = getStore();
    await createPattern(store, "tasks", TASK_FACETS);
    const overdue = await entry(store, "tasks", { title: "overdue", deadline: "2026-03-15", status: "open" });
    const today = await entry(store, "tasks", { title: "today", deadline: "2026-10-28", status: "in-progress" });
    const thisWeek = await entry(store, "tasks", { title: "this week", deadline: "2026-11-01", status: "open" });
    const nextWeek = await entry(store, "tasks", { title: "next week", deadline: "2026-11-02", status: "open" });
    const stalled = await entry(store, "tasks", { title: "stalled", status: "open" });
    await backdate(store, "tasks", stalled, "updated_at", 40);
    await entry(store, "tasks", { title: "done long ago", deadline: "2026-01-01", status: "done" });
    await entry(store, "tasks", { title: "dropped", deadline: "2026-01-01", status: "dropped" });

    const review = await reviewAt(store, WED_NOON);
    expect(review.as_of).toBe("2026-10-28");
    expect(review.work).toHaveLength(1);
    const work = review.work[0];
    expect(work.pattern).toBe("tasks");
    expect(work.open).toBe(5);
    expect(work.undated).toBe(1);
    expect(work.stall_days).toBe(30); // no memory policy → the default
    expect(ids(work.overdue)).toEqual([overdue]);
    expect(ids(work.due_today)).toEqual([today]);
    expect(ids(work.due_this_week)).toEqual([thisWeek]);
    expect(ids(work.stalled)).toEqual([stalled]);
    expect(work.overdue[0]).toMatchObject({ label: "overdue", status: "open", deadline: "2026-03-15", uri: `mnemion://entry/tasks/${overdue}` });
    expect(review.message).toBe("Review: 1 overdue, 1 due today, 1 due this week, 1 stalled.");
    expect(ids(work.due_this_week)).not.toContain(nextWeek);
  });

  it("stall horizon follows the pattern's memory-policy half-life", async () => {
    const store = getStore();
    await createPattern(store, "tasks", TASK_FACETS);
    await change(store, { type: "set_memory_policy", pattern_name: "tasks", policy: { half_life_days: 45 } });
    const id = await entry(store, "tasks", { title: "touched 40 days ago", status: "open" });
    await backdate(store, "tasks", id, "updated_at", 40);
    const review = await reviewAt(store, WED_NOON);
    expect(review.work[0].stall_days).toBe(45);
    expect(review.work[0].stalled).toEqual([]);
    expect(review.message).toBeNull();
  });

  it("reports no work and no hooks on a hive without the vocabulary, and offers the reviews pattern", async () => {
    const store = getStore();
    await createPattern(store, "notes");
    const review = await reviewAt(store, WED_NOON);
    expect(review.work).toEqual([]);
    expect(review.alignment).toEqual([]);
    expect(review.hooks.pattern).toBeNull();
    expect(review.hooks.due).toEqual([]);
    expect(review.hooks.declare?.pattern).toMatchObject({ type: "create_pattern", pattern_name: "reviews" });
    expect(review.hooks.declare?.relations.map((r) => r.name)).toEqual(["commits-to", "reflects-on"]);
    expect(review.message).toBeNull();

    // Applying exactly what the review offers lets a hook record its links.
    await change(store, review.hooks.declare!.pattern);
    for (const rel of review.hooks.declare!.relations) await change(store, rel);
    const r = JSON.parse(await store.mutate("reviews", "create", JSON.stringify({ kind: "day-start", period: "2026-10-28", intention: "x" })));
    expect(r.error).toBeFalsy();
    const r2 = JSON.parse(await store.mutate("reviews", "create", JSON.stringify({ kind: "day-end", period: "2026-10-28", reflection: "y", _relate: { "reflects-on": `reviews/${r.entry.id}` } })));
    expect(r2.error).toBeFalsy();
  });

  it("a deadline with a time is due on its day in the charter timezone, and alignment skips closed and exempt entries", async () => {
    const store = getStore();
    await charter(store, "timezone", "America/Los_Angeles");
    await createPattern(store, "tasks", TASK_FACETS);
    // 8 pm on the 28th in Los Angeles is 03:00 UTC on the 29th.
    const evening = await entry(store, "tasks", { title: "evening", deadline: "2026-10-28T20:00:00-07:00", status: "open" });
    // Wednesday the 28th at noon in Los Angeles.
    let review = await reviewAt(store, new Date("2026-10-28T19:00:00Z"));
    expect(review.as_of).toBe("2026-10-28");
    expect(ids(review.work[0].due_today)).toEqual([evening]);
    expect(review.work[0].due_today[0].deadline).toBe("2026-10-28");

    await createPattern(store, "goals");
    await createPattern(store, "projects", [{ name: "title", type: "text" }, { name: "status", type: "select", options: ["active", "retired"] }]);
    await declare(store, { name: "serves", inverse: "served-by", source: ["projects"], target: ["goals"] });
    await declare(store, { name: "belongs-to", inverse: "contains", source: ["tasks"], target: ["projects"], cardinality: "one", behaviors: ["containment"] });
    await change(store, { type: "declare_relation", name: "reaches", inverse: "reached-by", description: DESC("reaches"), chain: ["belongs-to", "serves"] });
    const live = await entry(store, "projects", { title: "live", status: "active" });
    const retired = await entry(store, "projects", { title: "retired", status: "retired" });
    const catchAll = await entry(store, "projects", { title: "catch-all", status: "active" });
    await charter(store, "review_exempt", `projects/${catchAll}`);

    review = await reviewAt(store, WED_NOON);
    const gap = (relation: string, end: string) => review.alignment.find((g) => g.relation === relation && g.end === end);
    expect(ids(gap("serves", "source")!.entries)).toEqual([live]); // retired is closed, catch-all exempt
    expect(ids(gap("belongs-to", "target")!.entries)).toEqual([live]);
    void retired;
  });

  it("hooks are due until a review entry covers the current period", async () => {
    const store = getStore();
    await change(store, reviewsPatternSpec());

    let review = await reviewAt(store, WED_NOON);
    expect(review.hooks.pattern).toBe("reviews");
    expect(review.hooks.due).toEqual(["day-start", "week-start", "month-start"]);
    expect(review.hooks.status.map((h) => h.period)).toEqual([
      "2026-10-28", "2026-10-28", "2026-10-26", "2026-10-26", "2026-10-01", "2026-10-01",
    ]);
    expect(review.message).toBe("Review: day-start, week-start and month-start reviews due.");

    const dayStart = await entry(store, "reviews", { kind: "day-start", period: "2026-10-28", intention: "ship the review" });
    await entry(store, "reviews", { kind: "week-start", period: "2026-10-26", intention: "the week" });
    await entry(store, "reviews", { kind: "month-start", period: "2026-10-01", intention: "the month" });
    review = await reviewAt(store, WED_NOON);
    expect(review.hooks.due).toEqual([]);
    expect(review.hooks.status[0].last).toEqual({ id: dayStart, period: "2026-10-28" });
    expect(review.message).toBeNull();

    // A review from an earlier period does not cover this one; the 29th is also
    // inside the month-end window (the last three days of October).
    review = await reviewAt(store, new Date("2026-10-29T12:00:00Z"));
    expect(review.hooks.due).toEqual(["day-start", "month-end"]);
  });

  it("end hooks open at the day-end hour in the charter timezone; month-end in the last three days", async () => {
    const store = getStore();
    await change(store, reviewsPatternSpec());
    await charter(store, "timezone", "America/Los_Angeles");

    // 23:30 UTC on Wednesday is 16:30 in Los Angeles — before the default 17:00.
    const lateUtc = new Date("2026-10-28T23:30:00Z");
    let review = await reviewAt(store, lateUtc);
    expect(review.timezone).toBe("America/Los_Angeles");
    expect(review.as_of).toBe("2026-10-28");
    expect(review.hooks.due).not.toContain("day-end");

    await charter(store, "review_day_end_hour", "16");
    review = await reviewAt(store, lateUtc);
    expect(review.hooks.due).toContain("day-end");
    expect(review.hooks.due).not.toContain("week-end");
    expect(review.hooks.due).not.toContain("month-end");

    // Saturday 2026-10-31 at noon local: the week-end and month-end windows are open.
    review = await reviewAt(store, new Date("2026-10-31T19:00:00Z"));
    expect(review.as_of).toBe("2026-10-31");
    expect(review.hooks.due).toEqual(expect.arrayContaining(["week-end", "month-end"]));
    expect(review.hooks.status.find((h) => h.kind === "week-end")!.period).toBe("2026-10-26");
    expect(review.hooks.status.find((h) => h.kind === "month-end")!.period).toBe("2026-10-01");

    await entry(store, "reviews", { kind: "week-end", period: "2026-10-26", reflection: "it moved" });
    await entry(store, "reviews", { kind: "month-end", period: "2026-10-01", reflection: "it proved" });
    review = await reviewAt(store, new Date("2026-10-31T19:00:00Z"));
    expect(review.hooks.due).not.toContain("week-end");
    expect(review.hooks.due).not.toContain("month-end");
  });

  it("an unknown timezone falls back to UTC", () => {
    const { clock, timezone } = localClock(WED_NOON, "Mars/Olympus_Mons");
    expect(timezone).toBe("UTC");
    expect(clock).toMatchObject({ date: "2026-10-28", hour: 12, weekday: 3 });
    expect(localClock(new Date("2026-11-01T03:00:00Z"), "Asia/Tokyo").clock).toMatchObject({ date: "2026-11-01", hour: 12, weekday: 7 });
    expect(HOOKS).toHaveLength(6);
  });

  it("alignment gaps follow each step of a chained relation, skipping a required step's source end", async () => {
    const store = getStore();
    await createPattern(store, "goals");
    await createPattern(store, "projects");
    await createPattern(store, "tasks");
    await declare(store, { name: "serves", inverse: "served-by", source: ["projects"], target: ["goals"] });
    await declare(store, { name: "belongs-to", inverse: "contains", source: ["tasks"], target: ["projects"], cardinality: "one", behaviors: ["containment"], required: true });
    await change(store, { type: "declare_relation", name: "addresses", inverse: "addressed-by", description: DESC("addresses"), chain: ["belongs-to", "serves"] });

    const served = await entry(store, "goals", { title: "served goal" });
    const unserved = await entry(store, "goals", { title: "goal nothing serves" });
    const aligned = await entry(store, "projects", { title: "aligned project", _relate: { serves: `goals/${served}` } });
    const idle = await entry(store, "projects", { title: "project serving nothing" });
    await entry(store, "tasks", { title: "a task", _relate: { "belongs-to": `projects/${aligned}` } });

    const review = await reviewAt(store, WED_NOON);
    const gap = (relation: string, end: string) => review.alignment.find((g) => g.relation === relation && g.end === end);
    expect(review.alignment.map((g) => `${g.chain}:${g.relation}:${g.end}:${g.pattern}`)).toEqual([
      "addresses:belongs-to:target:projects",
      "addresses:serves:source:projects",
      "addresses:serves:target:goals",
    ]);
    expect(ids(gap("belongs-to", "target")!.entries)).toEqual([idle]);
    expect(ids(gap("serves", "source")!.entries)).toEqual([idle]);
    expect(ids(gap("serves", "target")!.entries)).toEqual([unserved]);
    expect(gap("serves", "target")!.entries[0].label).toBe("goal nothing serves");
    expect(review.message).toBe("Review: 1 projects without inbound belongs-to; 1 projects without serves; 1 goals without inbound serves.");

    // Closing the gaps empties the review.
    await store.mutate("link", "create", JSON.stringify({ source: `projects/${idle}`, target: `goals/${unserved}`, label: "serves" }));
    await entry(store, "tasks", { title: "another task", _relate: { "belongs-to": `projects/${idle}` } });
    expect((await reviewAt(store, WED_NOON)).alignment).toEqual([]);
  });

  it("rides resolve, the prime response and the /api/review route", async () => {
    const store = getStore();
    await createPattern(store, "tasks", TASK_FACETS);
    await entry(store, "tasks", { title: "late", deadline: "2020-01-01", status: "open" });

    const resolved = JSON.parse(await store.resolve("mnemion://review"));
    expect(resolved.work[0].overdue).toHaveLength(1);
    expect(resolved.message).toMatch(/1 overdue/);

    const primed = JSON.parse(await store.prime("what should I do today", "", 5));
    expect(primed.review).toMatchObject({ message: expect.stringMatching(/1 overdue/), due_hooks: [], uri: "mnemion://review" });

    // The route exists and sits behind the session gate (no secret in the test env → fail closed).
    const res = await SELF.fetch("https://test.local/api/review");
    expect(res.status).not.toBe(404);
    expect([302, 401, 503]).toContain(res.status);
  });
});
