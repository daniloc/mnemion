// security.ts — the FEATURE-SECURITY BARREL. The dependency-free merge of every
// feature's pure-data security contribution (write class + egress sensitivity),
// imported by entities/Hive/policy.ts to compose the EFFECTIVE write-policy /
// sensitive-column maps.
//
// THE LEAF-PRESERVATION INVARIANT (read before editing): policy.ts is the
// dependency-free security leaf — every enforcement layer derives from it without a
// cycle. policy.ts may import THIS barrel only because this barrel (and the
// per-feature */security.ts files it re-exports) imports nothing but PURE DATA and
// TYPES. It MUST NOT import a feature manifest.ts (manifests carry code: effect
// bodies, route handlers — importing one would pull runtime code into the security
// leaf and risk a cycle). When a new feature owns kernel patterns, add its
// pure-data */security.ts here, NOT its manifest.
//
// Collisions fail LOUDLY (throw) rather than silently last-write-wins — two features
// claiming the same pattern's write class or sensitive columns is a bug.
//
// THE DOMAIN IS THE LIVE FEATURE SET. A single registry — FEATURE_SECURITY — holds
// one entry per feature ({name, writePolicy?, sensitiveColumns?}); BOTH the
// write-policy and the sensitive-column maps are DERIVED by iterating it. There is no
// second hand-list to fall out of sync, so a feature's sensitive columns can no
// longer be silently dropped while its write policy is wired (the prior bug: the
// barrel composed write policy from one list and sensitive columns from another, and
// the second omitted pages — with no egress totality oracle to catch it).

import type { KernelPolicy, SensitiveColumn } from "../Hive/policy";
import {
  writePolicy as documentsWritePolicy,
  sensitiveColumns as documentsSensitiveColumns,
} from "./documents/security";
import { writePolicy as pagesWritePolicy } from "./pages/security";
import { writePolicy as clipboardsWritePolicy } from "./clipboards/security";
import { writePolicy as scratchpadWritePolicy } from "./scratchpad/security";

/** One feature's complete pure-data security contribution: its write-class rows
 *  and its egress-sensitive columns, in a SINGLE object. Both halves of a feature's
 *  security footprint travel together so neither can be dropped independently — the
 *  bug this shape exists to kill (a feature whose `sensitiveColumns` silently never
 *  reached `SENSITIVE_COLUMNS` because the barrel's second hand-list forgot it). */
export interface FeatureSecurity {
  /** The feature name — for the collision error messages below. */
  name: string;
  writePolicy?: Record<string, KernelPolicy>;
  sensitiveColumns?: Record<string, SensitiveColumn[]>;
}

// THE ONE REGISTRY THE BARREL ITERATES. Adding a feature with kernel patterns =
// ONE line here. Both its write policy AND its sensitive columns are derived from
// THIS array below — there is no second hand-list to forget. A feature that
// declares a redact/secret column but omits it from THIS line gets no egress
// protection AND is caught by verifyEgressTotality (policy.ts), which asserts every
// column declared by any entry here survives into the composed SENSITIVE_COLUMNS.
const FEATURE_SECURITY: FeatureSecurity[] = [
  { name: "documents", writePolicy: documentsWritePolicy, sensitiveColumns: documentsSensitiveColumns },
  { name: "pages", writePolicy: pagesWritePolicy }, // pages declares no sensitive column today
  { name: "clipboards", writePolicy: clipboardsWritePolicy }, // form metadata; no sensitive column
  { name: "scratchpad", writePolicy: scratchpadWritePolicy }, // coordination notes; no sensitive column
];

/** Fold one slot (`writePolicy` | `sensitiveColumns`) of every FeatureSecurity into
 *  a flat pattern→value map. Collisions fail LOUDLY (throw) rather than silently
 *  last-write-wins — two features claiming the same pattern's contribution is a bug. */
function foldFeatureSecurity<K extends "writePolicy" | "sensitiveColumns", V>(
  slot: K,
  what: string,
): Record<string, V> {
  const out: Record<string, V> = {};
  for (const f of FEATURE_SECURITY)
    for (const [pattern, value] of Object.entries((f[slot] ?? {}) as Record<string, V>)) {
      if (out[pattern]) throw new Error(`feature-${what} collision: pattern "${pattern}" declared by two features (second is "${f.name}")`);
      out[pattern] = value;
    }
  return out;
}

/** Every feature's write-class rows, derived from FEATURE_SECURITY. Folded into the
 *  effective KERNEL_WRITE_POLICY by policy.ts (`{...CORE, ...FEATURE_WRITE_POLICY}`). */
export const FEATURE_WRITE_POLICY: Record<string, KernelPolicy> =
  foldFeatureSecurity<"writePolicy", KernelPolicy>("writePolicy", "write-policy");

/** Every feature's egress-sensitive columns, derived from THE SAME FEATURE_SECURITY
 *  array. Folded into the effective SENSITIVE_COLUMNS by policy.ts. Because both maps
 *  iterate the one registry, a feature's sensitive columns can no longer be dropped
 *  independently of its write policy — and verifyEgressTotality asserts it. */
export const FEATURE_SENSITIVE_COLUMNS: Record<string, SensitiveColumn[]> =
  foldFeatureSecurity<"sensitiveColumns", SensitiveColumn[]>("sensitiveColumns", "sensitive-columns");

/** The flat list of every sensitive column declared by ANY feature — the DECLARED
 *  domain the egress totality oracle (policy.ts `verifyEgressTotality`) checks
 *  survives into the composed SENSITIVE_COLUMNS. Derived from FEATURE_SECURITY so it
 *  cannot drift from what the features actually declare. */
export const FEATURE_DECLARED_SENSITIVE: Array<{ pattern: string; column: string }> =
  FEATURE_SECURITY.flatMap((f) =>
    Object.entries(f.sensitiveColumns ?? {}).flatMap(([pattern, cols]) =>
      cols.map((c) => ({ pattern, column: c.column })),
    ),
  );
