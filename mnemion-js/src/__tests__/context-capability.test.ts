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
});
