import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";
import { query } from "../../entities/Hive/data";
import { KERNEL_TABLES } from "../../entities/Hive/schema";
import { seal, findUnclassifiedSensitiveColumns } from "../../entities/Hive/policy";

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

describe("token at rest: stored hashed, raw authenticates", () => {
  it("stores a SHA-256 digest (not the raw token), and the raw still validates", async () => {
    const store = getStore();
    const r = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ scope: "*" })));
    const raw = r.entry.token as string;
    expect(raw).toBeTruthy();
    // the column holds the digest (64 hex), not the raw 32-hex token
    const got = JSON.parse(await store.query("_access_tokens", JSON.stringify([`id=${r.entry.id}`]), "", "", 1, false, "", ""));
    const stored = got.entries[0].token as string;
    expect(stored).not.toBe(raw);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    // the raw token (shown once) still authenticates; a wrong one does not
    expect(await store.validateAccessToken(raw, "*")).toBe(true);
    expect(await store.validateAccessToken(raw + "x", "*")).toBe(false);
  });

  it("born-hashed: the raw preimage never lands in the audit log", async () => {
    const store = getStore();
    const raw = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({ scope: "*" }))).entry.token as string;
    await runInDurableObject(store, async (_i, state) => {
      const logs = state.storage.sql.exec(`SELECT new_data, old_data FROM _mutation_log WHERE table_name = '_access_tokens'`).toArray() as any[];
      expect(logs.length).toBeGreaterThan(0); // the create WAS audited
      for (const l of logs) {
        expect(String(l.new_data ?? "")).not.toContain(raw);
        expect(String(l.old_data ?? "")).not.toContain(raw);
      }
    });
  });

  it("a batch-minted token is hashed at rest too and authenticates", async () => {
    const store = getStore();
    const r = JSON.parse(await store.batchMutate(JSON.stringify([{ pattern: "_access_tokens", operation: "create", data: { scope: "read" } }])));
    const raw = r.results[0].entry.token as string;
    expect(raw).toMatch(/^[0-9a-f]{32}$/); // one-time raw on the result
    expect(await store.validateAccessToken(raw, "read")).toBe(true);
  });
});

describe("seal: the egress sieve strips sensitive columns from any serialized row", () => {
  it("removes secret + redact columns, leaves the rest, untouched for non-sensitive patterns", () => {
    expect(seal("_access_tokens", { id: 1, token: "abc", scope: "*" })).toEqual({ id: 1, scope: "*" });
    expect(seal("_passkeys", { id: 1, public_key: "k", credential_id: "c", counter: 3 })).toEqual({ id: 1, counter: 3 });
    expect(seal("goals", { id: 1, title: "x" })).toEqual({ id: 1, title: "x" });
    expect(seal("_access_tokens", null)).toBeNull();
  });
});

describe("egress totality: every secret-shaped column on a kernel table is classified", () => {
  it("catches a planted gap", () => {
    expect(findUnclassifiedSensitiveColumns({ _foo: ["api_key", "name"] })).toEqual(["_foo.api_key"]);
  });
  it("the REAL kernel schema has no unclassified secret-shaped column (the loud oracle)", async () => {
    const store = getStore();
    await runInDurableObject(store, async (_i, state) => {
      const tables = (state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '\\_%' ESCAPE '\\'`).toArray() as any[]).map((t) => t.name as string);
      const cols: Record<string, string[]> = {};
      for (const t of tables) cols[t] = (state.storage.sql.exec(`PRAGMA table_info("${t}")`).toArray() as any[]).map((c: any) => c.name as string);
      // a new secret-shaped column (token/password/public_key/…) on any kernel
      // table fails HERE until it's added to SENSITIVE_COLUMNS.
      expect(findUnclassifiedSensitiveColumns(cols)).toEqual([]);
    });
  });
});

describe("read boundary: one trusted flag gates kernel access for read AND write", () => {
  // The unified chokepoint: an untrusted context (`!trusted`) can neither read
  // nor write a kernel pattern, refused before any DB access — so every serve
  // sink inherits the boundary, and a path that forgets to declare trust fails
  // CLOSED (the flag is required). Mirrors the write side's verifyWritePolicyTotality.
  it("an untrusted (served) read of EVERY kernel pattern is refused at the engine", () => {
    for (const t of KERNEL_TABLES) {
      const r = JSON.parse(query({ trusted: false } as any, t.name, "", "", "", 10, false, "", ""));
      expect(r.error, `served read of ${t.name} must be refused`).toBeTruthy();
      expect(JSON.stringify(r)).toContain("served");
    }
  });
  it("a trusted (owner) context is NOT blocked by the read guard", () => {
    // trusted:true + kernel pattern passes the guard (then hits patternExists etc.);
    // it must NOT short-circuit with the served-surface refusal.
    const r = JSON.parse(query({ trusted: true, patternExists: () => false, listPatterns: () => [] } as any, "_access_tokens", "", "", "", 10, false, "", ""));
    expect(JSON.stringify(r)).not.toContain("public/served surface");
  });
});

// === Read-boundary totality: every served entry point refuses kernel data ===
// The read analogue of policy.test.ts. Each public/unauthenticated serve path is
// exercised against a kernel pattern (rows injected via raw SQL, since the mutate
// guards now block creating them) and must surface NONE of it. Adding a new serve
// path means adding it here — the declarative oracle that keeps the boundary whole.
describe("read-boundary totality: served entry points leak no kernel data", () => {
  function store(): DurableObjectStub<HiveDO> {
    const id = env.MNEMION_HIVE.idFromName(`user:tot:${crypto.randomUUID()}`);
    return env.MNEMION_HIVE.get(id);
  }

  it("getSharedEntry refuses kernel patterns", async () => {
    const s = store();
    expect(JSON.parse(await s.getSharedEntry("_access_tokens", 1)).found).toBe(false);
    expect(JSON.parse(await s.getSharedEntry("_members", 1)).found).toBe(false);
  });

  it("a public page rendering a (smuggled) kernel chart block emits no kernel rows", async () => {
    const s = store();
    // bypass the mutate guard by writing the _pages row directly, then render.
    await runInDurableObject(s, async (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO "_pages" (name, path, visibility, blocks) VALUES ('x','leak','public',?)`,
        JSON.stringify([{ type: "metric", pattern: "_access_tokens", agg: "count" }, { type: "chart", pattern: "_access_tokens", x: "token" }]),
      );
    });
    const html = await s.renderPublicPage("leak");
    // the page renders (not null) but the kernel query returns nothing → no token text
    expect(html == null || !/[0-9a-f]{32,64}/.test(String(html).replace(/<[^>]+>/g, ""))).toBe(true);
  });

  it("a publication with a (smuggled) kernel source serves no kernel rows", async () => {
    const s = store();
    await runInDurableObject(s, async (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO "_publications" (path, source_pattern, format) VALUES ('leak2','_access_tokens','json')`,
      );
    });
    const res = JSON.parse(await s.resolvePublication("leak2"));
    // served boundary refuses the kernel source → no entries (or not-found), never token rows.
    const body = res.body ?? "";
    expect(/[0-9a-f]{64}/.test(body)).toBe(false);
    expect(res.found === false || (res.entries?.length ?? 0) === 0 || body.includes('"entries": []') || body.includes('"count": 0')).toBe(true);
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
