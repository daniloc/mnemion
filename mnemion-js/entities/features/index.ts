// index.ts — the FEATURE BARREL. The whole feature set, in one greppable place.
//
// Adding a feature is TWO edits, both here-adjacent:
//   1. create entities/features/<name>/manifest.ts exporting a `Feature`
//   2. add ONE import line + ONE array entry below
//
// The composers in ./compose.ts derive every scattered registry from FEATURES.
// `effects` is live today: entities/Hive/effects.ts sets
//   PATTERN_EFFECTS = composeEffects(FEATURES)
// instead of a hand-written literal. The remaining registries adopt their
// composer in their own host file (see compose.ts for each landing spot).

import type { Feature } from "./feature";
import { documents } from "./documents/manifest";
import { pages } from "./pages/manifest";
import { systemTasks } from "./system-tasks/manifest";

export const FEATURES: Feature[] = [documents, pages, systemTasks];
