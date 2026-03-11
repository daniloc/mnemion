// Kernel pattern pre-mutation rules
//
// Declarative hooks that validate and transform data before the generic
// INSERT/UPDATE/ARCHIVE logic in store.ts runs. Each kernel table's
// special behavior is visible in one place.

export interface KernelContext {
  patternExists(name: string): boolean;
  facetMeta(pattern: string, facet: string): { type: string } | null;
  entryExists(pattern: string, id: number): boolean;
}

type HookResult = Record<string, unknown> | { error: true; message: string };
type CreateHook = (data: Record<string, unknown>, ctx: KernelContext) => HookResult;

// === Immutable fields — rejected on any operation ===

const IMMUTABLE: Record<string, { fields: string[]; message: string }> = {
  _system_docs: {
    fields: ["default_content"],
    message: "default_content is immutable. It preserves the original seed for recovery.",
  },
};

// === Create hooks — validate + transform before INSERT ===

const ON_CREATE: Record<string, CreateHook> = {
  _auth_codes(data) {
    const ttl = typeof data.ttl_minutes === "number" ? data.ttl_minutes : 60;
    data.expires_at = new Date(Date.now() + ttl * 60_000).toISOString();
    delete data.ttl_minutes;
    return data;
  },

  _outputs(data) {
    if (!data.path) return { error: true, message: "path is required for _outputs" };
    data.mime_type = data.mime_type || "text/plain";
    data.visibility = data.visibility || "public";
    return data;
  },

  _inputs(data, ctx) {
    if (!data.path) return { error: true, message: "path is required for _inputs" };
    if (!data.target_pattern) return { error: true, message: "target_pattern is required for _inputs" };
    if (!ctx.patternExists(data.target_pattern as string))
      return { error: true, message: `Target pattern "${data.target_pattern}" does not exist` };
    if (data.facet_mapping && typeof data.facet_mapping === "string") {
      try { JSON.parse(data.facet_mapping as string); } catch {
        return { error: true, message: "facet_mapping must be valid JSON" };
      }
    }
    if (data.body_facet && !ctx.facetMeta(data.target_pattern as string, data.body_facet as string))
      return { error: true, message: `Facet "${data.body_facet}" does not exist on "${data.target_pattern}"` };
    data.visibility = data.visibility || "public";
    return data;
  },

  _upload_tokens(data, ctx) {
    if (!data.target_pattern || data.target_id == null || !data.target_facet)
      return { error: true, message: "target_pattern, target_id, and target_facet are required" };
    if (!ctx.patternExists(data.target_pattern as string))
      return { error: true, message: `Target pattern "${data.target_pattern}" does not exist` };
    if (!ctx.entryExists(data.target_pattern as string, data.target_id as number))
      return { error: true, message: `Target entry ${data.target_id} not found in "${data.target_pattern}"` };
    const meta = ctx.facetMeta(data.target_pattern as string, data.target_facet as string);
    if (!meta)
      return { error: true, message: `Facet "${data.target_facet}" does not exist on "${data.target_pattern}"` };
    if (meta.type !== "text")
      return { error: true, message: `Upload target facet must be text type, "${data.target_facet}" is ${meta.type}` };
    data.expires_at = new Date(Date.now() + 15 * 60_000).toISOString();
    data.mode = data.mode || "replace";
    if (!["replace", "append"].includes(data.mode as string))
      return { error: true, message: `Invalid mode "${data.mode}". Use "replace" or "append".` };
    delete data.token;
    return data;
  },
};

// === Public API ===

export function applyKernelRules(
  pattern: string,
  operation: string,
  data: Record<string, unknown>,
  ctx: KernelContext,
): HookResult {
  const rule = IMMUTABLE[pattern];
  if (rule) {
    for (const field of rule.fields) {
      if (field in data) return { error: true, message: rule.message };
    }
  }

  if (operation === "create" && ON_CREATE[pattern]) {
    return ON_CREATE[pattern](data, ctx);
  }

  return data;
}
