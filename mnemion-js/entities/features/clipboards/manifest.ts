// clipboards — validated job-dispatch forms.
//
// The whole feature, legible in one place. A clipboard binds a reusable, validated
// form to a target dataset pattern; each create on that pattern is a SUBMISSION,
// validated at the mutate chokepoint (collect-all violations) and scored against a
// composable numeric completion contract whose progress is DERIVED from the log.
//
//   patterns      → ./schema.ts (pure data: _clipboards DDL/facets + the one-per-pattern
//                   partial unique index), folded into KERNEL_TABLES by composePatterns.
//   hooks.onWrite → ./hooks.ts (the DEFINITION validator, fail-closed on unknown
//                   constraint/metric/op keys), folded into kernel.ts's ON_WRITE.
//   writePolicy   → ./security.ts (pure data: _clipboards write class = Consent —
//                   creation takes a human round-trip; see that file's rationale),
//                   composed by entities/features/security.ts.
//
// The PER-SUBMISSION enforcement + DERIVED progress are NOT a manifest slot: they live
// at the core mutate chokepoint (entities/Hive/data.ts via the generic engines
// entities/Hive/{constraints,completion}.ts, configured by _clipboards data). So unlike
// documents/pages, this feature extends core — its declaration is feature-local, its
// enforcement is the existing chokepoint. (See the Features.spec.md ## why.)

import type { Feature } from "../feature";
import { patterns as clipboardsPatterns } from "./schema";
import { onWrite as clipboardsOnWrite } from "./hooks";

export const clipboards: Feature = {
  name: "clipboards",
  patterns: clipboardsPatterns,
  hooks: { onWrite: clipboardsOnWrite },
};
