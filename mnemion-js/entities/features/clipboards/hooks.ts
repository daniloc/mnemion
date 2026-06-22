// clipboards/hooks.ts — the clipboards feature's PRE-MUTATION DEFINITION hook, as code.
//
// The "a feature owns its kernel pattern's HOOKS" half of the footprint (after
// schema.ts/structure + security.ts/write-class). This validates a clipboard
// DEFINITION at create/update time and FAILS CLOSED: an unknown constraint key,
// metric, or op is rejected here, so a clipboard can never store a rule the engines
// don't enforce (the totality oracle in src/__tests__/clipboards.test.ts asserts the
// keysets match). composeOnWrite folds this into kernel.ts's ON_WRITE registry, so
// applyKernelRules — the one mutate chokepoint — enforces it; only the declaration lives here.
//
// NO-CYCLE INVARIANT: imports ONLY TYPES from kernel.ts (`import type`). The constraint /
// completion registries it derives its known-key sets from are core LEAVES
// (constraints.ts / completion.ts import no manifest), so importing them at runtime
// closes no kernel.ts → features → hooks cycle.

import type { KernelContext, WriteHook, HookResult } from "../../Hive/kernel";
import { CONSTRAINT_KEYS, COMPARISON_OP_KEYS, FIELD_SPEC_RESERVED } from "../../Hive/constraints";
import { COMPLETION_METRICS, COMPLETION_METRIC_KEYS } from "../../Hive/completion";

type Err = { error: true; message: string };
const err = (message: string): Err => ({ error: true, message });

/** A clipboard's JSON columns arrive as strings (the _pages/blocks convention) but we
 *  accept structured input too and normalize it back to the string form for storage.
 *  Returns the parsed value (or undefined when absent), or a parse error. */
function jsonColumn(data: Record<string, unknown>, col: string): { value: unknown } | Err {
  const raw = data[col];
  if (raw == null) return { value: undefined };
  if (typeof raw === "string") {
    try {
      return { value: JSON.parse(raw) };
    } catch {
      return err(`${col} must be valid JSON`);
    }
  }
  // structured input — keep the parsed value, persist the string form
  data[col] = JSON.stringify(raw);
  return { value: raw };
}

function validateDefinition(data: Record<string, unknown>, operation: string, ctx: KernelContext): HookResult {
  const id = typeof data.id === "number" ? data.id : null;

  if (operation === "create" && (!data.name || typeof data.name !== "string" || !data.name.trim()))
    return err("name is required for a clipboard");

  // target_pattern is fixed at creation (no feature IMMUTABLE_AFTER_CREATE slot yet —
  // enforce the freeze here). Resolve the effective target for validating the spec.
  let target: string | null = typeof data.target_pattern === "string" ? data.target_pattern : null;
  if (operation !== "create") {
    const existing = id != null ? ctx.entryField("_clipboards", id, "target_pattern") : null;
    if (target != null && existing != null && target !== existing)
      return err("A clipboard's target_pattern is fixed at creation — archive it and create a new one to retarget.");
    target = target ?? (typeof existing === "string" ? existing : null);
  }
  if (operation === "create" && !target) return err("target_pattern is required for a clipboard");
  if (!target) return data; // partial update with no target context and nothing to bind to

  // A clipboard binds a DATASET-class user pattern: dataset enforcement coerces submitted
  // values (so min/max compare numbers) and makes aggregation over the log sound.
  if (!ctx.patternExists(target)) return err(`target_pattern "${target}" does not exist`);
  if (ctx.patternClass(target) !== "dataset")
    return err(
      `target_pattern "${target}" must be a dataset-class pattern (set it with propose_change set_class) so submitted values are type-coerced and the completion log aggregates soundly.`,
    );

  const hasFacet = (f: string) => ctx.facetMeta(target!, f) != null;

  // --- fields: per-facet value constraints ---
  const fields = jsonColumn(data, "fields");
  if ("error" in fields) return fields;
  if (fields.value !== undefined) {
    if (!Array.isArray(fields.value)) return err("fields must be a JSON array");
    for (const f of fields.value) {
      if (!f || typeof f !== "object") return err("each fields entry must be an object");
      const spec = f as Record<string, unknown>;
      if (typeof spec.facet !== "string" || !hasFacet(spec.facet))
        return err(`fields references facet "${String(spec.facet)}" which does not exist on "${target}"`);
      for (const key of Object.keys(spec))
        if (!FIELD_SPEC_RESERVED.includes(key) && !CONSTRAINT_KEYS.includes(key))
          return err(`unknown constraint "${key}" on facet "${spec.facet}". Known: ${CONSTRAINT_KEYS.join(", ")}`);
      if (spec.required != null && typeof spec.required !== "boolean")
        return err(`"required" must be a boolean on facet "${spec.facet}"`);
      if (spec.pattern != null) {
        try {
          new RegExp(String(spec.pattern));
        } catch {
          return err(`pattern for facet "${spec.facet}" is not a valid regular expression`);
        }
      }
      if (spec.min != null && spec.max != null && Number(spec.min) > Number(spec.max))
        return err(`min > max on facet "${spec.facet}"`);
      if (spec.min_length != null && spec.max_length != null && Number(spec.min_length) > Number(spec.max_length))
        return err(`min_length > max_length on facet "${spec.facet}"`);
    }
  }

  // --- unique_on: composite uniqueness (array of facet-name arrays) ---
  const unique = jsonColumn(data, "unique_on");
  if ("error" in unique) return unique;
  if (unique.value !== undefined) {
    if (!Array.isArray(unique.value)) return err("unique_on must be a JSON array of facet-name arrays");
    for (const group of unique.value) {
      if (!Array.isArray(group) || group.length === 0)
        return err("each unique_on group must be a non-empty array of facet names");
      for (const facet of group)
        if (typeof facet !== "string" || !hasFacet(facet))
          return err(`unique_on references facet "${String(facet)}" which does not exist on "${target}"`);
    }
  }

  // --- cross_field: [{left_facet, op, right_facet | literal}] ---
  const cross = jsonColumn(data, "cross_field");
  if ("error" in cross) return cross;
  if (cross.value !== undefined) {
    if (!Array.isArray(cross.value)) return err("cross_field must be a JSON array");
    for (const r of cross.value) {
      if (!r || typeof r !== "object") return err("each cross_field rule must be an object");
      const rule = r as Record<string, unknown>;
      if (typeof rule.left_facet !== "string" || !hasFacet(rule.left_facet))
        return err(`cross_field references facet "${String(rule.left_facet)}" which does not exist on "${target}"`);
      if (typeof rule.op !== "string" || !COMPARISON_OP_KEYS.includes(rule.op))
        return err(`cross_field op "${String(rule.op)}" is unknown. Known: ${COMPARISON_OP_KEYS.join(", ")}`);
      const hasRight = rule.right_facet != null;
      const hasLiteral = rule.literal != null;
      if (hasRight === hasLiteral)
        return err(`cross_field rule on "${rule.left_facet}" needs exactly one of right_facet or literal`);
      if (hasRight && (typeof rule.right_facet !== "string" || !hasFacet(rule.right_facet)))
        return err(`cross_field right_facet "${String(rule.right_facet)}" does not exist on "${target}"`);
    }
  }

  // --- completion: {require?, conditions: [{metric, op, value, ...params}]} ---
  const completion = jsonColumn(data, "completion");
  if ("error" in completion) return completion;
  if (completion.value !== undefined) {
    const spec = completion.value;
    if (!spec || typeof spec !== "object" || Array.isArray(spec))
      return err("completion must be a JSON object { require?, conditions }");
    const s = spec as Record<string, unknown>;
    if (s.require != null && s.require !== "all" && s.require !== "any")
      return err('completion.require must be "all" or "any"');
    if (s.conditions != null) {
      if (!Array.isArray(s.conditions)) return err("completion.conditions must be an array");
      for (const c of s.conditions) {
        if (!c || typeof c !== "object") return err("each completion condition must be an object");
        const cond = c as Record<string, unknown>;
        if (typeof cond.metric !== "string" || !COMPLETION_METRIC_KEYS.includes(cond.metric))
          return err(`completion metric "${String(cond.metric)}" is unknown. Known: ${COMPLETION_METRIC_KEYS.join(", ")}`);
        if (typeof cond.op !== "string" || !COMPARISON_OP_KEYS.includes(cond.op))
          return err(`completion op "${String(cond.op)}" is unknown. Known: ${COMPARISON_OP_KEYS.join(", ")}`);
        if (typeof cond.value !== "number" || !Number.isFinite(cond.value))
          return err(`completion condition for "${cond.metric}" needs a numeric value`);
        const def = COMPLETION_METRICS[cond.metric];
        for (const p of def.required)
          if (cond[p] == null) return err(`completion metric "${cond.metric}" requires param "${p}"`);
        for (const fp of def.facetParams) {
          const fv = cond[fp];
          if (typeof fv === "string" && !hasFacet(fv))
            return err(`completion metric "${cond.metric}" references facet "${fv}" which does not exist on "${target}"`);
        }
      }
    }
  }

  return data;
}

export const onWrite: Record<string, WriteHook> = {
  _clipboards(data: Record<string, unknown>, operation: string, ctx: KernelContext) {
    return validateDefinition(data, operation, ctx);
  },
};
