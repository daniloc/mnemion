// constraints.ts — the per-field VALUE-VALIDATION engine, as a dependency-free leaf.
//
// @why One declarative home for "how is a single field value checked against a
// constraint." CONSTRAINT_RULES is the table keyed by constraint name; every gate
// (the clipboard submission validator at the mutate chokepoint, the clipboard
// DEFINITION hook that fail-closes on an unknown key) DERIVES from it — neither
// re-lists the constraint vocabulary. COMPARISON_OPS is the shared op table used by
// both clipboard cross-field rules and completion conditions (completion.ts). The
// totality oracle (src/__tests__/clipboards.test.ts) asserts the keys the definition
// hook ACCEPTS equal the keys these registries ENFORCE — a constraint that can be
// stored but is silently unenforced (fail-open) fails the suite.
//
// This is a leaf: it imports NOTHING (pure functions over value + spec), so data.ts
// can import it with no cycle. It knows nothing about clipboards, SQL, or the DO —
// it's "check a value against a spec," configured by the _clipboards data.

// === Comparison operators (shared by cross-field rules and completion conditions) ===
//
// Type-aware: numeric when both sides coerce to finite numbers, lexicographic
// otherwise. So `min`/`max`-style numeric comparisons and string equality both
// route through one op table whose KEYS are the canonical operator vocabulary.

const asNum = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const bothNumeric = (a: unknown, b: unknown): boolean =>
  Number.isFinite(asNum(a)) && Number.isFinite(asNum(b));
/** -1 | 0 | 1 — numeric when both numeric, else localeCompare of the string forms. */
const order = (a: unknown, b: unknown): number =>
  bothNumeric(a, b) ? Math.sign(asNum(a) - asNum(b)) : String(a).localeCompare(String(b));
const equal = (a: unknown, b: unknown): boolean =>
  bothNumeric(a, b) ? asNum(a) === asNum(b) : String(a) === String(b);

export const COMPARISON_OPS: Record<string, (a: unknown, b: unknown) => boolean> = {
  ">=": (a, b) => order(a, b) >= 0,
  "<=": (a, b) => order(a, b) <= 0,
  ">": (a, b) => order(a, b) > 0,
  "<": (a, b) => order(a, b) < 0,
  "==": (a, b) => equal(a, b),
  "!=": (a, b) => !equal(a, b),
};

/** The canonical operator vocabulary — one home, derived by the definition hook
 *  and the totality oracle. */
export const COMPARISON_OP_KEYS: string[] = Object.keys(COMPARISON_OPS);

/** Apply a comparison op by name. Unknown op → false (fail closed; the definition
 *  hook rejects unknown ops up front, so this is the defense-in-depth floor). */
export function compareValues(op: string, a: unknown, b: unknown): boolean {
  const fn = COMPARISON_OPS[op];
  return fn ? fn(a, b) : false;
}

// === Per-field value constraints ===
//
// Each rule: (value, param) → null when satisfied, else a human message. These are
// the VALUE-vs-SPEC checks only; `required` (presence) and `unique_on` (cross-row)
// are NOT here — they aren't single-value rules and are handled by the submission
// validator. By the time a rule runs, the value has been type-coerced by the
// dataset FACET_VALIDATORS (clipboards bind dataset patterns), so `min`/`max` see a
// number, not a numeric string.

/** Max input length the `pattern` regex will run against. The pattern is agent-authored
 *  and runs against fully caller-controlled input on every submission — reachable from
 *  the UNAUTHENTICATED public ingress endpoint — so a catastrophic-backtracking pattern is
 *  a latent ReDoS on the write hot path. Refusing to match an over-long value caps the
 *  worst-case work (the definition hook also bounds the pattern source length). */
export const PATTERN_MAX_INPUT = 4096;

export const CONSTRAINT_RULES: Record<string, (value: unknown, param: unknown) => string | null> = {
  pattern: (value, param) => {
    const s = String(value);
    if (s.length > PATTERN_MAX_INPUT)
      return `is too long to validate against a pattern (max ${PATTERN_MAX_INPUT} characters)`;
    let re: RegExp;
    try {
      re = new RegExp(String(param));
    } catch {
      // The definition hook rejects an uncompilable regex at create time, so this
      // path is unreachable in practice; treat a bad pattern as a violation, never a throw.
      return `pattern /${param}/ is not a valid regular expression`;
    }
    return re.test(s) ? null : `must match /${param}/`;
  },
  min: (value, param) => {
    const n = asNum(value);
    return Number.isFinite(n) && n >= Number(param) ? null : `must be ≥ ${param}`;
  },
  max: (value, param) => {
    const n = asNum(value);
    return Number.isFinite(n) && n <= Number(param) ? null : `must be ≤ ${param}`;
  },
  min_length: (value, param) =>
    String(value).length >= Number(param) ? null : `must be at least ${param} character(s)`,
  max_length: (value, param) =>
    String(value).length <= Number(param) ? null : `must be at most ${param} character(s)`,
};

/** The canonical constraint vocabulary — one home. The definition hook derives its
 *  "known constraint key" set from this; the totality oracle asserts equality. */
export const CONSTRAINT_KEYS: string[] = Object.keys(CONSTRAINT_RULES);

/** Keys a field spec may carry that are NOT value-constraints (so the definition
 *  hook doesn't flag them as unknown). `facet` names the column; `required` is a
 *  presence rule handled by the submission validator. */
export const FIELD_SPEC_RESERVED: string[] = ["facet", "required"];

/** Run every present value-constraint on one field value; collect ALL messages
 *  (never first-fail) so a submission reports every problem at once. A field spec
 *  is `{ facet, required?, pattern?, min?, max?, min_length?, max_length? }`. */
export function validateFieldValue(
  value: unknown,
  fieldSpec: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const key of CONSTRAINT_KEYS) {
    if (fieldSpec[key] == null) continue;
    const msg = CONSTRAINT_RULES[key](value, fieldSpec[key]);
    if (msg) out.push(msg);
  }
  return out;
}
