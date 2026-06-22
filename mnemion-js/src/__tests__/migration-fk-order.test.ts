// Regression for issue #10: a metadata-cleanup migration that deletes the parent
// _objects row before the child _fields rows trips `FOREIGN KEY constraint failed`
// (_fields.object_name REFERENCES _objects(name)). The throw escapes
// initializeSchema — which runs inside the HiveDO ctor's blockConcurrencyWhile — so
// construction rejects and every subsequent RPC 500s, bricking any UPGRADED hive
// that actually held the legacy rows. Fresh hives have neither row, so the wrong
// order is silently harmless on a clean DB (why CI missed it). This test seeds the
// legacy rows the way a real upgrade would, then re-runs the migration and asserts
// boot survives and the rows are gone — it fails on a parent-before-child delete.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";
import { initializeSchema } from "../../entities/Hive/schema";

function getStore(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName(`fkmig:${crypto.randomUUID()}`);
  return env.MNEMION_HIVE.get(id);
}

// Seed the parallel _objects/_fields metadata for a retired kernel pattern, exactly
// as a pre-migration hive would carry it (parent first to satisfy the FK on insert).
function seedLegacyPattern(sql: any, name: string) {
  sql.exec(`INSERT INTO _objects (name, description, doctrine) VALUES (?, '', '')`, name);
  sql.exec(`INSERT INTO _fields (object_name, name, type) VALUES (?, 'snapshot', 'text')`, name);
}
const count = (sql: any, table: "_objects" | "_fields", col: string, name: string): number =>
  (sql.exec(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, name).one() as { n: number }).n;

describe("issue #10 — metadata-cleanup migrations delete children before parents", () => {
  it("re-running initializeSchema on a hive carrying legacy _canvases rows boots and cleans them up", async () => {
    const store = getStore();
    await runInDurableObject(store, (_i, state) => {
      const sql = state.storage.sql;
      // simulate a pre-v16 hive that had Canvas
      seedLegacyPattern(sql, "_canvases");
      expect(count(sql, "_objects", "name", "_canvases")).toBe(1);
      expect(count(sql, "_fields", "object_name", "_canvases")).toBe(1);

      // the migration runs every boot — re-running it must not throw on the FK...
      expect(() => initializeSchema(sql, env)).not.toThrow();

      // ...and must leave no agent-facing trace of the retired pattern.
      expect(count(sql, "_objects", "name", "_canvases")).toBe(0);
      expect(count(sql, "_fields", "object_name", "_canvases")).toBe(0);
    });
  });

  it("the same holds for the v5 token-table consolidation (the site #10 pointed back to)", async () => {
    const store = getStore();
    await runInDurableObject(store, (_i, state) => {
      const sql = state.storage.sql;
      for (const t of ["_auth_codes", "_upload_tokens", "_marketplace_tokens"]) seedLegacyPattern(sql, t);

      expect(() => initializeSchema(sql, env)).not.toThrow();

      for (const t of ["_auth_codes", "_upload_tokens", "_marketplace_tokens"]) {
        expect(count(sql, "_objects", "name", t)).toBe(0);
        expect(count(sql, "_fields", "object_name", t)).toBe(0);
      }
    });
  });
});
