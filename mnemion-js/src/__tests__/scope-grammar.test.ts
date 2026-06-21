// scopeMatches grammar — the token-authz prefix rule, pinned by a fixed matrix.
//
// `scopeMatches(tokenScope, requiredScope)` decides whether a bearer's scope
// grants a required capability. It is the chokepoint every token check routes
// through (OAuth session, /upload, /marketplace, federated read). Its ONE
// security-load-bearing property is the `:` BOUNDARY: a `read` token must grant
// `read:entry:axioms:7` but MUST NOT grant `readsecret`, `reading`, or `readwrite:x`
// — a bare string-prefix match (without the delimiter) would silently widen every
// scope. There were zero tests on this; this matrix proves the grammar so a
// refactor to `startsWith(tokenScope)` (no colon) fails loudly.
import { describe, it, expect } from "vitest";
import { scopeMatches } from "../../entities/Hive/kernel";
import { isBroadTokenScope } from "../../entities/Hive/policy";

describe("scopeMatches grammar", () => {
  // [tokenScope, requiredScope, expected]
  const MATRIX: Array<[string, string, boolean]> = [
    // `*` is the only wildcard — grants everything, anywhere.
    ["*", "read", true],
    ["*", "read:entry:axioms:7", true],
    ["*", "write:_members", true],
    ["*", "anything-at-all", true],

    // Exact match grants.
    ["read", "read", true],
    ["write", "write", true],
    ["upload", "upload", true],

    // Hierarchical grant ACROSS the `:` boundary (the legitimate widening).
    ["read", "read:entry:axioms:7", true],
    ["read", "read:entry", true],
    ["write", "write:_outputs", true],
    ["read:entry", "read:entry:axioms:7", true],

    // THE security property: prefix only counts at a `:` boundary. A `read` token
    // must NOT leak into sibling words that merely START with "read".
    ["read", "readsecret", false],
    ["read", "reading", false],
    ["read", "read-only", false],
    ["read", "readwrite:secret", false],
    ["write", "writeable", false],

    // Disjoint roots never match.
    ["read", "write", false],
    ["read", "write:x", false],
    ["upload", "read:entry:x", false],

    // A NARROWER token can't grant a BROADER requirement (no suffix/superset match).
    ["read:entry", "read", false],
    ["read:entry:axioms", "read:entry", false],

    // A non-wildcard token never grants the wildcard requirement.
    ["read", "*", false],
    ["read:entry", "*", false],
  ];

  it("matches each (token, required) pair per the : -boundary prefix rule", () => {
    for (const [token, required, expected] of MATRIX) {
      expect(
        scopeMatches(token, required),
        `scopeMatches("${token}", "${required}") should be ${expected}`,
      ).toBe(expected);
    }
  });

  it("the boundary is the delimiter, not a bare prefix (regression guard)", () => {
    // If the implementation ever drops the `+ ":"` and matches a bare prefix,
    // EVERY one of these flips to true — a silent privilege escalation.
    expect(scopeMatches("read", "readsecret")).toBe(false);
    expect(scopeMatches("read", "readwrite")).toBe(false);
    expect(scopeMatches("write", "writeanything")).toBe(false);
  });
});

// The consent dual of the scopeMatches grammar. `on_broad_token` lets NARROW
// target-bound scopes mint freely and round-trips BROAD ones; isBroadTokenScope
// is that classifier. It must be CONSISTENT with scopeMatches: a scope ruled
// NARROW may grant AT MOST one served leaf, never a whole pattern/class — or an
// injected agent mints a "narrow" master key with no human round-trip (the
// read:entry:<pattern> bug: 3 parts, classified narrow, yet scopeMatches grants
// it every read:entry:<pattern>:<id>).
describe("broad-token scope-grammar totality", () => {
  // The served resource grammar (the required-scope strings minted in
  // shared/Routing/routes/io.ts) plus the class/wildcard keys above them.
  // [scope, expectedBroad, note]
  const SHAPES: Array<[string, boolean, string]> = [
    // --- LEAF resource grants: name exactly one served resource → NARROW ---
    ["read:entry:axioms:7", false, "one shared entry (read:entry:<pattern>:<id>)"],
    ["read:output:feed", false, "one output (read:output:<path>)"],
    ["read:output:reports/2026/q2", false, "one output, slashed path"],
    ["read:publication:blog", false, "one publication (read:publication:<path>)"],
    ["read:document:42", false, "one document (read:document:<id>)"],
    ["write:input:webhook", false, "one ingress endpoint (write:input:<path>)"],

    // --- CLASS grants: name a whole subtree scopeMatches grants wholesale → BROAD ---
    ["read:entry:axioms", true, "THE BUG: a pattern-WIDE class key (every id in axioms)"],
    ["read:entry", true, "every entry in every pattern"],
    ["read:output", true, "every output"],
    ["read:publication", true, "every publication"],
    ["read:document", true, "every document"],
    ["write:input", true, "every ingress endpoint"],
    ["read", true, "the whole read class"],
    ["write", true, "the whole write class"],
    ["*", true, "full access — redeems as an owner login"],
    ["marketplace", true, "private marketplace git access"],

    // --- benign non-read/write scopes (target-bound / inert) → NARROW ---
    ["upload", false, "single-use upload, constraints frozen"],
    ["upload:x", false, "upload with a suffix, still target-bound"],
    ["document", false, "single-use document upload, constraints frozen"],
    ["document:x", false, "document with a suffix"],
    ["register", false, "minted inert, gated by /invite passkey approval"],

    // --- unknown / malformed shapes fail CLOSED (broad) ---
    ["", true, "empty string — unknown shape"],
    ["read:", true, "trailing-colon class key, no kind"],
    ["frobnicate", true, "unrecognized root"],
    ["read:entry:", true, "empty pattern segment — not a real leaf"],
  ];

  it("classifies every scope-grammar shape as the right broad/narrow verdict", () => {
    for (const [scope, expectedBroad, note] of SHAPES) {
      expect(
        isBroadTokenScope(scope),
        `isBroadTokenScope("${scope}") should be ${expectedBroad} — ${note}`,
      ).toBe(expectedBroad);
    }
  });

  it("the regression: read:entry:<pattern> is BROAD (a portable pattern-wide key)", () => {
    // This is the under-gate: 3 parts → the old `parts.length >= 3` cutoff called
    // it narrow, so it minted with NO consent round-trip, yet scopeMatches below
    // proves it grants EVERY entry id in the pattern.
    expect(isBroadTokenScope("read:entry:axioms")).toBe(true);
  });

  it("NARROW classification is consistent with scopeMatches — a narrow scope grants at most one served leaf", () => {
    // For every scope ruled NARROW, assert it does NOT grant a whole pattern/class
    // through scopeMatches' prefix rule. The proof: a narrow read/write scope must
    // NOT grant the class key one level up, and (for entry) must not grant a
    // sibling leaf under the same pattern.
    const narrowReadWrite = SHAPES.filter(
      ([scope, broad]) => !broad && /^(read|write):/.test(scope),
    ).map(([scope]) => scope);

    for (const scope of narrowReadWrite) {
      const parts = scope.split(":");
      // The class key one level up (drop the leaf segment) must NOT be granted —
      // if it were, the "narrow" scope would actually reach a whole class.
      const parentClass = parts.slice(0, -1).join(":");
      expect(
        scopeMatches(scope, parentClass),
        `narrow "${scope}" must NOT grant the broader class "${parentClass}"`,
      ).toBe(false);

      // And the BROAD pattern/class keys this leaf lives under must themselves be
      // classified broad — the contrapositive that closes the loop: anything that
      // grants this leaf-AND-more is gated.
      for (let depth = parts.length - 1; depth >= 1; depth--) {
        const ancestor = parts.slice(0, depth).join(":");
        if (ancestor === "upload" || ancestor === "document" || ancestor === "register") continue;
        expect(
          scopeMatches(ancestor, scope),
          `"${ancestor}" grants narrow "${scope}", so "${ancestor}" must be classified broad`,
        ).toBe(true);
        expect(
          isBroadTokenScope(ancestor),
          `"${ancestor}" grants narrow "${scope}" wholesale — it must round-trip (broad)`,
        ).toBe(true);
      }
    }
  });

  it("the matrix covers every served required-scope KIND in io.ts (no grammar shape unenumerated)", () => {
    // Reconcile against the resource kinds io.ts actually mints required scopes for.
    // If io.ts grows a new served kind, this list must too — and the SHAPES matrix
    // must enumerate both its leaf and class form — or the totality is incomplete.
    const SERVED_KINDS = ["entry", "output", "publication", "document", "input"];
    for (const kind of SERVED_KINDS) {
      const root = kind === "input" ? "write" : "read";
      const hasLeaf = SHAPES.some(([s, broad]) => !broad && s.startsWith(`${root}:${kind}:`));
      const hasClass = SHAPES.some(([s, broad]) => broad && s === `${root}:${kind}`);
      expect(hasLeaf, `SHAPES must enumerate a NARROW leaf for kind "${kind}"`).toBe(true);
      expect(hasClass, `SHAPES must enumerate a BROAD class key for kind "${kind}"`).toBe(true);
    }
  });
});
