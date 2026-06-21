// compose.ts — the COMPOSERS: derive each scattered registry from the FEATURES
// array. One composer per registry. Most are LIVE: effects, patterns, migrations,
// routes, and the kernel hooks (onCreate/onWrite/immutable) are WIRED into their
// host files (see the per-composer comments for the exact host + call site);
// write-policy/egress-sensitivity compose in the security.ts barrel, not here,
// because policy.ts is a dependency-free leaf. The tools and system-docs composers
// are still DESIGNED (signatures present, no host imports them yet — wired once
// tools.ts / schema.ts adopt the array).
//
// Composition runs at MODULE LOAD for static registries (effects, tools metadata)
// and at BOOT for stateful ones (patterns/DDL/migrations/system-docs, which touch
// the DB). See "WHERE EACH RUNS" in the per-composer comments.
//
// Invariants the composers enforce (fail LOUDLY, never silently last-write-wins):
//   - effects: a pattern may have an effect from at MOST one feature (collision →
//     throw). Two features fighting over `_documents`'s post-mutate hook is a bug.
//   - migrations: version numbers are globally unique + monotonic.
//   - patterns / tools / routes: name/path uniqueness across features.

import type { Feature, FeatureRoute, FeatureSystemDoc } from "./feature";
import type { PatternEffect } from "../Hive/effects";
import type { CreateHook, WriteHook, ImmutableRule } from "../Hive/kernel";

/** Fold every feature's `effects` into the flat PATTERN_EFFECTS map.
 *  WHERE IT RUNS: module load of effects.ts (`PATTERN_EFFECTS = composeEffects(FEATURES)`).
 *  Pure, synchronous, no DB — safe at import time. */
export function composeEffects(features: Feature[]): Record<string, PatternEffect> {
  const out: Record<string, PatternEffect> = {};
  for (const f of features) {
    if (!f.effects) continue;
    for (const [pattern, effect] of Object.entries(f.effects)) {
      if (out[pattern]) {
        throw new Error(
          `feature-effects collision: pattern "${pattern}" has effects from two features ` +
            `(second is "${f.name}"). A pattern's post-mutate hook must come from one feature.`,
        );
      }
      out[pattern] = effect;
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Composers. `effects` (above), `patterns`, and `migrations` are WIRED into their
// host files; the remainder (writePolicy/routes/tools/systemDocs) are either wired
// elsewhere (writePolicy via the pure-data security barrel, routes via index.ts) or
// DESIGNED (signatures only — wired when their host registry adopts the array). Each
// documents WHERE the composition runs and HOW the host file changes from a literal
// to a derivation, so the design lives next to the type.
// ───────────────────────────────────────────────────────────────────────────

/** PATTERNS + DDL.  WIRED.  HOST: schema.ts `KERNEL_TABLES` literal becomes
 *  `[...CORE_KERNEL_TABLES, ...composePatterns(FEATURES)]`.
 *  WHERE IT RUNS: boot — schema.ts iterates KERNEL_TABLES to run DDL + seed _fields,
 *  so a feature's patterns join that list and DDL, _fields metadata, the
 *  DDL↔_fields drift oracle (`verifyFieldsIntegrity`), and the write-class totality
 *  check (`verifyWritePolicyTotality`) all pick them up unchanged. Composer asserts
 *  no two features declare the same pattern name; a feature↔core collision is caught
 *  by the write-policy `mergeDisjoint` in policy.ts. */
// A kernel pattern is identified everywhere by its `_` prefix (isKernelPattern in
// policy.ts is `startsWith("_")`). A feature pattern that omits the prefix would
// fold into KERNEL_TABLES yet read as a User pattern at every gate — agent-writable,
// the OPPOSITE of the fail-closed namespace intent. composePatterns forces the
// prefix here (the chokepoint) so the namespace can't escape, rather than relying on
// a downstream boot warn that only notices after the fact.
const KERNEL_PATTERN_NAME_RE = /^_[a-z][a-z0-9_]*$/;

export function composePatterns(features: Feature[]): NonNullable<Feature["patterns"]> {
  const out: NonNullable<Feature["patterns"]> = [];
  const seen = new Set<string>();
  for (const f of features)
    for (const p of f.patterns ?? []) {
      if (!KERNEL_PATTERN_NAME_RE.test(p.name))
        throw new Error(
          `feature-pattern namespace escape: "${p.name}" (in "${f.name}") is not a kernel ` +
            `pattern name. A feature pattern MUST be "_"-prefixed (match ${KERNEL_PATTERN_NAME_RE}) ` +
            `or it folds into KERNEL_TABLES while reading as an agent-writable User pattern.`,
        );
      if (seen.has(p.name)) throw new Error(`feature-pattern collision: "${p.name}" (in "${f.name}")`);
      seen.add(p.name);
      out.push(p);
    }
  return out;
}

// WRITE POLICY + EGRESS SENSITIVITY are composed NOT here but in
// entities/features/security.ts, because policy.ts is a dependency-free security
// LEAF and must import only pure data — never a manifest (which carries code). Each
// feature owns its write-class/sensitive-columns in its pure-data */security.ts,
// merged by that barrel. There is deliberately no composeWritePolicy: a second home
// for the same job is cruft by the one-declarative-home doctrine.

/** MIGRATIONS.  WIRED.  HOST: schema.ts's boot migration pile gains a tail loop
 *  over `composeMigrations(FEATURES)`. Core migrations are an append-only pile of
 *  idempotent (PRAGMA-guarded) ALTER blocks run on EVERY boot with no stored-version
 *  gate, so feature migrations run the same way — `version` is purely the global
 *  ordering + collision slot, not a run condition. WHERE IT RUNS: boot, after the
 *  kernel DDL loop + core migrations. Composer sorts by version and asserts version
 *  uniqueness across features so two features can't claim the same slot.
 *
 *  NOTE on feature-vs-CORE versions: the two share ONE version space BY DESIGN — a
 *  feature carved out of core keeps its historical version for idempotent ordering
 *  (e.g. `documents` owns v12, moved from the core pile). So there is no clean floor
 *  that separates them; CORE versions live in schema.ts (an un-importable procedural
 *  pile), so feature-vs-core uniqueness is the migration author's responsibility, the
 *  same as adding to the core pile. This composer enforces what it CAN see —
 *  feature-vs-feature uniqueness. (A `FEATURE_MIGRATION_MIN` floor was tried and
 *  reverted: it broke `documents` v12, which legitimately lives in the core range.) */
export function composeMigrations(features: Feature[]): NonNullable<Feature["migrations"]> {
  const out: NonNullable<Feature["migrations"]> = [];
  const versions = new Set<number>();
  for (const f of features)
    for (const m of f.migrations ?? []) {
      if (versions.has(m.version)) throw new Error(`feature-migration version collision: ${m.version} (in "${f.name}")`);
      versions.add(m.version);
      out.push(m);
    }
  return out.sort((a, b) => a.version - b.version);
}

/** Route-composition guardrails passed IN from src/index.ts (which owns the `Auth`
 *  enum and the CORE route table). Threaded as plain data so compose.ts stays
 *  dependency-light (no router-runtime import, no cycle). */
export interface ComposeRoutesOptions {
  /** The set of valid `Auth` enum VALUES (e.g. "none","dev","session"). A feature
   *  route whose `auth` isn't one of these is rejected — fail-CLOSED, because an
   *  unrecognized/typo'd/wrong-cased auth string would otherwise resolve to
   *  Auth.NONE (`route.auth ?? Auth.NONE`) and silently serve UNAUTHENTICATED. */
  validAuthValues: ReadonlySet<string>;
  /** `${method} ${pattern}` keys of the CORE routes. A feature route matching one is
   *  rejected — it would be silently DEAD (first-match-wins puts core ahead), the
   *  forker's intent dropped on the floor. */
  coreRouteKeys: ReadonlySet<string>;
}

/** ROUTES.  HOST: src/index.ts `routes[]` becomes `[...CORE_ROUTES,
 *  ...composeRoutes(FEATURES, opts)]`, and BACKEND_PREFIXES absorbs each route's
 *  `backendPrefix`. WHERE IT RUNS: module load of index.ts (the route table is
 *  built once). Feature routes are appended AFTER core routes (declaration-order
 *  matching means a feature route can never shadow a core route), and the
 *  composer asserts: (a) no two features claim the same method+pattern; (b) every
 *  `auth` is a valid `Auth` enum VALUE (fail-closed — never silently NONE); (c) no
 *  feature route collides with a CORE route (else silently dead). */
export function composeRoutes(features: Feature[], opts: ComposeRoutesOptions): FeatureRoute[] {
  const out: FeatureRoute[] = [];
  const seen = new Set<string>();
  for (const f of features)
    for (const r of f.routes ?? []) {
      const key = `${r.method} ${r.pattern}`;
      // (b) Validate auth against the live Auth value set BEFORE it can be cast to
      // Auth and default to NONE at dispatch. Fail closed: a bad auth never serves.
      if (r.auth !== undefined && !opts.validAuthValues.has(r.auth))
        throw new Error(
          `feature-route invalid auth: "${r.auth}" on ${key} (in "${f.name}") is not a valid Auth value ` +
            `(one of: ${[...opts.validAuthValues].join(", ")}). An unrecognized auth would silently resolve ` +
            `to Auth.NONE and serve UNAUTHENTICATED — fail closed instead.`,
        );
      // (c) A feature route can't shadow (and be killed by) a CORE route.
      if (opts.coreRouteKeys.has(key))
        throw new Error(
          `feature-route shadows core: ${key} (in "${f.name}") matches a CORE route. ` +
            `First-match-wins keeps core ahead, so the feature route would be silently dead.`,
        );
      if (seen.has(key)) throw new Error(`feature-route collision: ${key} (in "${f.name}")`);
      seen.add(key);
      out.push(r);
    }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// UNWIRED-SLOT GUARD.  Some Feature slots LOOK first-class but have no host
// importer yet (`tools` → session.ts, `systemDocs` → schema.ts). A feature that
// populates one compiles, boots clean, and is SILENTLY IGNORED — the verb never
// registers, the doc never seeds. That silent no-op is a fork foot-gun. This guard
// turns it LOUD: a feature declaring an unwired slot throws at compose time.
//
// UNWIRED_SLOTS is the single source of truth for which slots aren't plumbed. When a
// slot gets wired (its composer gains a host importer), delete its row here in the
// same change — the totality test (`unwired-slots`) keeps this list honest by
// asserting each named slot's composer is indeed still importer-less in source.
// ───────────────────────────────────────────────────────────────────────────

const UNWIRED_SLOTS: ReadonlyArray<{ slot: keyof Feature; host: string }> = [
  { slot: "tools", host: "session.ts" },
  { slot: "systemDocs", host: "schema.ts" },
];

/** Throw if any feature populates a slot that isn't yet wired into its host file.
 *  Runs at module load from src/index.ts (the guaranteed-to-run chokepoint), beside
 *  composeRoutes. Converts a silent no-op into a clear, actionable error. */
export function assertWiredSlots(features: Feature[]): void {
  for (const f of features)
    for (const { slot, host } of UNWIRED_SLOTS) {
      const v = f[slot];
      const populated = Array.isArray(v) ? v.length > 0 : v != null;
      if (populated)
        throw new Error(
          `feature "${f.name}" declares \`${slot}\`, but the ${slot} slot is not yet wired into ${host} — ` +
            `it would be silently ignored. Remove it, or wire ${slot} into ${host} first ` +
            `(then drop "${slot}" from UNWIRED_SLOTS in compose.ts).`,
        );
    }
}

/** TOOLS.  DESIGNED — NOT YET WIRED (consistent with the file header). No host
 *  imports composeTools today: tools.ts does NOT yet concatenate it, and session.ts
 *  does NOT yet call each feature tool's `register`. When tools.ts adopts the array,
 *  `TOOLS` will concatenate `composeTools(FEATURES)` (the metadata half, feeding
 *  /api/tools + MCP registration listing) and session.ts will call each feature
 *  tool's `register(server, hive)` during MCP setup (the handler half) — metadata at
 *  module load, `register` once per session at MCP init. Composer asserts tool-name
 *  uniqueness so the seam is correct the moment it's wired. */
export function composeTools(features: Feature[]): NonNullable<Feature["tools"]> {
  const out: NonNullable<Feature["tools"]> = [];
  const seen = new Set<string>();
  for (const f of features)
    for (const t of f.tools ?? []) {
      if (seen.has(t.name)) throw new Error(`feature-tool collision: "${t.name}" (in "${f.name}")`);
      seen.add(t.name);
      out.push(t);
    }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// KERNEL PRE-MUTATION HOOKS.  WIRED.  HOST: entities/Hive/kernel.ts renames its
// hand-written literals to CORE_ON_CREATE / CORE_ON_WRITE / CORE_IMMUTABLE and
// derives the EXPORTED ON_CREATE / ON_WRITE / IMMUTABLE as
//   mergeDisjoint(CORE_*, compose*(FEATURES))
// (mirroring policy.ts), throwing if a feature declares a hook for a CORE pattern.
// applyKernelRules reads the exported composed maps, so ENFORCEMENT stays at the
// kernel chokepoint — only the DECLARATION moves into the feature dir. The feature
// hooks.ts files import ONLY TYPES from kernel.ts, so the kernel.ts → FEATURES →
// hooks back-edge is type-only and no runtime cycle forms. WHERE IT RUNS: module
// load of kernel.ts. Each composer folds every feature's slice of its registry,
// throwing on a feature↔feature collision (two features can't own the same
// pattern's hook).
// ───────────────────────────────────────────────────────────────────────────

export function composeOnCreate(features: Feature[]): Record<string, CreateHook> {
  const out: Record<string, CreateHook> = {};
  for (const f of features)
    for (const [pattern, hook] of Object.entries(f.hooks?.onCreate ?? {})) {
      if (out[pattern]) throw new Error(`feature on-create-hook collision: pattern "${pattern}" declared by two features (second is "${f.name}")`);
      out[pattern] = hook;
    }
  return out;
}

export function composeOnWrite(features: Feature[]): Record<string, WriteHook> {
  const out: Record<string, WriteHook> = {};
  for (const f of features)
    for (const [pattern, hook] of Object.entries(f.hooks?.onWrite ?? {})) {
      if (out[pattern]) throw new Error(`feature on-write-hook collision: pattern "${pattern}" declared by two features (second is "${f.name}")`);
      out[pattern] = hook;
    }
  return out;
}

export function composeImmutable(features: Feature[]): Record<string, ImmutableRule> {
  const out: Record<string, ImmutableRule> = {};
  for (const f of features)
    for (const [pattern, rule] of Object.entries(f.hooks?.immutable ?? {})) {
      if (out[pattern]) throw new Error(`feature immutable-fields collision: pattern "${pattern}" declared by two features (second is "${f.name}")`);
      out[pattern] = rule;
    }
  return out;
}

/** SYSTEM DOCS.  DESIGNED — NOT YET WIRED (consistent with the file header). No
 *  host imports composeSystemDocs today: schema.ts does NOT yet concatenate it. When
 *  schema.ts adopts the array, its seed list will concatenate
 *  `composeSystemDocs(FEATURES)` at boot, alongside the core doc seeding. Composer
 *  asserts slug uniqueness so the seam is correct the moment it's wired. */
export function composeSystemDocs(features: Feature[]): FeatureSystemDoc[] {
  const out: FeatureSystemDoc[] = [];
  const seen = new Set<string>();
  for (const f of features)
    for (const d of f.systemDocs ?? []) {
      if (seen.has(d.slug)) throw new Error(`feature-system-doc collision: "${d.slug}" (in "${f.name}")`);
      seen.add(d.slug);
      out.push(d);
    }
  return out;
}
