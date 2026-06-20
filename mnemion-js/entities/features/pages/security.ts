// pages/security.ts — the pages feature's WRITE-POLICY contribution, as PURE DATA.
// Same discipline as documents/security.ts: policy.ts (the dependency-free security
// leaf) folds this in, so this file imports ONLY TYPES (erased at runtime → no runtime
// edge into policy.ts, hence no import cycle) and NOTHING else. The _pages write class
// lives here; entities/features/security.ts composes it back into the effective
// KERNEL_WRITE_POLICY.
//
// (No sensitiveColumns: _pages has no secret/redact column. It contributes write
// policy only.)

import type { KernelPolicy } from "../../Hive/policy";

export const writePolicy: Record<string, KernelPolicy> = {
  _pages: {
    // Private page edits flow freely (iterate with the agent); publishing one
    // (visibility public) is consent-gated — it serves hive data over HTTP.
    class: "kernel_consent" as KernelPolicy["class"],
    consent: {
      condition: "on_expose",
      message:
        "Making this page public serves it over HTTP at /page/{path} — anyone with the link can read it, including the data its blocks pull from the hive. Only proceed if the human approved publishing this page. Call mutate again with the same arguments to proceed.",
    },
  },
};
