// scratchpad/hooks.ts — the scratchpad feature's PRE-MUTATION hook, as code.
// Validates a posted note, fail-closed; composed into kernel.ts's ON_CREATE and
// enforced at the applyKernelRules chokepoint. Imports ONLY TYPES from kernel.ts
// (the no-cycle invariant).

import type { KernelContext, CreateHook } from "../../Hive/kernel";

const PAD_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/; // URL-safe slug (a pad name rides in mnemion://scratchpad/{pad})
const MAX_BODY = 64 * 1024; // a coordination note, not a document

export const onCreate: Record<string, CreateHook> = {
  _scratchpad(data: Record<string, unknown>, _ctx: KernelContext) {
    if (typeof data.pad !== "string" || !PAD_RE.test(data.pad))
      return { error: true, message: "pad is required and must be a URL-safe slug (letters, digits, ., _, -)." };
    if (typeof data.kind !== "string" || !data.kind.trim())
      return { error: true, message: 'kind is required (a short tag, e.g. "claim", "done", "note").' };
    if (data.body != null && typeof data.body === "string" && data.body.length > MAX_BODY)
      return { error: true, message: `body exceeds ${MAX_BODY} bytes — a scratchpad note is for coordination, not bulk data.` };
    return data;
  },
};
