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
export function composePatterns(features: Feature[]): NonNullable<Feature["patterns"]> {
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

/** MIGRATIONS.  WIRED.  HOST: schema.ts's boot migration pile gains a tail loop
 *  over `composeMigrations(FEATURES)`. Core migrations are an append-only pile of
 *  idempotent (PRAGMA-guarded) ALTER blocks run on EVERY boot with no stored-version
 *  gate, so feature migrations run the same way — `version` is purely the global
 *  ordering + collision slot, not a run condition. WHERE IT RUNS: boot, after the
 *  kernel DDL loop + core migrations. Composer sorts by version and asserts version
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
