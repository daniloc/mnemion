// Capability-totality for the kernel read/write boundary.
//
// The engine (data.ts) requires `trusted` with no default and fails CLOSED. The
// one spot that historically re-opened it was HiveDO's convenience factory
// `dataCtx(actor, trusted = true)` — which turned the trust decision into a
// per-call-site CONVENTION (`dataCtx()` vs `servedDataCtx()`) a new serve/ingress
// path could silently get wrong. The factory was split into two NAMED capability
// constructors with no trust parameter, so trust is fixed by which constructor you
// are handed, not dialed at the call site. This guards that the split can't rot
// back into a trust-parameterized factory.
import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { HiveDO } from "../../entities/Hive/hive";
import hiveSrc from "../../entities/Hive/hive.ts?raw";

describe("context-capability totality", () => {
  it("has no trust-parameterized context factory (the old dataCtx default is gone)", () => {
    expect(hiveSrc).not.toMatch(/\bdataCtx\s*\(/);          // the old name is fully retired
    expect(hiveSrc).not.toMatch(/trusted\s*:\s*boolean\s*=/); // no defaulted trust param
  });

  it("no call site dials trust with a boolean argument", () => {
    // trust is fixed by the named constructor, never passed at the call site.
    expect(hiveSrc).not.toMatch(/DataCtx\([^)]*,\s*(?:true|false)/);
  });

  it("provides exactly the two named capability constructors", () => {
    expect(hiveSrc).toMatch(/private ownerDataCtx\(/);
    expect(hiveSrc).toMatch(/private servedDataCtx\(/);
  });

  // SEMANTIC anchor (the source-grep tests above guard the SHAPE; this guards the
  // runtime VALUE). The served/ingress write path is built on servedDataCtx, whose
  // whole point is `trusted: false`. Drive the real ingress chokepoint
  // (processInput → servedDataCtx → executeMutate) against a KERNEL target and
  // require the refusal to come from the CAPABILITY gate itself — identified by its
  // unique message. If servedDataCtx ever returns `trusted: true`, this write is no
  // longer refused there (it proceeds into the kernel, succeeding or failing with a
  // DIFFERENT message), and this assertion fails. The shape tests cannot catch that
  // inversion; this one does.
  it("an untrusted ingress write to a kernel pattern is refused AT the capability gate", async () => {
    const store = env.MNEMION_HIVE.get(
      env.MNEMION_HIVE.idFromName(`user:capsem:${crypto.randomUUID()}`),
    ) as DurableObjectStub<HiveDO>;

    // Ingress endpoint pointed at a kernel pattern (_members). A public, unauth POST
    // here runs below the consent layer through servedDataCtx.
    await runInDurableObject(store, async (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO "_inputs" (path, target_pattern, body_facet, visibility) VALUES ('kx','_members','label','public')`,
      );
    });

    const result = JSON.parse(await store.processInput("kx", "intruder", "{}", "{}"));
    expect(result.error).toBe(true);
    // The refusal must be the capability gate's, not some downstream kernel hook.
    expect(result.message).toMatch(/not a writable user pattern/);
  });
});
