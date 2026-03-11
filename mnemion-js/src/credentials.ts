// Credential infrastructure: passkey storage + access token operations
//
// Pure functions that take a db accessor. HiveDO keeps thin RPC wrappers.
// Auth concerns separated from the cognitive substrate.

import { scopeMatches } from "./kernel";
export { scopeMatches };

type DB = { exec: (sql: string, ...params: any[]) => { toArray: () => any[]; one: () => any } };

// === Passkey storage ===

export function hasPasskey(db: DB): boolean {
  return db.exec("SELECT 1 FROM _passkeys WHERE id = 1").toArray().length > 0;
}

export function getPasskey(db: DB): { credential_id: string; public_key: string; counter: number; transports: string } | null {
  const rows = db.exec("SELECT * FROM _passkeys WHERE id = 1").toArray() as any[];
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    credential_id: r.credential_id,
    public_key: r.public_key,
    counter: r.counter,
    transports: r.transports,
  };
}

export function storePasskey(db: DB, credentialId: string, publicKey: string, counter: number, transports: string): void {
  db.exec("DELETE FROM _passkeys");
  db.exec(
    "INSERT INTO _passkeys (id, credential_id, public_key, counter, transports) VALUES (1, ?, ?, ?, ?)",
    credentialId, publicKey, counter, transports
  );
}

export function updatePasskeyCounter(db: DB, counter: number): void {
  db.exec("UPDATE _passkeys SET counter = ? WHERE id = 1", counter);
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
