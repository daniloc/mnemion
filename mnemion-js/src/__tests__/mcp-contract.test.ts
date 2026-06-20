import { describe, it, expect } from "vitest";
import { CHANGE_TYPE_NAMES } from "../../entities/Hive/evolution";
import { consentRoundTripRequired } from "../../entities/Hive/policy";
import {
  mutateGate, findGatedBatchOp, normalizeMutateData, isSingleOpData,
} from "../../entities/Hive/mutate-gate";

// Guards the MCP agent surface (entities/Session/session.ts) against drifting
// from the engine — the gap a web-/api or RPC test can't see, because the MCP
// tool layer has its own Zod schemas + consent gates above the engine.
//
// The live end-to-end version is `npm run mcp:smoke` (drives /mcp via the MCP
// SDK against a running dev worker). These are the no-worker regression guards.

describe("propose_change MCP enum derives from the engine", () => {
  // The tool's change.type enum is z.enum(CHANGE_TYPE_NAMES). If a change type
  // exists in CHANGE_TYPES but not here, agents can't reach it through MCP — the
  // exact bug set_facet_format hit (Zod-rejected before the engine ran).
  it("includes set_facet_format (regression: was absent from the MCP enum)", () => {
    expect(CHANGE_TYPE_NAMES).toContain("set_facet_format");
  });

  it("exposes the full known change-type surface", () => {
    for (const t of [
      "create_pattern", "add_facet", "set_sharing", "set_options", "set_doctrine",
      "set_memory_policy", "set_class", "set_facet_format", "archive_pattern", "unarchive_pattern",
    ]) {
      expect(CHANGE_TYPE_NAMES).toContain(t);
    }
  });

  it("has no empty/duplicate entries", () => {
    expect(new Set(CHANGE_TYPE_NAMES).size).toBe(CHANGE_TYPE_NAMES.length);
    expect(CHANGE_TYPE_NAMES.every((n) => typeof n === "string" && n.length > 0)).toBe(true);
  });
});

describe("view/format authoring is reachable in one MCP call", () => {
  it("mutate _views is not consent-round-trip-gated", () => {
    expect(consentRoundTripRequired("_views", "create", { pattern: "notes", view_type: "table" })).toBe(false);
    expect(consentRoundTripRequired("_views", "update", { id: 1, config: "{}" })).toBe(false);
  });
});

// The shared mutate-gate predicates the MCP handler now drives off (and any
// future write transport must reuse). Their being a pure, tested home is what
// keeps the gating DECISION from drifting between the MCP tool and the engine.
describe("mutate-gate: shared write-gating decisions", () => {
  it("passes user-pattern writes straight through (no gate)", () => {
    expect(mutateGate("notes", "create", { body: "hi" })).toEqual({ kind: "pass" });
    expect(mutateGate("notes", "patch", { id: 1 })).toEqual({ kind: "pass" });
  });

  it("rejects patch on a consent-gated pattern (bypass guard)", () => {
    expect(mutateGate("_federation_hosts", "patch", { host: "x" }).kind).toBe("patch_rejected");
    expect(mutateGate("_members", "patch", { id: 1 }).kind).toBe("patch_rejected");
  });

  it("requires the round-trip for escalating consent writes, carrying the policy message", () => {
    const g = mutateGate("_members", "create", { label: "alice", display_name: "Alice" });
    expect(g.kind).toBe("round_trip");
    if (g.kind === "round_trip") expect(g.policy.message).toMatch(/standing access/i);
  });

  it("does not round-trip archive (de-escalation) on a consent pattern", () => {
    expect(mutateGate("_members", "archive", { id: 1 })).toEqual({ kind: "pass" });
  });

  it("on_expose: gates only when the write exposes content (visibility-aware)", () => {
    // _documents is on_expose — private create is benign, public create gates.
    expect(mutateGate("_documents", "create", { title: "x", visibility: "private" })).toEqual({ kind: "pass" });
    expect(mutateGate("_documents", "create", { title: "x", visibility: "public" }).kind).toBe("round_trip");
  });

  it("findGatedBatchOp flags an escalating consent op inside a batch", () => {
    const batch = [
      { pattern: "notes", operation: "create", data: { body: "a" } },
      { pattern: "_members", operation: "create", data: { label: "bob" } },
    ];
    expect(findGatedBatchOp(batch)?.pattern).toBe("_members");
  });

  it("findGatedBatchOp flags a patch on a gated pattern but allows archive", () => {
    expect(findGatedBatchOp([{ pattern: "_shared", operation: "patch", data: { id: 1 } }])?.pattern).toBe("_shared");
    expect(findGatedBatchOp([{ pattern: "_shared", operation: "archive", data: { id: 1 } }])).toBeNull();
  });

  it("findGatedBatchOp returns null for an all-user-pattern batch", () => {
    expect(findGatedBatchOp([{ pattern: "notes", operation: "create", data: {} }])).toBeNull();
  });

  it("normalizeMutateData parses JSON strings, passes objects/garbage through", () => {
    expect(normalizeMutateData('{"a":1}')).toEqual({ a: 1 });
    expect(normalizeMutateData('[{"pattern":"notes"}]')).toEqual([{ pattern: "notes" }]);
    const obj = { a: 1 };
    expect(normalizeMutateData(obj)).toBe(obj);
    expect(normalizeMutateData("not json")).toBe("not json");
  });

  it("isSingleOpData accepts plain objects, rejects arrays/null/strings", () => {
    expect(isSingleOpData({ a: 1 })).toBe(true);
    expect(isSingleOpData([])).toBe(false);
    expect(isSingleOpData(null)).toBe(false);
    expect(isSingleOpData("x")).toBe(false);
  });
});
