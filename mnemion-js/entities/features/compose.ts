// compose.ts — the COMPOSERS: derive each scattered registry from the FEATURES
// array. One composer per registry. effects is LIVE; the rest are documented
// designs (signatures present, called once wired into their host file).
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
// DESIGNED composers (signatures only — wired when their host registry adopts
// the array). Each documents WHERE the composition runs and HOW the host file
// changes from a literal to a derivation. Kept here so the design lives next to
// the type, and so the next agent has a concrete landing spot.
// ───────────────────────────────────────────────────────────────────────────

/** PATTERNS + DDL.  HOST: schema.ts `KERNEL_PATTERNS` literal becomes
 *  `[...CORE_KERNEL_PATTERNS, ...composePatterns(FEATURES)]`.
 *  WHERE IT RUNS: boot — schema.ts already iterates KERNEL_PATTERNS to run DDL +
 *  seed _fields; a feature's patterns join that list, so DDL, _fields metadata,
 *  and the write-class totality check (`findUnclassifiedKernelPatterns`) all pick
 *  them up unchanged. Composer asserts no two features (or a feature + core)
 *  declare the same pattern name. */
export function composePatterns(features: Feature[]): Feature["patterns"] {
  const out: NonNullable<Feature["patterns"]> = [];
  const seen = new Set<string>();
  for (const f of features)
    for (const p of f.patterns ?? []) {
      if (seen.has(p.name)) throw new Error(`feature-pattern collision: "${p.name}" (in "${f.name}")`);
      seen.add(p.name);
      out.push(p);
    }
  return out;
}

/** WRITE POLICY.  HOST: policy.ts `KERNEL_WRITE_POLICY` literal merges
 *  `composeWritePolicy(FEATURES)`. WHERE IT RUNS: module load of policy.ts (the
 *  registry is a static table). The fail-closed default is UNCHANGED: a pattern
 *  declared without a write-policy entry still resolves to System/denied, so a
 *  feature that forgets its policy is denied, not silently agent-writable. */
export function composeWritePolicy(features: Feature[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of features)
    for (const [pat, cls] of Object.entries(f.writePolicy ?? {})) {
      if (out[pat]) throw new Error(`feature-write-policy collision: "${pat}" (in "${f.name}")`);
      out[pat] = cls;
    }
  return out;
}

/** MIGRATIONS.  HOST: schema.ts `runMigrations` switch gains a tail loop over
 *  `composeMigrations(FEATURES)` (sorted by version, run if > stored schema
 *  version). WHERE IT RUNS: boot, after core migrations. Composer asserts version
 *  uniqueness across features so two features can't claim the same slot. */
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

/** ROUTES.  HOST: src/index.ts `routes[]` becomes `[...CORE_ROUTES,
 *  ...composeRoutes(FEATURES)]`, and BACKEND_PREFIXES absorbs each route's
 *  `backendPrefix`. WHERE IT RUNS: module load of index.ts (the route table is
 *  built once). Feature routes are appended AFTER core routes (declaration-order
 *  matching means a feature route can never shadow a core route), and the
 *  composer asserts no two features claim the same method+pattern. */
export function composeRoutes(features: Feature[]): FeatureRoute[] {
  const out: FeatureRoute[] = [];
  const seen = new Set<string>();
  for (const f of features)
    for (const r of f.routes ?? []) {
      const key = `${r.method} ${r.pattern}`;
      if (seen.has(key)) throw new Error(`feature-route collision: ${key} (in "${f.name}")`);
      seen.add(key);
      out.push(r);
    }
  return out;
}

/** TOOLS.  HOST: tools.ts `TOOLS` concatenates `composeTools(FEATURES)` (the
 *  metadata half, feeding /api/tools + MCP registration listing); session.ts
 *  calls each feature tool's `register(server, hive)` during MCP setup (the
 *  handler half). WHERE IT RUNS: tools metadata at module load; `register` once
 *  per session at MCP init. Composer asserts tool-name uniqueness. */
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

/** SYSTEM DOCS.  HOST: schema.ts seed list concatenates
 *  `composeSystemDocs(FEATURES)`. WHERE IT RUNS: boot, alongside the core doc
 *  seeding. Composer asserts slug uniqueness. */
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
