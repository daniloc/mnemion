// clipboards/security.ts — the clipboards feature's WRITE-POLICY contribution, as
// PURE DATA. Same leaf discipline as documents/pages security.ts: TYPES only, no
// runtime import, folded into the effective KERNEL_WRITE_POLICY by
// entities/features/security.ts.
//
// _clipboards is WriteClass.Open: agent-writable via mutate, no consent round-trip.
// Defining a clipboard exposes NO data outward (unlike _documents/_pages, whose
// non-private flips serve files/pages over HTTP) — it only constrains future writes
// to the target pattern. Same class as _outputs / _views. No sensitive columns: a
// clipboard's columns are form metadata, nothing secret, so none need egress redaction.

import type { KernelPolicy } from "../../Hive/policy";

export const writePolicy: Record<string, KernelPolicy> = {
  _clipboards: { class: "kernel_open" as KernelPolicy["class"] },
};
