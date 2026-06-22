// effects.ts — declarative pattern effects, the SIDE-EFFECTING half of the kernel.
//
// kernel.ts holds the PURE pre-mutation hooks (ON_CREATE/ON_WRITE): they validate
// and transform DATA before insert, no I/O. This file is their symmetric impure
// twin: orchestration that runs AROUND a commit — mint a sub-token, schedule an R2
// delete, build a capability URL, run a task. Keyed by pattern, scannable as a
// table, so adding a side-effecting pattern is one entry instead of another
// `if (patternName === …)` branch in mutate().
//
// An effect receives an `EffectContext` — the DO's NARROWED hands — never `this`,
// and never a raw trusted `executeMutate` (that would be a second uncontrolled write
// chokepoint). The one sanctioned internal write is `internalCreate`.
//
// Two phases, mirroring the kernel hooks but with a side-effect contract:
//   before — runs PRE-commit; may read; may abort by throwing (reserve for effects
//            that MUST succeed for the write to be valid).
//   after  — runs POST-commit; best-effort / annotating. A failed URL or token
//            DEGRADES the result (matches today), it never unwinds the committed row.

import { FEATURES } from "../features";
import { composeEffects } from "../features/compose";

export interface EffectContext {
  env: any;
  /** A public URL on this instance (host is configuration, never request data). */
  instanceUrl(path: string): string;
  /** Post-response work that outlives the RPC (ctx.waitUntil). */
  schedule(p: Promise<unknown>): void;
  /** Run a queued system task. */
  runTask(taskId: number, task: string): Promise<unknown>;
  /** A narrow single-column read by id (literal pattern/field only). */
  readField(pattern: string, id: number, field: string): unknown;
  /** The ONLY trusted write an effect may perform: a born-hashed create through the
   *  core's owner context. Returns the committed entry + the one-time raw secret. */
  internalCreate(
    pattern: string,
    data: Record<string, unknown>,
  ): Promise<{ entry?: any; error?: boolean; once?: Record<string, string> | null }>;
  /** Fan a scratchpad post out to every live MCP session: nudges each subscriber's
   *  client (notifications/resources/updated) so it re-reads the pad without polling.
   *  Fire-and-forget (scheduled past the response); the scratchpad feature's only
   *  reach into the core SessionDO↔HiveDO push channel. */
  fanoutScratch(pad: string): void;
}

type Scratch = Record<string, unknown>;

export interface PatternEffect {
  before?(parsed: any, operation: string, ctx: EffectContext): Scratch | void;
  after?(
    entry: any,
    result: any,
    parsed: any,
    operation: string,
    scratch: Scratch,
    ctx: EffectContext,
  ): void | Promise<void>;
}

// PATTERN_EFFECTS is no longer a hand-written literal — it is COMPOSED from the
// per-feature manifests in entities/features/. Each feature declares its
// post-mutate effects keyed by pattern; `composeEffects` folds them into this flat
// map (and throws on a two-feature collision over the same pattern). The bodies
// for _documents / _pages / _system_tasks now live in their feature manifests.
//
// This is the extensibility seam: adding a side-effecting pattern means writing a
// feature manifest + one barrel line — not editing this file. The shape contract
// (EffectContext, PatternEffect above) stays here as the leaf the manifests import.
export const PATTERN_EFFECTS: Record<string, PatternEffect> = composeEffects(FEATURES);
