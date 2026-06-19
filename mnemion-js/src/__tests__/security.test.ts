import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";

// Regression guards for the security review fixes. These exercise the mutate /
// evolution chokepoints (RPC = below the consent layer, runs the kernel hooks),
// proving the exfil & escalation chains are refused at the source.

function getStore(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName(`user:sec:${crypto.randomUUID()}`);
  return env.MNEMION_HIVE.get(id);
}

describe("exfil: kernel entries can't be individually shared", () => {
  it("set_sharing refuses a kernel pattern (was: /o/entry/_access_tokens/{id} dumped the token)", async () => {
    const store = getStore();
    const r = JSON.parse(await store.proposeChange("share a token", JSON.stringify({
      type: "set_sharing", pattern_name: "_access_tokens", entry_id: 1, visibility: "public",
    })));
    // refused at propose-time validation
    expect(r.error ?? !!r.message).toBeTruthy();
    expect(JSON.stringify(r)).toContain("cannot be shared");
  });
});

describe("escalation: access-token attribution can't be forged", () => {
  it("rejects a token attributed to the owner sentinel", async () => {
    const store = getStore();
    const r = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ scope: "*", member: "owner" })));
    expect(r.error).toBeTruthy();
    expect(r.message).toMatch(/owner|member/i);
  });
  it("rejects a token attributed to a non-roster member", async () => {
    const store = getStore();
    const r = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ scope: "*", member: "ghost" })));
    expect(r.error).toBeTruthy();
    expect(r.message).toMatch(/member|roster/i);
  });
  it("still allows a member-less token (resolves to the owner sentinel downstream)", async () => {
    const store = getStore();
    const r = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ scope: "*" })));
    expect(r.error).toBeFalsy();
    expect(r.entry?.token).toBeTruthy();
  });
});

describe("exfil: a kernel-sourced page block is refused at mutate", () => {
  it("rejects a public page charting _members", async () => {
    const store = getStore();
    const r = JSON.parse(await store.mutate("_pages", "create", JSON.stringify({
      name: "Roster", path: "roster", visibility: "public",
      blocks: JSON.stringify([{ type: "metric", pattern: "_members", agg: "count" }]),
    })));
    expect(r.error).toBeTruthy();
    expect(r.message).toContain("kernel pattern");
  });
});
