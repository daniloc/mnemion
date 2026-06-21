// Credential-mint gating totality — the consent dual of egress totality.
//
// A pattern with a `secret` column mints a born-hashed BEARER on every create, so
// creating a row hands out a portable, exfiltratable credential. The decidable
// invariant: such a create MUST be consent-gated (System, or Consent with a
// create-gating condition — never patch_only, which declares create benign).
// `findUngatedCredentialMints` derives this from SENSITIVE_COLUMNS × KERNEL_WRITE_POLICY
// (no new declaration) and this oracle iterates that live registry — so the exact
// bug that shipped `_access_tokens` as patch_only (an injected agent minting +
// exfiltrating a broad `*` bearer with no human round-trip) fails the build.
import { describe, it, expect } from "vitest";
import { findUngatedCredentialMints, consentRoundTripRequired } from "../../entities/Hive/policy";

describe("credential-mint gating totality", () => {
  it("every pattern that mints a secret consent-gates its create", () => {
    const ungated = findUngatedCredentialMints();
    for (const g of ungated) expect(g, g).toBeUndefined(); // fail naming any survivor (live domain)
    expect(ungated).toEqual([]);
  });

  it("a broad token mint round-trips; a narrow/inert one stays benign", () => {
    for (const scope of ["*", "read", "write", "read:entry", "write:input", "marketplace"])
      expect(consentRoundTripRequired("_access_tokens", "create", { scope }), `broad "${scope}" must gate`).toBe(true);
    for (const scope of ["upload", "document", "register", "read:entry:axioms:7", "read:output:reports", "write:input:reports"])
      expect(consentRoundTripRequired("_access_tokens", "create", { scope }), `benign "${scope}" must not gate`).toBe(false);
    // absent/non-string scope → broadest assumption → gate (fail-closed)
    expect(consentRoundTripRequired("_access_tokens", "create", {})).toBe(true);
  });
});
