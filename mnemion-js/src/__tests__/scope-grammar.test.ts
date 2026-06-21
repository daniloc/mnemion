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
