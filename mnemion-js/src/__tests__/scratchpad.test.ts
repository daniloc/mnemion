// Scratchpad — durable shared coordination pads for agents in neighboring sessions.
// Phase 1: the _scratchpad pattern (post / validate / per-pad scoped reads). The push
// fan-out (Phase 2) is exercised through MCP in mcp-smoke (it needs the live transport).

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";

function getStore(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName(`scratch:${Math.random()}`);
  return env.MNEMION_HIVE.get(id);
}
const post = (store: DurableObjectStub<HiveDO>, data: Record<string, unknown>) =>
  store.mutate("_scratchpad", "create", JSON.stringify(data)).then(JSON.parse);
const read = (store: DurableObjectStub<HiveDO>, pad: string) =>
  store.query("_scratchpad", JSON.stringify([`pad=${pad}`]), "", "-id", 50, false).then(JSON.parse);

describe("scratchpad notes", () => {
  it("a scratchpad note requires a pad slug and a kind", async () => {
    const store = getStore();
    expect((await post(store, { kind: "note", body: "hi" })).error).toBe(true); // no pad
    expect((await post(store, { pad: "bad slug!", kind: "note" })).error).toBe(true); // not a slug
    expect((await post(store, { pad: "proj", body: "hi" })).error).toBe(true); // no kind
    const ok = await post(store, { pad: "proj", kind: "note", body: "hi" });
    expect(ok.error).toBeUndefined();
    expect(ok.entry.pad).toBe("proj");
    expect(ok.entry.created_by).toBe("owner"); // attribution: who posted
  });

  it("scratchpad notes are scoped and read newest-first by pad", async () => {
    const store = getStore();
    await post(store, { pad: "alpha", kind: "claim", body: "1" });
    await post(store, { pad: "beta", kind: "claim", body: "2" });
    await post(store, { pad: "alpha", kind: "done", body: "3" });
    const alpha = await read(store, "alpha");
    expect(alpha.entries.map((e: any) => e.body)).toEqual(["3", "1"]); // newest-first, alpha only
    const beta = await read(store, "beta");
    expect(beta.entries.map((e: any) => e.body)).toEqual(["2"]);
  });
});
