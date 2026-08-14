// Boot idempotence — the oracle for "waking a hibernated hive costs nothing".
//
// initializeSchema runs in the HiveDO CONSTRUCTOR, i.e. on every cold start /
// wake from hibernation, not once per deploy. Anything it writes unconditionally
// is multiplied by the cold-start rate, which is driven by client reconnects and
// is entirely outside the owner's control. The observed failure: ~90% of the
// 100k/day Durable Objects rows_written free-tier cap consumed on a day with SIX
// agent writes, because reconciliation (the _objects doctrine upsert + the
// drop-and-recreate of every audit trigger) ran unconditionally on every wake.
//
// The invariant: a boot that reconciles nothing writes nothing. This is the
// totality oracle for it — it measures ACTUAL rows written by a second
// initializeSchema over an already-initialized hive, so it fails on any newly
// added unconditional write regardless of which line introduced it.
import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { getStore, createPattern } from "./helpers";
import { initializeSchema } from "../../entities/Hive/schema";

/** Wrap a SqlStorage so every exec() accumulates its rowsWritten. */
function countingSql(sql: any): { db: any; written: () => number; culprits: () => string[] } {
  let written = 0;
  const culprits: string[] = [];
  const db = new Proxy(sql, {
    get(target, prop, receiver) {
      if (prop === "exec") {
        return (...args: any[]) => {
          const cursor = target.exec(...args);
          const n = cursor.rowsWritten ?? 0;
          written += n;
          if (n > 0) culprits.push(`${n}× ${String(args[0]).replace(/\s+/g, " ").slice(0, 110)}`);
          return cursor;
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db, written: () => written, culprits: () => culprits };
}

// One boot is allowed to do work — that is what reconciliation and the GC sweeps
// are FOR, and a schema change legitimately costs one settling pass. The
// pathology was a boot that pays that cost EVERY time, forever. So the invariant
// is quiescence: after one settling boot, the next writes nothing.
async function writesOnSecondBoot(store: any): Promise<string[]> {
  return await runInDurableObject(store, async (_i: any, state: any) => {
    initializeSchema(state.storage.sql, {}); // settle
    const { db, culprits } = countingSql(state.storage.sql);
    initializeSchema(db, {});
    return culprits();
  });
}

describe("boot idempotence", () => {
  it("a re-boot over an unchanged schema writes zero rows", async () => {
    const store = getStore();
    await store.getIndex(); // force construction (and the first initializeSchema)
    expect(await writesOnSecondBoot(store), "quiescent boot wrote rows").toEqual([]);
  });

  it("stays quiescent with user patterns present", async () => {
    const store = getStore();
    await createPattern(store, "notes", [{ name: "body", type: "text" }]);
    expect(await writesOnSecondBoot(store), "quiescent boot wrote rows").toEqual([]);
  });

  it("the counter is real: a first boot on a virgin db does write", async () => {
    // Guards the oracle itself — a proxy that silently counted nothing would
    // make both assertions above vacuously true.
    const id = env.MNEMION_HIVE.idFromName(`user:test:${crypto.randomUUID()}`);
    const store = env.MNEMION_HIVE.get(id);
    await store.getIndex();

    await runInDurableObject(store, async (_i, state) => {
      const { db, written } = countingSql(state.storage.sql);
      db.exec(`CREATE TABLE IF NOT EXISTS _boot_probe (id INTEGER PRIMARY KEY, v TEXT)`);
      db.exec(`INSERT INTO _boot_probe (v) VALUES ('x')`);
      expect(written()).toBeGreaterThan(0);
    });
  });
});
