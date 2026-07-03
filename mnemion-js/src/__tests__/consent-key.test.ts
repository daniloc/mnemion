// The consent round-trip's key is constructed from (pattern, operation, data).
// The data fold is load-bearing: without it, an agent could arm consent on a
// benign payload (e.g. visibility: private) and then re-issue the SAME pattern/op
// with a harmful payload (visibility: public) to satisfy the gate. The session
// handler used to build the key inline, with no unit covering the binding; this
// oracle locks the construction to (pattern, op, data) so a refactor that drops
// any of the three fails loudly instead of opening a consent-bypass.
import { describe, it, expect } from "vitest";
import { consentKey } from "../../entities/Hive/mutate-gate";

describe("consentKey — round-trip key construction", () => {
  it("is deterministic for identical inputs", () => {
    const a = consentKey("_publications", "create", { path: "x", visibility: "public" });
    const b = consentKey("_publications", "create", { path: "x", visibility: "public" });
    expect(a).toBe(b);
  });

  it("is property-order INSENSITIVE: same logical data with different insertion order produces the same key", () => {
    // Without sorted-key serialization, an agent re-issuing the identical call
    // but reconstructing the object would arm a fresh round-trip instead of
    // confirming — a usability and a security bug (a different ordering could
    // also bypass an in-flight arming for a benign payload).
    const a = consentKey("_publications", "create", { path: "x", visibility: "public" });
    const b = consentKey("_publications", "create", { visibility: "public", path: "x" });
    expect(a).toBe(b);
  });

  it("is property-order INSENSITIVE in NESTED objects too", () => {
    const a = consentKey("_pages", "create", { layout: { rows: 3, cols: 4 }, title: "t" });
    const b = consentKey("_pages", "create", { title: "t", layout: { cols: 4, rows: 3 } });
    expect(a).toBe(b);
  });

  it("namespaces consent rows with a `consent:` prefix so `_pending_consent` queries can't be confused for other keys", () => {
    expect(consentKey("_members", "create", { label: "alice" }).startsWith("consent:")).toBe(true);
  });

  it("binds the DATA: differing payloads on the same pattern/op produce different keys", () => {
    const benign  = consentKey("_publications", "create", { path: "x", visibility: "private" });
    const harmful = consentKey("_publications", "create", { path: "x", visibility: "public" });
    expect(benign).not.toBe(harmful);
  });

  it("binds the PATTERN: same op/data on a different pattern produces a different key", () => {
    const a = consentKey("A", "create", { x: 1 });
    const b = consentKey("B", "create", { x: 1 });
    expect(a).not.toBe(b);
  });

  it("binds the OPERATION: different op on the same pattern/data produces a different key", () => {
    const a = consentKey("_members", "create", { id: 1 });
    const b = consentKey("_members", "update", { id: 1 });
    expect(a).not.toBe(b);
  });

  it("does NOT conflate two consent armings whose data differs only in one harmful facet", () => {
    // The pilot scenario: arm consent for a benign create, then attempt to redeem
    // it for an escalating create. The key must differ so the second call starts
    // a fresh round-trip rather than consuming the benign arming.
    const armed   = consentKey("_documents", "create", { title: "x", visibility: "private" });
    const escalate = consentKey("_documents", "create", { title: "x", visibility: "public" });
    expect(armed).not.toBe(escalate);
  });
});
