// The boot oracle for unclassified sensitive columns must not fail silent
// (Coherence defect df-45866a77).
//
// initializeSchema walks every `_`-prefixed table with PRAGMA table_info and warns
// when a secret-shaped column is missing from SENSITIVE_COLUMNS. Once a PITR
// bookmark exists the platform's `_cf_METADATA` table refuses PRAGMA (SQLITE_AUTH),
// and a single try around the whole walk turned that refusal into silence for
// every table. These tests pin three guards:
//   1. the `_cf_` prefix is the platform's: nothing Mnemion declares or boots uses it;
//   2. the warning still fires with a real `_cf_METADATA` present;
//   3. one refused table cannot silence the rest, and is itself reported, unless
//      it is on the declared platform allow-list (exactly ["_cf_METADATA"]).
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";
import { initializeSchema, KERNEL_TABLES } from "../../entities/Hive/schema";
// Namespace import: PLATFORM_RESERVED_TABLES is part of this contract and may not
// exist yet; a named import of a missing export would break the whole file.
import * as policy from "../../entities/Hive/policy";

type Store = DurableObjectStub<HiveDO>;
const CF = /^_cf_/i;

function getStore(): Store {
  return env.MNEMION_HIVE.get(env.MNEMION_HIVE.idFromName(`boot-oracle:${crypto.randomUUID()}`));
}

/** Every console.warn line emitted while `fn` runs. */
async function warnLines(fn: () => void | Promise<void>): Promise<string[]> {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await fn();
    return warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n").split("\n");
  } finally { warn.mockRestore(); }
}

const unclassifiedLines = (lines: string[]) => lines.filter((l) => /unclassified sensitive columns/i.test(l));

describe("boot sensitive-column oracle", () => {
  it("the platform allow-list is a declared constant, exactly [\"_cf_METADATA\"]", () => {
    expect((policy as any).PLATFORM_RESERVED_TABLES, "policy.ts exports PLATFORM_RESERVED_TABLES").toEqual(["_cf_METADATA"]);
  });

  it("the _cf_ prefix is reserved for the platform: no kernel table, boot table or _objects row uses it", async () => {
    // Declared kernel tables, core and feature-composed.
    expect(KERNEL_TABLES.map((t) => t.name).filter((n) => CF.test(n))).toEqual([]);

    const store = getStore();
    await runInDurableObject(store, (_i, state) => {
      const db = state.storage.sql;
      initializeSchema(db, env);
      // Any _cf_ table present after boot is the platform's own, never one boot DDL made.
      const cfTables = (db.exec(`SELECT name FROM sqlite_master WHERE type = 'table'`).toArray() as { name: string }[])
        .map((t) => t.name).filter((n) => CF.test(n));
      for (const t of cfTables) expect(["_cf_METADATA"], `${t} is a platform table`).toContain(t);
      const objects = (db.exec(`SELECT name FROM _objects`).toArray() as { name: string }[]).map((o) => o.name);
      expect(objects.filter((n) => CF.test(n))).toEqual([]);
    });

    // A user pattern can never take the prefix (the reserved `_` namespace refuses it).
    const r = JSON.parse(await store.proposeChange("probe", JSON.stringify({
      type: "create_pattern", pattern_name: "_cf_x", pattern_description: "x", doctrine: "x",
      facets: [{ name: "body", type: "text" }],
    })));
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/reserved/i);
  });

  it("the warning fires and names a planted unclassified column while a real _cf_METADATA refuses PRAGMA", async () => {
    const store = getStore();
    await runInDurableObject(store, async (_i, state) => {
      const db = state.storage.sql;
      await state.storage.getCurrentBookmark(); // creates _cf_METADATA if it is not there yet
      expect(db.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_cf_METADATA'`).toArray().length).toBe(1);
      expect(() => db.exec(`PRAGMA table_info("_cf_METADATA")`).toArray(), "the platform table really refuses PRAGMA").toThrow();

      db.exec(`CREATE TABLE "_zz_probe" (id INTEGER PRIMARY KEY, password TEXT)`);
      const lines = await warnLines(() => initializeSchema(db, env));
      const hits = unclassifiedLines(lines);
      expect(hits.length, `warn lines: ${lines.join(" | ")}`).toBeGreaterThan(0);
      expect(hits.join("\n")).toContain("_zz_probe.password");
    });
  });

  it("one table that refuses PRAGMA cannot silence the rest, and is itself reported", async () => {
    const store = getStore();
    await runInDurableObject(store, async (_i, state) => {
      const real = state.storage.sql;
      real.exec(`CREATE TABLE "_zz_locked" (id INTEGER PRIMARY KEY, note TEXT)`);
      real.exec(`CREATE TABLE "_zz_probe" (id INTEGER PRIMARY KEY, password TEXT)`);
      // A db whose PRAGMA on _zz_locked is refused, the way _cf_METADATA's is.
      // _zz_locked is NOT on the platform allow-list, so the refusal is a finding.
      const refusing = new Proxy(real as any, {
        get(t, k) {
          if (k === "exec") return (q: string, ...p: unknown[]) => {
            if (/PRAGMA\s+table_info\s*\(\s*["`]?_zz_locked["`]?\s*\)/i.test(q)) throw new Error("not authorized: SQLITE_AUTH");
            return t.exec(q, ...p);
          };
          const v = t[k];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });

      let lines: string[] = [];
      await expect((async () => { lines = await warnLines(() => initializeSchema(refusing, env)); })(), "boot never fails").resolves.toBeUndefined();

      // (a) the other table is still checked
      expect(unclassifiedLines(lines).join("\n"), `warn lines: ${lines.join(" | ")}`).toContain("_zz_probe.password");
      // (b) the unreadable table is a finding in its own right
      expect(lines.some((l) => l.includes("_zz_locked")), `warn lines: ${lines.join(" | ")}`).toBe(true);
      // ...while the platform's own refused table is never reported as a finding.
      expect(lines.some((l) => l.includes("_cf_METADATA"))).toBe(false);
    });
  });
});
