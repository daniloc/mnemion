// Totality for the pattern-effects registry (effects.ts).
//
// The side-effecting orchestration that used to be a per-pattern if-pile inside
// mutate() (`if (patternName === "_documents") …`) now lives in PATTERN_EFFECTS.
// Each feature declares effect-bearing patterns separately from its effect handlers.
// The oracle compares that intent with the composed registry, so an omitted handler
// fails instead of disappearing from the domain. It also guards against mutate()
// regrowing an inline branch for one of those patterns.
import { describe, it, expect } from "vitest";
import hiveSrc from "../../entities/Hive/hive.ts?raw";
import { PATTERN_EFFECTS } from "../../entities/Hive/effects";
import { FEATURES } from "../../entities/features";

// The intended domain is declared separately from the implementation map.
const EFFECT_PATTERNS = FEATURES.flatMap((feature) => feature.effectPatterns ?? []);

describe("pattern-effects totality", () => {
  it("every declared effect-bearing pattern has a composed handler", () => {
    expect(EFFECT_PATTERNS.length).toBeGreaterThan(0);
    expect(new Set(EFFECT_PATTERNS).size).toBe(EFFECT_PATTERNS.length);
    for (const pattern of EFFECT_PATTERNS) {
      const handler = PATTERN_EFFECTS[pattern];
      expect(handler, `${pattern} must have a composed effect`).toBeDefined();
      expect(Boolean(handler.before || handler.after), `${pattern} must have a callable effect`).toBe(true);
    }
  });

  it("no effect-bearing pattern is ALSO inlined as a mutate() branch (the registry is its sole home)", () => {
    for (const p of EFFECT_PATTERNS) {
      expect(hiveSrc, `pattern "${p}" must not also have an inline effect branch`).not.toContain(`patternName === "${p}"`);
    }
  });
});
