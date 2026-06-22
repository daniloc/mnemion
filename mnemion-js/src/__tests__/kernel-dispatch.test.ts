// applyKernelRules dispatch — a pattern that declares BOTH an ON_CREATE and an
// ON_WRITE hook runs BOTH on a create, with the create hook's transform visible
// to the write hook.
//
// The fork contract gives every feature both an onCreate and an onWrite slot.
// The dispatch used to RETURN after ON_CREATE on a create, so a pattern declaring
// both would silently SKIP its onWrite validation at create time — latent today
// (no CORE/feature pattern declares both) but a footgun the moment one does. The
// fix chains them: on create, ON_CREATE runs first, its transformed data feeds
// ON_WRITE, and an ON_CREATE error short-circuits before ON_WRITE.
//
// We prove the fall-through by injecting a SYNTHETIC pattern into the live
// ON_CREATE / ON_WRITE registries (plain exported records) for the duration of a
// test, then removing it — so the assertion exercises the real applyKernelRules
// chokepoint without altering kernel.ts exports. The existing single-hook
// patterns (_views = onWrite-only, _access_tokens = onCreate-only) are asserted
// unaffected.
import { describe, it, expect, afterEach } from "vitest";
import {
  ON_CREATE,
  ON_WRITE,
  applyKernelRules,
  type KernelContext,
  type CreateHook,
  type WriteHook,
} from "../../entities/Hive/kernel";

const ctx: KernelContext = {
  patternExists: () => true,
  facetMeta: () => ({ type: "text" }),
  patternClass: () => "knowledge",
  entryExists: () => true,
  memberActive: () => true,
  entryField: () => null,
};

function isError(r: unknown): r is { error: true; message: string } {
  return !!r && typeof r === "object" && (r as { error?: unknown }).error === true;
}

// Synthetic pattern name that no real registry uses.
const SYNTH = "_synthetic_both_hooks";

// Track every key we inject so cleanup is total even if an assertion throws.
const injected: { create: boolean; write: boolean } = { create: false, write: false };

function injectCreate(hook: CreateHook): void {
  (ON_CREATE as Record<string, CreateHook>)[SYNTH] = hook;
  injected.create = true;
}
function injectWrite(hook: WriteHook): void {
  (ON_WRITE as Record<string, WriteHook>)[SYNTH] = hook;
  injected.write = true;
}

afterEach(() => {
  if (injected.create) delete (ON_CREATE as Record<string, CreateHook>)[SYNTH];
  if (injected.write) delete (ON_WRITE as Record<string, WriteHook>)[SYNTH];
  injected.create = false;
  injected.write = false;
});

describe("applyKernelRules dispatch — onCreate THEN onWrite on create", () => {
  it("(a) the create hook's transform is visible to the write hook on create", () => {
    // ON_CREATE stamps a derived field (mirrors _access_tokens setting expires_at).
    injectCreate((data) => ({ ...data, stamped: "by-create" }));
    // ON_WRITE only succeeds if it can SEE that stamped field — proving chaining.
    let seenByWrite: unknown = "WRITE_DID_NOT_RUN";
    injectWrite((data) => {
      seenByWrite = (data as Record<string, unknown>).stamped;
      return data;
    });

    const r = applyKernelRules(SYNTH, "create", { name: "x" }, ctx);
    expect(isError(r)).toBe(false);
    // onWrite ran on the create, and saw the create hook's transform.
    expect(seenByWrite).toBe("by-create");
    // The final result carries the create transform through.
    expect((r as Record<string, unknown>).stamped).toBe("by-create");
    expect((r as Record<string, unknown>).name).toBe("x");
  });

  it("(b) an onWrite validation FAILS a create the onCreate accepted", () => {
    // onCreate is happy and even shapes the row...
    injectCreate((data) => ({ ...data, shaped: true }));
    // ...but onWrite rejects the (now-shaped) payload. Pre-fix this never ran on
    // create, so this invalid create would have slipped through.
    injectWrite((data) => {
      if ((data as Record<string, unknown>).shaped !== "expected-value") {
        return { error: true, message: "onWrite rejected the create" };
      }
      return data;
    });

    const r = applyKernelRules(SYNTH, "create", { name: "x" }, ctx);
    expect(isError(r)).toBe(true);
    if (isError(r)) expect(r.message).toBe("onWrite rejected the create");
  });

  it("an onCreate error short-circuits BEFORE onWrite runs", () => {
    injectCreate(() => ({ error: true, message: "onCreate rejected" }));
    let writeRan = false;
    injectWrite((data) => {
      writeRan = true;
      return data;
    });

    const r = applyKernelRules(SYNTH, "create", { name: "x" }, ctx);
    expect(isError(r)).toBe(true);
    if (isError(r)) expect(r.message).toBe("onCreate rejected");
    expect(writeRan, "onWrite must not run when onCreate errors").toBe(false);
  });

  it("on a NON-create op (update), only onWrite runs; onCreate is skipped", () => {
    let createRan = false;
    injectCreate((data) => {
      createRan = true;
      return data;
    });
    let writeRan = false;
    injectWrite((data) => {
      writeRan = true;
      return data;
    });

    applyKernelRules(SYNTH, "update", { name: "x" }, ctx);
    expect(createRan, "onCreate must not run on update").toBe(false);
    expect(writeRan, "onWrite must run on update").toBe(true);
  });
});

describe("applyKernelRules dispatch — existing single-hook patterns unaffected", () => {
  it("_views (onWrite-only) still validates on create", () => {
    // A valid board view spec should pass; an invalid view_type should fail.
    // (Exercises the real CORE_ON_WRITE._views hook — no synthetic injection.)
    const ok = applyKernelRules(
      "_views",
      "create",
      { pattern: "anything", view_type: "list" },
      ctx,
    );
    expect(isError(ok)).toBe(false);

    const bad = applyKernelRules(
      "_views",
      "create",
      { pattern: "anything", view_type: "not-a-real-view-type" },
      ctx,
    );
    expect(isError(bad)).toBe(true);
  });

  it("_access_tokens (onCreate-only) still transforms on create (sets expires_at)", () => {
    // A wildcard token (born-hashed 64-hex digest) gets a default 60-min expiry
    // stamped by the create hook.
    const token = "a".repeat(64);
    const r = applyKernelRules(
      "_access_tokens",
      "create",
      { scope: "*", token },
      ctx,
    );
    expect(isError(r)).toBe(false);
    // The create hook stamps a default expiry — proving onCreate still runs and
    // its transform survives (no onWrite to chain into for this pattern).
    expect((r as Record<string, unknown>).expires_at).toBeTruthy();
  });
});
