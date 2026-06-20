// Product identity — single source of truth for the URI scheme and product name.
// Import from here instead of hardcoding "mnemion://" in string literals.

export const PRODUCT_NAME = "Mnemion";
export const URI_SCHEME = "mnemion";
export const URI_PREFIX = `${URI_SCHEME}://`;

/** Build a full URI from a path, e.g. uri("index") → "mnemion://index" */
export function uri(path: string): string {
  return `${URI_PREFIX}${path}`;
}

// === Identifier rule ===
//
// The canonical pattern/facet-name rule (CLAUDE.md "propose_change"): must start
// with a lowercase letter or underscore, then only a-z, 0-9, hyphens, underscores.
// Case-sensitive (identifiers are lowercase). This is the SINGLE home for the
// agent-facing identifier shape — pattern names, facet names, and any user-supplied
// identifier interpolated into DDL/SQL (which can't be bound, so it must be
// confirmed to match this rule before quoting). Note: SQL aggregate *aliases* use a
// deliberately different rule (case-insensitive, no hyphen — see data.ts ALIAS_RE);
// don't fold that one in here.
export const IDENTIFIER_RE = /^[a-z_][a-z0-9_-]*$/;

// === Hex token rule ===
//
// Route-param guard for hex-encoded capability tokens (invite, upload, document
// upload). Variable-length: any run of hex digits. One home so the five route
// rows that gate a `:token` param share the same shape. The fixed-length
// variant (/^[a-fA-F0-9]{32}$/) is a DIFFERENT rule (exact length) and stays
// inline at its single call site.
export const HEX_TOKEN_RE = /^[a-fA-F0-9]+$/;

// === Hive identity ===
//
// Mnemion is single-hive-per-deploy: one shared store that one or more members
// authenticate into. The hive's location (which Durable Object) is stable and
// independent of who logs in — "which hive" and "who am I" are separate
// concerns. HIVE_ID names the store; the actor (a member label) names the
// person, carried separately in the session props.
//
// The literal stays "user:owner" so existing single-owner deploys keep their
// data: this is a rename for clarity, not a re-key. New deploys land on the
// same DO name.
export const HIVE_ID = "user:owner";

// The sentinel member every hive has. The bootstrap passkey (registered with
// the master secret) and any member-less legacy token resolve to this actor.
// Always active; never suspended.
export const OWNER_ACTOR = "owner";
