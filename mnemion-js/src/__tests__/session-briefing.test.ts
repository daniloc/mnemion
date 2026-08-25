// The session-briefing chokepoint — one hive RPC per MCP session init.
//
// Diagnosis (2026-08-14): per-minute Cloudflare analytics showed HiveDO waking
// in a quantum of exactly THREE requests every ~60–90s, around the clock — one
// full MCP handshake per reconnecting client, each landing a fresh SessionDO
// whose init() made three separate hive calls (registerSession,
// getRecentActivity, getMaintenanceStatus), the first of which was an
// unconditional storage.put. The reconnect rate is set by the clients (the
// claude.ai connector and every open Claude Code session re-handshake on their
// own schedule), so the per-handshake cost is the only lever the server owns.
//
// getSessionBriefing collapses the three calls into one RPC and skips the
// session-registry write when the id is already current — so a re-handshake of
// a known session costs zero hive writes.
import { describe, it, expect } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { getStore, createPattern } from "./helpers";

describe("getSessionBriefing", () => {
  it("returns recent activity + maintenance status in one call, and registers the session", async () => {
    const store = getStore();
    await createPattern(store, "notes", [{ name: "body", type: "text" }]);
    await store.mutate("notes", "create", JSON.stringify({ body: "hello briefing" }));

    const briefing = JSON.parse(await store.getSessionBriefing("session-abc"));

    // Both halves of what init() used to fetch separately.
    expect(Array.isArray(briefing.recent)).toBe(true);
    expect(briefing.recent.some((r: any) => r.pattern === "notes")).toBe(true);
    expect(briefing.maintenance).toHaveProperty("overdue");
    expect(briefing.maintenance).toHaveProperty("interval_days");

    // Registered for scratchpad fanout.
    await runInDurableObject(store, async (_i, state) => {
      const ids = (await state.storage.get<string[]>("mcp_sessions")) ?? [];
      expect(ids).toContain("session-abc");
    });
  });

  it("a repeat briefing for an already-registered session writes nothing", async () => {
    const store = getStore();
    await store.getSessionBriefing("session-abc");

    await runInDurableObject(store, async (instance: any, state) => {
      let puts = 0;
      const realPut = state.storage.put.bind(state.storage);
      (instance as any).ctx.storage.put = ((...args: any[]) => { puts++; return realPut(...args); }) as any;

      await instance.getSessionBriefing("session-abc");
      expect(puts, "re-handshake of a known session wrote the registry").toBe(0);

      // A NEW session still registers (the write is skipped only when redundant).
      await instance.getSessionBriefing("session-def");
      expect(puts).toBe(1);
      const ids = (await state.storage.get<string[]>("mcp_sessions")) ?? [];
      expect(ids).toEqual(["session-abc", "session-def"]);
    });
  });
});
