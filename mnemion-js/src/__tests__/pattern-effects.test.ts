// Totality for the pattern-effects registry (effects.ts).
//
// The side-effecting orchestration that used to be a per-pattern if-pile inside
// mutate() (`if (patternName === "_documents") …`) now lives in PATTERN_EFFECTS.
// This guards both halves: every effect-bearing pattern is registered, AND mutate()
// hasn't re-grown an inline branch for one (the failure mode the registry prevents).
import { describe, it, expect } from "vitest";
import hiveSrc from "../../entities/Hive/hive.ts?raw";
import { PATTERN_EFFECTS } from "../../entities/Hive/effects";

const EFFECT_PATTERNS = ["_documents", "_pages", "_system_tasks"];

describe("pattern-effects totality", () => {
  it("registers an effect for every effect-bearing pattern", () => {
    for (const p of EFFECT_PATTERNS) expect(PATTERN_EFFECTS[p]).toBeDefined();
  });

  it("mutate() no longer inlines a pattern-specific effect branch", () => {
    for (const p of EFFECT_PATTERNS) {
      expect(hiveSrc).not.toContain(`patternName === "${p}"`);
    }
  });
});
