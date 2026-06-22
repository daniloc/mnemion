// scratchpad — durable shared pads for agents in neighboring sessions.
//
// A _scratchpad row is a NOTE posted to a named pad; agents watching that pad get a
// push (Phase 2). The whole feature, legible in one place:
//
//   patterns      → ./schema.ts (pure data: _scratchpad DDL/facets + per-pad index),
//                   folded into KERNEL_TABLES by composePatterns.
//   hooks.onCreate→ ./hooks.ts (pad slug / kind / body-size validation), folded into
//                   kernel.ts's ON_CREATE.
//   writePolicy   → ./security.ts (Open + auditExempt), composed by
//                   entities/features/security.ts.
//   effects       → the fanout-on-post effect below: a created note fans out via the
//                   core push channel (EffectContext.fanoutScratch → HiveDO RPCs each
//                   live session's notifyScratch → scheduled sendResourceUpdated). The
//                   channel itself lives in hive.ts + session.ts (the SessionDO↔HiveDO
//                   seam this feature extends); the manifest only declares the trigger.

import type { Feature } from "../feature";
import { patterns as scratchpadPatterns } from "./schema";
import { onCreate as scratchpadOnCreate } from "./hooks";

export const scratchpad: Feature = {
  name: "scratchpad",
  patterns: scratchpadPatterns,
  hooks: { onCreate: scratchpadOnCreate },
  effects: {
    _scratchpad: {
      after(entry, _result, _parsed, operation, _scratch, ctx) {
        // A new note nudges everyone watching the pad. Fire-and-forget (scheduled past
        // the response); a failed nudge never unwinds the committed note.
        if (operation === "create" && entry && typeof entry.pad === "string") ctx.fanoutScratch(entry.pad);
      },
    },
  },
};
