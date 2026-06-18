import { describe, it, expect } from "vitest";
import { getStore, createPattern } from "./helpers";
import {
  WriteClass,
  KERNEL_WRITE_POLICY,
  writeClass,
  isKernelPattern,
  isInternalWriteProtected,
  isValidWriteTarget,
  consentPolicy,
  patchRejected,
  consentRoundTripRequired,
  primeIncluded,
  isAuditExempt,
} from "../../entities/Hive/policy";
import { verifyWritePolicyTotality } from "../../entities/Hive/schema";

// === The expected admission matrix ===
//
// Independently authored from policy.ts — the security INTENT for every pattern
// in the registry. The keyset-equality assertion below makes this double-entry:
// add a registry entry without an expectation here (or vice versa) and the test
// fails. Combined with verifyWritePolicyTotality (every kernel TABLE is in the
// registry), no kernel pattern can reach an unclassified, untested state.
const EXPECTED: Record<string, WriteClass> = {
  // Consent-gated — agent-writable via the MCP path only, human round-trip
  _members: WriteClass.Consent,
  _federation_hosts: WriteClass.Consent,
  _shared: WriteClass.Consent,
  _publications: WriteClass.Consent,
  _system_docs: WriteClass.Consent,
  _documents: WriteClass.Consent,
  _access_tokens: WriteClass.Consent,
  // Open — agent-writable, no consent
  _outputs: WriteClass.Open,
  _inputs: WriteClass.Open,
  _links: WriteClass.Open,
  _charter: WriteClass.Open,
  _system_tasks: WriteClass.Open,
  _short_term_fragments: WriteClass.Open,
  _maintenance_passes: WriteClass.Open,
  _canvases: WriteClass.Open,
  _views: WriteClass.Open,
  _pages: WriteClass.Open,
  _long_term_fragments: WriteClass.Open,
  // System-only — never agent-writable
  _web_cache: WriteClass.System,
  _fragment_access_log: WriteClass.System,
  _entry_access_log: WriteClass.System,
  _mutation_log: WriteClass.System,
  _schema_history: WriteClass.System,
  _pending_changes: WriteClass.System,
};

describe("write-policy totality", () => {
  it("every kernel TABLE declares a write class (boot-time check is clean)", () => {
    expect(verifyWritePolicyTotality()).toEqual([]);
  });

  it("the registry and the expected matrix cover exactly the same patterns", () => {
    expect(new Set(Object.keys(KERNEL_WRITE_POLICY))).toEqual(new Set(Object.keys(EXPECTED)));
  });
});

describe("writeClass — every registered pattern matches its declared intent", () => {
  for (const [pattern, expected] of Object.entries(EXPECTED)) {
    it(`${pattern} → ${expected}`, () => {
      expect(writeClass(pattern)).toBe(expected);
    });
  }
});

describe("derivations are consistent with write class, for every pattern", () => {
  for (const [pattern, cls] of Object.entries(EXPECTED)) {
    it(pattern, () => {
      // Internal-write-protected iff System
      expect(isInternalWriteProtected(pattern)).toBe(cls === WriteClass.System);
      // No kernel pattern is ever a valid ingress/upload target — gated, open,
      // or system alike. HTTP write paths must never reach the kernel surface.
      expect(isValidWriteTarget(pattern)).toBe(false);
      // Consent config (and patch rejection) iff Consent class
      expect(consentPolicy(pattern) != null).toBe(cls === WriteClass.Consent);
      expect(patchRejected(pattern)).toBe(cls === WriteClass.Consent);
    });
  }
});

// Behavioral flags lifted out of prime.ts (KERNEL_INCLUDE) and schema.ts
// (AUDIT_EXEMPT) into the registry. Independently declared here; the derived
// sets must match exactly, so a flag added/removed in the registry without
// updating this expectation fails the suite (and vice versa).
const EXPECTED_PRIME_INCLUDE = new Set(["_short_term_fragments", "_long_term_fragments", "_documents"]);
const EXPECTED_AUDIT_EXEMPT = new Set(["_fragment_access_log", "_entry_access_log"]);

describe("behavioral flags derive from the registry", () => {
  it("primeInclude set matches the declared recall surface", () => {
    const derived = new Set(Object.keys(KERNEL_WRITE_POLICY).filter(primeIncluded));
    expect(derived).toEqual(EXPECTED_PRIME_INCLUDE);
  });
  it("auditExempt set matches the declared append-only logs", () => {
    const derived = new Set(Object.keys(KERNEL_WRITE_POLICY).filter(isAuditExempt));
    expect(derived).toEqual(EXPECTED_AUDIT_EXEMPT);
  });
  for (const pattern of Object.keys(EXPECTED)) {
    it(`${pattern} flags are consistent`, () => {
      expect(primeIncluded(pattern)).toBe(EXPECTED_PRIME_INCLUDE.has(pattern));
      expect(isAuditExempt(pattern)).toBe(EXPECTED_AUDIT_EXEMPT.has(pattern));
    });
  }
});

describe("user patterns are the only writable / targetable class", () => {
  for (const name of ["tasks", "axioms", "notes"]) {
    it(name, () => {
      expect(isKernelPattern(name)).toBe(false);
      expect(writeClass(name)).toBe(WriteClass.User);
      expect(isValidWriteTarget(name)).toBe(true);
      expect(isInternalWriteProtected(name)).toBe(false);
      expect(consentPolicy(name)).toBeNull();
      expect(patchRejected(name)).toBe(false);
    });
  }
});

describe("fail-closed: an unclassified kernel pattern is denied, not opened", () => {
  const ghost = "_brand_new_unclassified";
  it("defaults to System (denied) everywhere", () => {
    expect(isKernelPattern(ghost)).toBe(true);
    expect(writeClass(ghost)).toBe(WriteClass.System);
    expect(isInternalWriteProtected(ghost)).toBe(true); // mutate engine refuses it
    expect(isValidWriteTarget(ghost)).toBe(false);      // not an ingress/upload target
  });
});

describe("consent round-trip fires per condition", () => {
  it("always-gated patterns require the round-trip on create", () => {
    expect(consentRoundTripRequired("_federation_hosts", "create", { host: "x.dev" })).toBe(true);
    expect(consentRoundTripRequired("_members", "update", { label: "p" })).toBe(true);
  });
  it("archive (de-escalation) never round-trips", () => {
    expect(consentRoundTripRequired("_shared", "archive", {})).toBe(false);
    expect(consentRoundTripRequired("_federation_hosts", "archive", {})).toBe(false);
  });
  it("_documents round-trips only when it exposes the file", () => {
    expect(consentRoundTripRequired("_documents", "create", { visibility: "private" })).toBe(false);
    expect(consentRoundTripRequired("_documents", "create", {})).toBe(false);
    expect(consentRoundTripRequired("_documents", "create", { visibility: "public" })).toBe(true);
    expect(consentRoundTripRequired("_documents", "update", { visibility: "unlisted" })).toBe(true);
  });
  it("_documents unarchive requires the round-trip (resulting visibility unknown from {id})", () => {
    expect(consentRoundTripRequired("_documents", "unarchive", { id: 5 })).toBe(true);
  });
  it("_access_tokens is patch-only: create/update never round-trip, but patch is rejected", () => {
    expect(consentRoundTripRequired("_access_tokens", "create", { scope: "read" })).toBe(false);
    expect(patchRejected("_access_tokens")).toBe(true);
  });
});

// === Integration: the derivations actually gate the enforcement paths ===

describe("enforcement wiring (via the data engine)", () => {
  it("a System pattern is refused at the mutate engine", async () => {
    const store = getStore();
    const r = JSON.parse(await store.mutate("_web_cache", "create", JSON.stringify({
      url: "https://x.dev", content: "hi", source_adapter: "test",
    })));
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/managed by the system/i);
  });

  it("ingress cannot target a kernel pattern, but can target a user pattern", async () => {
    const store = getStore();
    await createPattern(store, "notes");
    const bad = JSON.parse(await store.mutate("_inputs", "create", JSON.stringify({
      path: "in-bad", target_pattern: "_shared",
    })));
    expect(bad.error).toBe(true);
    expect(bad.message).toMatch(/cannot target kernel pattern/i);

    const ok = JSON.parse(await store.mutate("_inputs", "create", JSON.stringify({
      path: "in-ok", target_pattern: "notes",
    })));
    expect(ok.error).toBeFalsy();
  });

  it("an upload token cannot target a kernel pattern", async () => {
    const store = getStore();
    const r = JSON.parse(await store.mutate("_access_tokens", "create", JSON.stringify({
      scope: "upload",
      constraints: JSON.stringify({ target_pattern: "_shared", target_id: 1, target_facet: "visibility" }),
    })));
    expect(r.error).toBe(true);
    expect(r.message).toMatch(/cannot target kernel pattern/i);
  });

  it("the _ namespace is reserved — a user pattern can't be named _foo", async () => {
    const store = getStore();
    const proposed = JSON.parse(await store.proposeChange(
      "Create _foo",
      JSON.stringify({
        type: "create_pattern",
        pattern_name: "_foo",
        pattern_description: "evil",
        doctrine: "evil",
        facets: [{ name: "body", type: "text" }],
      }),
    ));
    expect(proposed.error).toBe(true);
    expect(proposed.message).toMatch(/reserved/i);
  });
});
