// Recall for native and web clients: /api/prime and /api/search are the same
// prime and search the MCP tools call, behind the session bearer gate.

import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { primeContext, searchEntries, batchMutate } from "../../shared/Routing/routes/pages";
import type { RouteContext } from "../../shared/Routing/router";
import type { HiveDO } from "../../entities/Hive/hive";

type Store = DurableObjectStub<HiveDO>;

function getStore(): Store {
  return env.MNEMION_HIVE.get(env.MNEMION_HIVE.idFromName(`api-recall:${crypto.randomUUID()}`));
}

async function createPattern(store: Store, name: string) {
  const p = JSON.parse(await store.proposeChange(`Create ${name}`, JSON.stringify({
    type: "create_pattern", pattern_name: name, pattern_description: `Test pattern ${name}`,
    doctrine: `Test doctrine for ${name}`, facets: [{ name: "title", type: "text" }, { name: "body", type: "text" }],
  })));
  if (p.error) throw new Error(p.message);
  const a = JSON.parse(await store.applyChange(p.change_id));
  if (a.error) throw new Error(a.message);
}

/** Drive a handler directly with the owner's hive, as the router would after the gate. */
function ctxFor(store: Store, request: Request): RouteContext {
  const url = new URL(request.url);
  return { request, url, env: env as any, params: {}, hive: store } as unknown as RouteContext;
}

describe("api recall", () => {
  it("/api/search runs the hive's full-text search with q, patterns and limit", async () => {
    const store = getStore();
    await createPattern(store, "notes");
    await createPattern(store, "drafts");
    await store.mutate("notes", "create", JSON.stringify({ title: "Spelunx at six", body: "the foundation" }));
    await store.mutate("drafts", "create", JSON.stringify({ title: "Spelunx essay", body: "a draft" }));

    const all = await searchEntries(ctxFor(store, new Request("https://test.local/api/search?q=Spelunx")));
    expect(all.status).toBe(200);
    const parsed = await all.json() as { results: { pattern: string }[] };
    expect(parsed.results.map((r) => r.pattern).sort()).toEqual(["drafts", "notes"]);

    const only = await searchEntries(ctxFor(store, new Request("https://test.local/api/search?q=Spelunx&patterns=notes&limit=5")));
    const narrowed = await only.json() as { results: { pattern: string }[] };
    expect(narrowed.results.map((r) => r.pattern)).toEqual(["notes"]);

    const missing = await searchEntries(ctxFor(store, new Request("https://test.local/api/search")));
    expect(missing.status).toBe(400);
  });

  it("/api/prime takes a JSON body and returns the prime response", async () => {
    const store = getStore();
    await createPattern(store, "notes");
    const ok = await primeContext(ctxFor(store, new Request("https://test.local/api/prime", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: "what was the foundation", limit: 5 }),
    })));
    expect(ok.status).toBe(200);
    const parsed = await ok.json() as { charter: unknown; results: unknown[]; relations: unknown[] };
    expect(parsed).toHaveProperty("charter");
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(Array.isArray(parsed.relations)).toBe(true);

    const missing = await primeContext(ctxFor(store, new Request("https://test.local/api/prime", { method: "POST", body: "{}" })));
    expect(missing.status).toBe(400);
  });

  it("/api/batch runs one atomic batch with link and unlink shortcuts", async () => {
    const store = getStore();
    await createPattern(store, "notes");
    const a = JSON.parse(await store.mutate("notes", "create", JSON.stringify({ title: "a" }))).entry.id as number;
    const b = JSON.parse(await store.mutate("notes", "create", JSON.stringify({ title: "b" }))).entry.id as number;
    const c = JSON.parse(await store.mutate("notes", "create", JSON.stringify({ title: "c" }))).entry.id as number;
    await store.mutate("link", "create", JSON.stringify({ source: `notes/${a}`, target: `notes/${b}`, label: "references" }));

    const moved = await batchMutate(ctxFor(store, new Request("https://test.local/api/batch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operations: [
        { pattern: "unlink", data: { source: `notes/${a}`, target: `notes/${b}`, label: "references" } },
        { pattern: "link", data: { source: `notes/${a}`, target: `notes/${c}`, label: "references" } },
      ] }),
    })));
    expect(moved.status).toBe(200);
    const links = JSON.parse(await store.query("_links", JSON.stringify([`source_id=${a}`, "label=references"]), "", "id", 10, false)) as { entries: { target_id: number; archived_at: string | null }[] };
    expect(links.entries.filter((l) => l.archived_at == null).map((l) => l.target_id)).toEqual([c]);

    const empty = await batchMutate(ctxFor(store, new Request("https://test.local/api/batch", { method: "POST", body: "{}" })));
    expect(empty.status).toBe(400);
    // A malformed item is refused by the hive itself (the chokepoint MCP shares), never a 500.
    const malformed = await batchMutate(ctxFor(store, new Request("https://test.local/api/batch", { method: "POST", body: JSON.stringify({ operations: [null, 1] }) })));
    expect(malformed.status).toBe(200);
    expect(await malformed.json()).toMatchObject({ error: true, message: expect.stringMatching(/item 0/) });
    expect(JSON.parse(await store.batchMutate(JSON.stringify([{ pattern: "notes" }])))).toMatchObject({ error: true, message: expect.stringMatching(/item 0/) });
  });

  it("the routes exist and sit behind the session gate", async () => {
    for (const [method, path] of [["POST", "/api/prime"], ["GET", "/api/search?q=x"], ["POST", "/api/batch"]] as const) {
      const res = await SELF.fetch(`https://test.local${path}`, { method });
      expect(res.status, path).not.toBe(404);
      expect([302, 401, 503], path).toContain(res.status);
    }
  });
});
