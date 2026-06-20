// Totality for the pattern-effects registry (effects.ts).
//
// The side-effecting orchestration that used to be a per-pattern if-pile inside
// mutate() (`if (patternName === "_documents") …`) now lives in PATTERN_EFFECTS.
// The DOMAIN is the live, feature-composed registry itself — `composeEffects(FEATURES)`
// folds every feature's effects into PATTERN_EFFECTS, so iterating its keys means a
// new feature effect auto-joins the totality (no hand-list of pattern names to forget
// to update — the false-oracle this test previously was). It guards: the registry is
// composed (non-empty), and mutate() hasn't re-grown an inline branch for any of its
// patterns (the failure mode the registry prevents).
import { describe, it, expect } from "vitest";
import hiveSrc from "../../entities/Hive/hive.ts?raw";
import { PATTERN_EFFECTS } from "../../entities/Hive/effects";

// The live domain: every pattern the composed registry actually keys an effect on.
const EFFECT_PATTERNS = Object.keys(PATTERN_EFFECTS);

describe("pattern-effects totality", () => {
  it("the effects registry is composed (non-empty) from features", () => {
    expect(EFFECT_PATTERNS.length).toBeGreaterThan(0);
  });

  it("no effect-bearing pattern is ALSO inlined as a mutate() branch (the registry is its sole home)", () => {
    for (const p of EFFECT_PATTERNS) {
      expect(hiveSrc, `pattern "${p}" must not also have an inline effect branch`).not.toContain(`patternName === "${p}"`);
    }
  });
});
