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

import type { KernelPolicy, SensitiveColumn } from "../Hive/policy";
import { writePolicy as documentsWritePolicy, sensitiveColumns as documentsSensitiveColumns } from "./documents/security";
import { writePolicy as pagesWritePolicy } from "./pages/security";

function mergeWritePolicy(parts: Array<Record<string, KernelPolicy>>): Record<string, KernelPolicy> {
  const out: Record<string, KernelPolicy> = {};
  for (const part of parts)
    for (const [pattern, policy] of Object.entries(part)) {
      if (out[pattern]) throw new Error(`feature-write-policy collision: pattern "${pattern}" declared by two features`);
      out[pattern] = policy;
    }
  return out;
}

function mergeSensitiveColumns(parts: Array<Record<string, SensitiveColumn[]>>): Record<string, SensitiveColumn[]> {
  const out: Record<string, SensitiveColumn[]> = {};
  for (const part of parts)
    for (const [pattern, cols] of Object.entries(part)) {
      if (out[pattern]) throw new Error(`feature-sensitive-columns collision: pattern "${pattern}" declared by two features`);
      out[pattern] = cols;
    }
  return out;
}

/** Every feature's write-class rows, merged. Folded into the effective
 *  KERNEL_WRITE_POLICY by policy.ts (`{...CORE, ...FEATURE_WRITE_POLICY}`). */
export const FEATURE_WRITE_POLICY: Record<string, KernelPolicy> = mergeWritePolicy([
  documentsWritePolicy,
  pagesWritePolicy,
]);

/** Every feature's egress-sensitive columns, merged. Folded into the effective
 *  SENSITIVE_COLUMNS by policy.ts. */
export const FEATURE_SENSITIVE_COLUMNS: Record<string, SensitiveColumn[]> = mergeSensitiveColumns([
  documentsSensitiveColumns,
]);
