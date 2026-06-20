// pages/hooks.ts — the pages feature's PRE-MUTATION HOOK, as code.
//
// The "a feature owns its kernel pattern's HOOKS" half of the pages footprint
// (after schema.ts/structure + security.ts/write-class). The _pages write-time
// validation — URL-safe path slug + the block-palette validation + the
// kernel-pattern exfil guard (a page renders on the unauthenticated /page/{path},
// so a block sourcing a kernel control table would leak _access_tokens/_members
// data publicly) — lives here, NOT in entities/Hive/kernel.ts. composeKernelHooks
// (entities/features/compose.ts) folds it into kernel.ts's ON_WRITE registry, so
// applyKernelRules enforces it byte-for-byte the same. Only the DECLARATION moved;
// ENFORCEMENT stays at the kernel chokepoint.
//
// NO-CYCLE INVARIANT: imports ONLY TYPES from kernel.ts (`import type`). The other
// imports (policy.ts's isKernelPattern, block-palette's validateBlocks) are NOT
// kernel.ts, so they're safe as runtime imports — the kernel.ts → features → hooks
// back-edge stays type-only.

import type { KernelContext, WriteHook } from "../../Hive/kernel";
import { isKernelPattern } from "../../Hive/policy";
import { validateBlocks } from "../../../shared/core/block-palette";

export const onWrite: Record<string, WriteHook> = {
  _pages(data: Record<string, unknown>, _operation: string, ctx: KernelContext) {
    // A page path becomes a public URL segment (/page/{path}) and a private
    // app anchor (/#page:{path}) — reject anything that isn't a URL-safe slug
    // before it can produce a broken page_url.
    if (typeof data.path === "string" && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(data.path)) {
      return { error: true, message: "Page path must be a URL-safe slug (letters, digits, ., _, -)." };
    }
    if (data.blocks === undefined) return data; // a partial update not touching blocks
    // A page renders on the unauthenticated /page/{path}; a block sourcing a
    // kernel control table would leak _access_tokens/_members/_federation_hosts
    // data publicly. Pages project user patterns only — mirror the _publications
    // source_pattern guard. Scan defensively: only when JSON parses to an array;
    // malformed blocks fall through to validateBlocks' own error.
    if (typeof data.blocks === "string") {
      let parsedBlocks: unknown;
      try { parsedBlocks = JSON.parse(data.blocks); } catch { parsedBlocks = undefined; }
      if (Array.isArray(parsedBlocks)) {
        for (const block of parsedBlocks) {
          const pattern = block && typeof block === "object" ? (block as Record<string, unknown>).pattern : undefined;
          if (typeof pattern === "string" && isKernelPattern(pattern))
            return { error: true, message: `Page blocks cannot reference kernel pattern "${pattern}" — pages project user patterns only.` };
        }
      }
    }
    const errors = validateBlocks(data.blocks as string | null, {
      patternExists: (p) => ctx.patternExists(p),
      hasFacet: (p, f) => ctx.facetMeta(p, f) != null,
    });
    if (errors.length) {
      return { error: true, message: `Invalid page: ${errors.join(" ")}` };
    }
    return data;
  },
};
