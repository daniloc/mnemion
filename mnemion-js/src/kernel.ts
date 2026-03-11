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

export const IMMUTABLE: Record<string, { fields: string[]; message: string }> = {
  _system_docs: {
    fields: ["default_content"],
    message: "default_content is immutable. It preserves the original seed for recovery.",
  },
};

// === Create hooks — validate + transform before INSERT ===

const ON_CREATE: Record<string, CreateHook> = {
  _access_tokens(data, ctx) {
    const scope = (data.scope as string) || "*";
    data.scope = scope;

    // Auto-generate token — never accept from input
    delete data.token;

    // Scope-specific validation
    if (scope === "upload" || scope.startsWith("upload:")) {
      let constraints = data.constraints;
      if (typeof constraints === "string") {
        try { constraints = JSON.parse(constraints); } catch {
          return { error: true, message: "constraints must be valid JSON" };
        }
      }
      if (!constraints || typeof constraints !== "object")
        return { error: true, message: "upload scope requires constraints: {target_pattern, target_id, target_facet}" };
      const c = constraints as Record<string, unknown>;
      if (!c.target_pattern || c.target_id == null || !c.target_facet)
        return { error: true, message: "upload constraints require target_pattern, target_id, and target_facet" };
      if (!ctx.patternExists(c.target_pattern as string))
        return { error: true, message: `Target pattern "${c.target_pattern}" does not exist` };
      if (!ctx.entryExists(c.target_pattern as string, c.target_id as number))
        return { error: true, message: `Target entry ${c.target_id} not found in "${c.target_pattern}"` };
      const meta = ctx.facetMeta(c.target_pattern as string, c.target_facet as string);
      if (!meta)
        return { error: true, message: `Facet "${c.target_facet}" does not exist on "${c.target_pattern}"` };
      if (meta.type !== "text")
        return { error: true, message: `Upload target facet must be text type, "${c.target_facet}" is ${meta.type}` };
      c.mode = c.mode || "replace";
      if (!["replace", "append"].includes(c.mode as string))
        return { error: true, message: `Invalid mode "${c.mode}". Use "replace" or "append".` };
      data.constraints = JSON.stringify(c);
      // Upload tokens: 15-min TTL, single-use
      data.expires_at = data.expires_at || new Date(Date.now() + 15 * 60_000).toISOString();
      data.single_use = 1;
    }

    // Default TTL for wildcard tokens (old auth code behavior)
    if (scope === "*" && !data.expires_at) {
      const ttl = typeof data.ttl_minutes === "number" ? data.ttl_minutes : 60;
      data.expires_at = new Date(Date.now() + ttl * 60_000).toISOString();
      delete data.ttl_minutes;
    }

    // Marketplace tokens: store plugin scope in constraints
    if (scope === "marketplace" || scope.startsWith("marketplace:")) {
      if (data.plugins) {
        data.constraints = JSON.stringify({ plugins: data.plugins });
        delete data.plugins;
      }
    }

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

  _shared(data, ctx) {
    if (!data.source_pattern) return { error: true, message: "source_pattern is required for _shared" };
    if (data.source_id == null) return { error: true, message: "source_id is required for _shared" };
    if (!ctx.patternExists(data.source_pattern as string))
      return { error: true, message: `Pattern "${data.source_pattern}" does not exist` };
    if (!ctx.entryExists(data.source_pattern as string, data.source_id as number))
      return { error: true, message: `Entry ${data.source_id} not found in "${data.source_pattern}"` };
    const vis = data.visibility || "public";
    if (!["public", "unlisted"].includes(vis as string))
      return { error: true, message: `Invalid visibility "${vis}". Use "public" or "unlisted".` };
    data.visibility = vis;
    return data;
  },
};

// === Scope matching ===

/** Check if tokenScope grants access for requiredScope. Hierarchical prefix match with : boundary. */
export function scopeMatches(tokenScope: string, requiredScope: string): boolean {
  if (tokenScope === "*") return true;
  if (tokenScope === requiredScope) return true;
  if (requiredScope.startsWith(tokenScope + ":")) return true;
  return false;
}

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
