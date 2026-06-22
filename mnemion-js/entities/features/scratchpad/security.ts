// scratchpad/security.ts — the scratchpad feature's WRITE-POLICY contribution, as
// PURE DATA (TYPES only, no runtime import), folded into the effective
// KERNEL_WRITE_POLICY by entities/features/security.ts.
//
// _scratchpad is WriteClass.Open + auditExempt:
//  - Open: posting a note is a plain `mutate create`, no consent (a note exposes
//    nothing outward; same class as _outputs/_views/_clipboards).
//  - auditExempt: notes are high-frequency append-only coordination; logging every
//    post to _mutation_log would be noise (mirrors _entry_access_log /
//    _fragment_access_log). The GC sweep + the notes themselves ARE the record.
// No sensitive columns — a note is pad/kind/body, nothing secret.

import type { KernelPolicy } from "../../Hive/policy";

export const writePolicy: Record<string, KernelPolicy> = {
  _scratchpad: { class: "kernel_open" as KernelPolicy["class"], auditExempt: true },
};
