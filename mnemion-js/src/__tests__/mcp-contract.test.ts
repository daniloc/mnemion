import { describe, it, expect } from "vitest";
import { CHANGE_TYPE_NAMES } from "../../entities/Hive/evolution";
import { consentRoundTripRequired } from "../../entities/Hive/policy";

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
