// Fork-contract regression + totality tests for the feature composers (compose.ts).
//
// Each composer is a CHOKEPOINT for a fork foot-gun: a mis-declared feature must
// fail LOUD/CLOSED at compose time, not boot clean and silently misbehave. These
// tests drive the composers directly with synthetic Feature objects (the live domain
// is the composer function itself) — they don't boot the worker.
import { describe, it, expect } from "vitest";
import {
  composeRoutes,
  composePatterns,
  composeMigrations,
  assertWiredSlots,
} from "../../entities/features/compose";
import type { Feature, FeaturePattern, FeatureMigration } from "../../entities/features/feature";
import { Auth } from "../../shared/Routing/router";

// Reusable bits.
const VALID_AUTH = new Set<string>(Object.values(Auth));
const NO_CORE = new Set<string>();
const okHandler = () => new Response("ok");
const validPattern = (name: string): FeaturePattern => ({
  name,
  description: "x",
  doctrine: "x",
  ddl: `CREATE TABLE ${name} (id INTEGER)`,
  facets: [],
});
const feat = (over: Partial<Feature>): Feature => ({ name: "synthetic", ...over });

// ── BUG 1: feature-route auth must be a valid Auth VALUE (fail closed) ──────────
describe("composeRoutes — auth validation (fail closed)", () => {
  it("rejects a feature route with a bogus auth string", () => {
    const f = feat({
      routes: [{ method: "GET", pattern: "/x", auth: "SESSION" /* member name, not value */, handler: okHandler }],
    });
    expect(() => composeRoutes([f], { validAuthValues: VALID_AUTH, coreRouteKeys: NO_CORE }))
      .toThrow(/invalid auth/);
  });

  it("rejects a typo'd / wrong-cased auth (would otherwise resolve to Auth.NONE)", () => {
    for (const bad of ["Session", "SECRET", "admin", "none ", ""]) {
      const f = feat({ routes: [{ method: "GET", pattern: "/x", auth: bad, handler: okHandler }] });
      expect(() => composeRoutes([f], { validAuthValues: VALID_AUTH, coreRouteKeys: NO_CORE }),
        `auth "${bad}" should be rejected`).toThrow();
    }
  });

  it("accepts EVERY real Auth enum value", () => {
    for (const v of Object.values(Auth)) {
      const f = feat({ routes: [{ method: "GET", pattern: "/x", auth: v, handler: okHandler }] });
      expect(() => composeRoutes([f], { validAuthValues: VALID_AUTH, coreRouteKeys: NO_CORE }),
        `auth "${v}" should be accepted`).not.toThrow();
    }
  });

  it("accepts an omitted auth (undefined → NONE is the intended default)", () => {
    const f = feat({ routes: [{ method: "GET", pattern: "/x", handler: okHandler }] });
    expect(() => composeRoutes([f], { validAuthValues: VALID_AUTH, coreRouteKeys: NO_CORE })).not.toThrow();
  });
});

// ── BUG 3 (routes): a feature route must not shadow a CORE route ────────────────
describe("composeRoutes — core-route shadow rejection", () => {
  const CORE = new Set<string>(["GET /api/index", "POST /api/mutate/:pattern"]);

  it("rejects a feature route that matches a CORE method+pattern (would be silently dead)", () => {
    const f = feat({ routes: [{ method: "GET", pattern: "/api/index", handler: okHandler }] });
    expect(() => composeRoutes([f], { validAuthValues: VALID_AUTH, coreRouteKeys: CORE }))
      .toThrow(/shadows core/);
  });

  it("allows a feature route that does NOT collide with core", () => {
    const f = feat({ routes: [{ method: "GET", pattern: "/feature/thing", handler: okHandler }] });
    expect(() => composeRoutes([f], { validAuthValues: VALID_AUTH, coreRouteKeys: CORE })).not.toThrow();
  });

  it("still rejects feature-vs-feature method+pattern collisions", () => {
    const a = feat({ name: "a", routes: [{ method: "GET", pattern: "/dup", handler: okHandler }] });
    const b = feat({ name: "b", routes: [{ method: "GET", pattern: "/dup", handler: okHandler }] });
    expect(() => composeRoutes([a, b], { validAuthValues: VALID_AUTH, coreRouteKeys: NO_CORE }))
      .toThrow(/collision/);
  });
});

// ── BUG 4: feature pattern names must be "_"-prefixed (no namespace escape) ─────
describe("composePatterns — kernel namespace enforcement", () => {
  it("rejects an unprefixed feature pattern name (would read as an agent-writable User pattern)", () => {
    const f = feat({ patterns: [validPattern("widgets")] });
    expect(() => composePatterns([f])).toThrow(/namespace escape/);
  });

  it("rejects a bare underscore / malformed kernel name", () => {
    for (const bad of ["_", "_Bad", "_has space", "1_x"]) {
      const f = feat({ patterns: [validPattern(bad)] });
      expect(() => composePatterns([f]), `pattern "${bad}" should be rejected`).toThrow();
    }
  });

  it("accepts a well-formed kernel pattern name", () => {
    const f = feat({ patterns: [validPattern("_widgets")] });
    expect(() => composePatterns([f])).not.toThrow();
  });
});

// ── BUG 3 (migrations): feature-vs-feature version uniqueness ───────────────────
// (feature-vs-core share one version space BY DESIGN — `documents` owns v12 from the
// core pile — so only feature-vs-feature is machine-checkable here.)
describe("composeMigrations — feature-vs-feature version uniqueness", () => {
  const mig = (version: number): FeatureMigration => ({ version, label: "m", apply: () => {} });

  it("rejects two features claiming the same version slot", () => {
    const a = feat({ name: "a", migrations: [mig(1500)] });
    const b = feat({ name: "b", migrations: [mig(1500)] });
    expect(() => composeMigrations([a, b])).toThrow(/version collision/);
  });

  it("accepts distinct versions (incl. low ones a feature legitimately owns)", () => {
    const f = feat({ migrations: [mig(12), mig(1500)] });
    expect(() => composeMigrations([f])).not.toThrow();
    expect(composeMigrations([f]).map((m) => m.version)).toEqual([12, 1500]); // sorted
  });
});

// ── BUG 2: declaring an UNWIRED slot must fail loud, not no-op ──────────────────
describe("assertWiredSlots — unwired slot is loud", () => {
  it("throws when a feature declares `tools` (slot not wired into session.ts)", () => {
    const f = feat({ tools: [{ name: "t", description: "d", when: "w" }] });
    expect(() => assertWiredSlots([f])).toThrow(/tools slot is not yet wired/);
  });

  it("throws when a feature declares `systemDocs` (slot not wired into schema.ts)", () => {
    const f = feat({ systemDocs: [{ slug: "s", title: "T", body: "b" }] });
    expect(() => assertWiredSlots([f])).toThrow(/systemDocs slot is not yet wired/);
  });

  it("does not throw for a feature that touches only wired slots", () => {
    const f = feat({ patterns: [validPattern("_ok")], routes: [{ method: "GET", pattern: "/ok", handler: okHandler }] });
    expect(() => assertWiredSlots([f])).not.toThrow();
  });

  it("the LIVE feature set declares no unwired slots (the real config stays clean)", async () => {
    const { FEATURES } = await import("../../entities/features");
    expect(() => assertWiredSlots(FEATURES)).not.toThrow();
  });
});
