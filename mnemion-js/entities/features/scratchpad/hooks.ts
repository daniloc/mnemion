// scratchpad/hooks.ts — the scratchpad feature's PRE-MUTATION hook, as code.
// Validates a posted note, fail-closed; composed into kernel.ts's ON_CREATE and
// enforced at the applyKernelRules chokepoint. Imports ONLY TYPES from kernel.ts
// (the no-cycle invariant).

import type { KernelContext, WriteHook } from "../../Hive/kernel";

const PAD_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/; // URL-safe slug (a pad name rides in mnemion://scratchpad/{pad})
const MAX_BODY = 64 * 1024; // a coordination note, not a document

// onWrite (not onCreate): _scratchpad is WriteClass.Open with no immutable fields, so an
// UPDATE must re-validate too — otherwise a note's pad could be repointed to an invalid
// (or different) slug post-hoc, bypassing the create-time checks.
export const onWrite: Record<string, WriteHook> = {
  _scratchpad(data: Record<string, unknown>, operation: string, _ctx: KernelContext) {
    // pad/kind are required on create; on a partial update validate only what's supplied.
    if (operation === "create" || data.pad !== undefined) {
      if (typeof data.pad !== "string" || !PAD_RE.test(data.pad))
        return { error: true, message: "pad is required and must be a URL-safe slug (letters, digits, ., _, -)." };
    }
    if (operation === "create" || data.kind !== undefined) {
      if (typeof data.kind !== "string" || !data.kind.trim())
        return { error: true, message: 'kind is required (a short tag, e.g. "claim", "done", "note").' };
    }
    // Cap body REGARDLESS of type: a non-string body (object/array) would otherwise skip
    // the coordination-size guard and be bounded only by the 1MB entry limit.
    if (data.body != null) {
      const size = typeof data.body === "string" ? data.body.length : JSON.stringify(data.body).length;
      if (size > MAX_BODY)
        return { error: true, message: `body exceeds ${MAX_BODY} bytes — a scratchpad note is for coordination, not bulk data.` };
    }
    return data;
  },
};
