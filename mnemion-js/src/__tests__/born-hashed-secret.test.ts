// Born-hashed-secret totality — every `secret`-classified column persists a DIGEST,
// never a usable bearer, and a caller can't set the raw.
//
// `mintSecrets` (hive.ts) is generic over `SENSITIVE_COLUMNS` (it reads
// secretColumn(pattern)) and runs on every engine write path (mutate / batchMutate /
// internalCreate), so a column declared `kind:"secret"` is born-hashed by construction
// — the raw preimage is system-generated, returned ONCE in the create response, and
// only its SHA-256 digest lands in the column/audit/delta. This oracle iterates the
// LIVE secret-column set and verifies that property end-to-end, so a new secret column
// that isn't actually born-hashed (a missed wiring, a write path that bypasses
// mintSecrets, a regression) fails the build. It's the consent dual already exists
// (findUngatedCredentialMints gates the MINT; this proves the STORAGE is a digest).
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";
import { SENSITIVE_COLUMNS } from "../../entities/Hive/policy";

function getStore(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName(`secret:${Math.random()}`);
  return env.MNEMION_HIVE.get(id);
}

// A minimal valid create payload per secret-bearing pattern (so the row creates and we
// can inspect the stored secret). A new secret pattern in SENSITIVE_COLUMNS without an
// entry here fails the assertion below — a deliberate reminder to cover it.
const CREATE_PAYLOAD: Record<string, Record<string, unknown>> = {
  _access_tokens: { scope: "read" },
};

describe("born-hashed-secret totality", () => {
  it("every secret column persists a digest; a caller-supplied raw is never stored", async () => {
    const secretCols = Object.entries(SENSITIVE_COLUMNS).flatMap(([pattern, cols]) =>
      cols.filter((c) => c.kind === "secret").map((c) => ({ pattern, column: c.column })),
    );
    expect(secretCols.length, "there should be at least one secret column to check").toBeGreaterThan(0);

    for (const { pattern, column } of secretCols) {
      const payload = CREATE_PAYLOAD[pattern];
      expect(payload, `add a CREATE_PAYLOAD entry for secret pattern "${pattern}"`).toBeDefined();

      const store = getStore();
      const PLANTED = "PLAINTEXT-SECRET-THAT-MUST-NEVER-PERSIST";
      const r = JSON.parse(await store.mutate(pattern, "create", JSON.stringify({ ...payload, [column]: PLANTED })));
      expect(r.error, r.message).toBeFalsy();

      // Read the STORED value back (the trusted owner read returns the column as-is).
      const back = JSON.parse(await store.query(pattern, JSON.stringify([`id=${r.entry.id}`]), "", "", 1, false, "", ""));
      const stored = back.entries[0][column];
      expect(stored, `${pattern}.${column} must persist a 64-hex digest`).toMatch(/^[0-9a-f]{64}$/);
      expect(stored, "a caller-supplied raw must never be persisted").not.toBe(PLANTED);

      // The raw is handed back ONCE in the create response, and is neither the planted
      // value nor the stored digest (it is the system-generated preimage).
      const onceRaw = r.entry[column];
      expect(onceRaw, "the raw must be returned once").toBeTruthy();
      expect(onceRaw).not.toBe(PLANTED);
      expect(onceRaw).not.toBe(stored);
    }
  });
});
