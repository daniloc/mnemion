// IMMUTABLE-registry totality — every field DECLARED immutable is actually
// REJECTED at the kernel chokepoint, on the operation it freezes.
//
// kernel.ts holds two declarative registries:
//   IMMUTABLE               — rejected on EVERY op (create + update + …)
//   IMMUTABLE_AFTER_CREATE  — set once at create, frozen on every later op
// These are the defense-in-depth that stops an agent self-approving an invite
// (`approved_at`), repointing a token's capability after mint (`scope`/`member`/
// `constraints`/`token`), retargeting an ingress endpoint (`target_pattern`), or
// renaming a member handle (`label`). The enforcement lives at ONE chokepoint —
// `applyKernelRules` (top-level-key scan) plus `immutableFieldError` (the patch
// path, which edits one facet by name and so sidesteps the key scan).
//
// This oracle iterates the LIVE registries (not a hand-list) and asserts, for
// EVERY declared {pattern, field}, that BOTH chokepoints reject it with the
// registry's own message — so adding a new immutable field that some path forgets
// to enforce, or a registry entry whose message never actually fires, fails the
// build. The domain is the declaration itself; the safe state (rejection) is the
// asserted state; an unenforced immutable fails CLOSED here.
import { describe, it, expect } from "vitest";
import {
  IMMUTABLE,
  IMMUTABLE_AFTER_CREATE,
  applyKernelRules,
  immutableFieldError,
  type KernelContext,
} from "../../entities/Hive/kernel";

// A permissive stub: the immutability checks in applyKernelRules run and return
// BEFORE any ON_CREATE/ON_WRITE hook touches ctx, so these methods are never
// reached for the immutable-field cases — but provide a benign context anyway.
const ctx: KernelContext = {
  patternExists: () => true,
  facetMeta: () => ({ type: "text" }),
  entryExists: () => true,
  memberActive: () => true,
  entryField: () => null,
};

function isError(r: unknown): r is { error: true; message: string } {
  return !!r && typeof r === "object" && (r as { error?: unknown }).error === true;
}

describe("IMMUTABLE-registry totality", () => {
  it("every IMMUTABLE field is rejected on create AND update by both chokepoints", () => {
    const entries = Object.entries(IMMUTABLE);
    expect(entries.length, "there should be at least one IMMUTABLE pattern").toBeGreaterThan(0);

    for (const [pattern, rule] of entries) {
      expect(rule.fields.length, `${pattern} IMMUTABLE rule must name ≥1 field`).toBeGreaterThan(0);
      for (const field of rule.fields) {
        // applyKernelRules scan — rejected on EVERY op (IMMUTABLE is unconditional).
        for (const op of ["create", "update", "unarchive"]) {
          const r = applyKernelRules(pattern, op, { [field]: "anything" }, ctx);
          expect(isError(r), `${pattern}.${field} must be rejected on ${op}`).toBe(true);
          if (isError(r)) expect(r.message, `${pattern}.${field} must fire its own immutable message`).toBe(rule.message);
        }
        // immutableFieldError — the patch-path chokepoint (edits one facet by name).
        expect(immutableFieldError(pattern, field), `${pattern}.${field} must be blocked on the patch path`).toBe(rule.message);
      }
    }
  });

  it("every IMMUTABLE_AFTER_CREATE field is frozen on update by both chokepoints, but is NOT an IMMUTABLE field", () => {
    const entries = Object.entries(IMMUTABLE_AFTER_CREATE);
    expect(entries.length, "there should be at least one IMMUTABLE_AFTER_CREATE pattern").toBeGreaterThan(0);

    for (const [pattern, rule] of entries) {
      expect(rule.fields.length, `${pattern} IMMUTABLE_AFTER_CREATE rule must name ≥1 field`).toBeGreaterThan(0);
      for (const field of rule.fields) {
        // Frozen on every NON-create op.
        for (const op of ["update", "unarchive"]) {
          const r = applyKernelRules(pattern, op, { [field]: "repointed" }, ctx);
          expect(isError(r), `${pattern}.${field} must be frozen on ${op}`).toBe(true);
          if (isError(r)) expect(r.message, `${pattern}.${field} must fire its own freeze message`).toBe(rule.message);
        }
        // The patch-path chokepoint blocks it too (covers both registries).
        expect(immutableFieldError(pattern, field), `${pattern}.${field} must be blocked on the patch path`).toBe(rule.message);

        // It must NOT also live in IMMUTABLE — that would reject it on create too,
        // collapsing "set once" into "never settable" (the _members.label hazard).
        const alsoImmutable = IMMUTABLE[pattern]?.fields.includes(field);
        expect(alsoImmutable, `${pattern}.${field} is IMMUTABLE_AFTER_CREATE; it must not also be IMMUTABLE (that blocks its create)`).toBeFalsy();
      }
    }
  });
});
