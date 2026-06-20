// documents/hooks.ts — the documents feature's PRE-MUTATION HOOKS, as code.
//
// This is the "a feature owns its kernel pattern's HOOKS" half of the footprint —
// the last piece after schema.ts (structure) and security.ts (write class +
// egress). The _documents create-time validation (title required; visibility enum)
// and its IMMUTABLE bookkeeping fields (system-managed on upload/extraction) live
// here, NOT in entities/Hive/kernel.ts. composeKernelHooks (entities/features/
// compose.ts) folds them back into kernel.ts's ON_CREATE / IMMUTABLE registries, so
// applyKernelRules — the kernel chokepoint every mutate runs through — enforces them
// byte-for-byte the same. Only the DECLARATION moved; ENFORCEMENT stays at the
// kernel chokepoint, exactly like effects compose into PATTERN_EFFECTS but fire at
// the mutate chokepoint.
//
// LEAF-PRESERVATION / NO-CYCLE INVARIANT (read before editing): kernel.ts composes
// this file in (FEATURES → manifest → hooks), so this file MUST import ONLY TYPES
// from kernel.ts (`import type`). A runtime import of kernel.ts here would close a
// kernel.ts → features → hooks → kernel.ts RUNTIME cycle. Type imports are erased at
// runtime, so the back-edge stays type-only and no cycle forms.

import type { KernelContext, CreateHook, ImmutableRule } from "../../Hive/kernel";

export const immutable: Record<string, ImmutableRule> = {
  _documents: {
    fields: ["r2_key", "size", "stored_at", "extracted_text", "extraction_status"],
    message: "r2_key, size, stored_at, extracted_text, and extraction_status are managed by the system on upload/extraction — they cannot be set via mutate.",
  },
};

export const onCreate: Record<string, CreateHook> = {
  _documents(data: Record<string, unknown>, _ctx: KernelContext) {
    if (!data.title || typeof data.title !== "string" || !(data.title as string).trim())
      return { error: true, message: "title is required for _documents" };
    // r2_key/size/stored_at are IMMUTABLE (system-managed on upload) — see `immutable` above.
    const vis = (data.visibility as string) || "private";
    if (!["private", "unlisted", "public"].includes(vis))
      return { error: true, message: `Invalid visibility "${vis}". Use "private", "unlisted", or "public".` };
    data.visibility = vis;
    return data;
  },
};
