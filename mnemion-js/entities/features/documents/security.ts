// documents/security.ts — the documents feature's WRITE-POLICY + EGRESS-SENSITIVITY
// contribution, as PURE DATA. This is the security half of the feature's footprint,
// kept SEPARATE from manifest.ts on purpose: policy.ts (the dependency-free security
// leaf) folds this in, and policy.ts MUST NOT pull a manifest (manifests carry code —
// effect bodies, route handlers — which would drag the enforcement layers into the
// security leaf and risk an import cycle).
//
// So this file imports ONLY TYPES (erased at runtime → no runtime edge into policy.ts)
// and NOTHING else. It is the single home for "what write class is _documents, and
// which of its columns must never leave the DO" — composed back into the effective
// KERNEL_WRITE_POLICY / SENSITIVE_COLUMNS by entities/features/security.ts.

import type { KernelPolicy, SensitiveColumn } from "../../Hive/policy";

export const writePolicy: Record<string, KernelPolicy> = {
  _documents: {
    // Private documents iterate freely; making one non-private (visibility public /
    // unlisted) serves the file over HTTP at /f/{id}, so that escalation is the
    // consent gate — not the benign private create.
    class: "kernel_consent" as KernelPolicy["class"],
    consent: {
      condition: "on_expose",
      message:
        "Making this document non-private serves its file over HTTP at /f/{id} (public = readable by anyone and edge-cached; unlisted = readable by anyone with an access token). Only proceed if the human approved publishing this file. Call mutate again with the same arguments to proceed.",
    },
    primeInclude: true, // document contents are searchable + recallable
  },
};

export const sensitiveColumns: Record<string, SensitiveColumn[]> = {
  // r2_key is the random, non-enumerable handle to a document's bytes in R2 — a
  // capability that has no business riding a /ws delta or an export.
  _documents: [{ column: "r2_key", kind: "redact" }],
};
