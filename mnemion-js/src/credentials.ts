// Credential infrastructure: passkey storage + access token operations
//
// Pure functions that take a db accessor. HiveDO keeps thin RPC wrappers.
// Auth concerns separated from the cognitive substrate.

import { scopeMatches } from "./kernel";
import { OWNER_ACTOR } from "./constants";
export { scopeMatches };

type DB = { exec: (sql: string, ...params: any[]) => { toArray: () => any[]; one: () => any } };

// === Passkey storage ===
//
// One passkey per member (a member's `member` label, or NULL for the bootstrap
// owner credential). Several members each register their own credential, so the
// table holds many rows; re-registering a given member replaces only that
// member's row.

export interface StoredPasskeyRow {
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string;
  member: string | null;
}

export function hasPasskey(db: DB): boolean {
  return db.exec("SELECT 1 FROM _passkeys LIMIT 1").toArray().length > 0;
}

/** All registered passkeys — the authentication candidate set. */
export function getPasskeys(db: DB): StoredPasskeyRow[] {
  const rows = db.exec("SELECT * FROM _passkeys").toArray() as any[];
  return rows.map((r) => ({
    credential_id: r.credential_id,
    public_key: r.public_key,
    counter: r.counter,
    transports: r.transports,
    member: r.member ?? null,
  }));
}

/**
 * Store a member's passkey, replacing any existing credential for that same
 * member (per-member rotation — the original "single credential, replaced on
 * re-registration" semantic, now scoped to one member). `member` is the member
 * label, or null for the bootstrap owner credential.
 */
export function storePasskey(
  db: DB,
  credentialId: string,
  publicKey: string,
  counter: number,
  transports: string,
  member: string | null = null,
): void {
  if (member == null) {
    db.exec("DELETE FROM _passkeys WHERE member IS NULL");
  } else {
    db.exec("DELETE FROM _passkeys WHERE member = ?", member);
  }
  db.exec(
    "INSERT INTO _passkeys (member, credential_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)",
    member, credentialId, publicKey, counter, transports
  );
}

/** Bump the signature counter for a specific credential (clone detection). */
export function updatePasskeyCounter(db: DB, credentialId: string, counter: number): void {
  db.exec("UPDATE _passkeys SET counter = ? WHERE credential_id = ?", counter, credentialId);
}

// === Access tokens ===

/** Find a valid (non-archived, non-expired, non-consumed) access token. */
export function findAccessToken(db: DB, token: string): any | null {
  const rows = db.exec(
    `SELECT * FROM "_access_tokens" WHERE token = ? AND archived_at IS NULL AND consumed_at IS NULL`,
    token
  ).toArray() as any[];
  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
  return row;
}

/** Mark a token as consumed (for single-use tokens). */
export function consumeToken(db: DB, id: number): void {
  db.exec(
    `UPDATE "_access_tokens" SET consumed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    id
  );
}

/** Validate a token against a required scope. Consumes single-use tokens. */
export function validateAccessToken(db: DB, token: string, requiredScope: string): boolean {
  const accessToken = findAccessToken(db, token);
  if (!accessToken) return false;
  if (!scopeMatches(accessToken.scope, requiredScope)) return false;
  if (accessToken.single_use) consumeToken(db, accessToken.id);
  return true;
}

/**
 * Validate a token and resolve the actor (member) it authenticates as. Returns
 * the member label, or null if the token is invalid / out of scope / belongs to
 * a suspended-or-archived member. A token with no `member` resolves to the owner
 * sentinel (legacy and headless tokens). Used by the OAuth external-token path
 * to attribute the resulting session to a person.
 */
export function resolveTokenActor(db: DB, token: string, requiredScope: string): string | null {
  const accessToken = findAccessToken(db, token);
  if (!accessToken) return null;
  if (!scopeMatches(accessToken.scope, requiredScope)) return null;
  const member: string | null = accessToken.member ?? null;
  if (member != null && !isMemberActive(db, member)) return null;
  if (accessToken.single_use) consumeToken(db, accessToken.id);
  return member ?? OWNER_ACTOR;
}

/** A member exists, is active, and not archived. The owner sentinel is always active. */
export function isMemberActive(db: DB, member: string): boolean {
  if (member === OWNER_ACTOR) return true;
  const rows = db.exec(
    `SELECT 1 FROM "_members" WHERE label = ? AND status = 'active' AND archived_at IS NULL`,
    member
  ).toArray();
  return rows.length > 0;
}

/**
 * Validate a "register"-scoped setup token down to the member it provisions,
 * with display fields for the WebAuthn ceremony. Enforces the invariants that
 * don't depend on approval: register scope, never the owner, and an active
 * non-archived roster member. Returns null otherwise. Does NOT check approval —
 * callers layer that on (see getRegisterToken / resolveRegisterToken).
 */
function validateRegisterToken(db: DB, token: string): {
  row: any; member: string; userName: string; userDisplayName: string;
} | null {
  const row = findAccessToken(db, token);
  if (!row) return null;
  // Must be register-scoped specifically — a wildcard API token is not a setup link.
  if (row.scope !== "register") return null;
  let member = "";
  try {
    const c = JSON.parse(row.constraints || "{}");
    if (c && typeof c.member === "string" && c.member) member = c.member;
  } catch { /* no member → unusable, rejected below */ }
  if (!member) return null;
  // Robust gate (independent of how `member`/constraints got their value — the
  // create hook validates at mint time, but an update could tamper with them):
  // the owner is never provisionable via an invite, and the target must be an
  // active, non-archived roster member.
  if (member === OWNER_ACTOR) return null;
  const m = db.exec(
    `SELECT label, display_name FROM "_members" WHERE label = ? AND status = 'active' AND archived_at IS NULL`,
    member
  ).toArray()[0] as any;
  if (!m) return null;
  return { row, member, userName: m.label, userDisplayName: m.display_name || member };
}

/**
 * Register-token info for the approval page (does not require approval). Returns
 * the member + display fields and whether it has already been approved.
 */
export function getRegisterToken(db: DB, token: string): {
  id: number; member: string; userName: string; userDisplayName: string; approved: boolean;
} | null {
  const v = validateRegisterToken(db, token);
  if (!v) return null;
  return { id: v.row.id, member: v.member, userName: v.userName, userDisplayName: v.userDisplayName, approved: !!v.row.approved_at };
}

/**
 * Resolve a register token for the /setup flow. Adds the human-approval gate on
 * top of validateRegisterToken: an invite is inert until a member approves it
 * via passkey at /invite/{token}. This is the last line before a passkey is
 * bound, so an unapproved (or tampered) token must not pass.
 */
export function resolveRegisterToken(db: DB, token: string): {
  id: number; member: string; userName: string; userDisplayName: string;
} | null {
  const v = validateRegisterToken(db, token);
  if (!v) return null;
  if (!v.row.approved_at) return null;
  return { id: v.row.id, member: v.member, userName: v.userName, userDisplayName: v.userDisplayName };
}

/**
 * Mark a register token approved (human-present passkey approval). Validates the
 * same invariants, then stamps approved_at via raw SQL — approved_at is IMMUTABLE
 * on the mutate path, so this is the only way it can be set. Returns the member
 * approved, or null if the token is invalid / not a register token.
 */
export function approveRegisterToken(db: DB, token: string): { member: string } | null {
  const v = validateRegisterToken(db, token);
  if (!v) return null;
  db.exec(
    `UPDATE "_access_tokens" SET approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    v.row.id
  );
  return { member: v.member };
}

/** Validate a token without consuming it (for reusable Bearer sessions). */
export function validateAuthCode(db: DB, code: string): boolean {
  return findAccessToken(db, code) !== null;
}

/** Validate and consume a single-use token (for browser auth). */
export function consumeAuthCode(db: DB, code: string): boolean {
  const accessToken = findAccessToken(db, code);
  if (!accessToken) return false;
  if (accessToken.single_use) consumeToken(db, accessToken.id);
  return true;
}
