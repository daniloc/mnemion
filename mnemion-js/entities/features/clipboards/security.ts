// clipboards/security.ts — the clipboards feature's WRITE-POLICY contribution, as
// PURE DATA. Same leaf discipline as documents/pages security.ts: TYPES only, no
// runtime import, folded into the effective KERNEL_WRITE_POLICY by
// entities/features/security.ts.
//
// _clipboards is WriteClass.Consent (human round-trip on create). A clipboard binds a
// validation contract to an EXISTING dataset pattern, and "constrains future writes" is
// not benign for an already-populated, multi-actor pattern: an impossible required /
// cross_field / unique_on (or a pathological pattern) makes every subsequent legitimate
// write to that shared dataset fail — an integrity/availability lever. So an agent acting
// on injected content must not be able to silently impose one; like _members /
// _federation_hosts / _shared, defining a clipboard takes a confirmation round-trip.
// No sensitive columns: a clipboard's columns are form metadata, nothing secret.

import type { KernelPolicy } from "../../Hive/policy";

export const writePolicy: Record<string, KernelPolicy> = {
  _clipboards: {
    class: "kernel_consent" as KernelPolicy["class"],
    consent: {
      condition: "always",
      message:
        "Creating a clipboard binds a validation contract to the target dataset pattern: every future create/update on that pattern must satisfy it, and an unsatisfiable rule would block all writes to a shared dataset. Only proceed if the human asked to govern this pattern. Call mutate again with the same arguments to proceed.",
    },
  },
};
