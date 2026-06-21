// === SQL identifier chokepoint ===
//
// @why The ONE transition map: raw string → SQL identifier. Values are always
// bound (`?`); identifiers (table/column/facet names) can't be bound, so they're
// interpolated as double-quoted identifiers (`"name"`). That interpolation is the
// one injection escape in the engine. This module fuses validation and quoting
// into a single call so the boundary can't be half-crossed: a caller can't quote
// without validating, and a raw unvalidated identifier physically can't reach SQL
// through it. Upstream semantic checks (facetMeta / isValidColumn / patternExists /
// KERNEL_COLUMN_SET) STAY — quoteIdent is defense-in-depth beneath them, the
// fail-closed last line. An injection-bearing identifier (quotes, spaces,
// semicolons, `--`) doesn't match the grammar and THROWS here, even if every
// upstream check were forgotten.

import { IDENTIFIER_RE } from "./constants";

/**
 * Validate `name` against the canonical identifier grammar (IDENTIFIER_RE) and
 * return it as a SQLite double-quoted identifier (`"name"`). Throws on any name
 * that doesn't match — the grammar admits pattern names, facet names, and the
 * snake_case kernel columns (created_by/updated_at/…), and nothing else.
 *
 * Use this for EVERY SQL identifier interpolation. Never interpolate a raw
 * `"${name}"` into SQL.
 */
export function quoteIdent(name: string): string {
  if (typeof name !== "string" || !IDENTIFIER_RE.test(name))
    throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  return `"${name}"`;
}
