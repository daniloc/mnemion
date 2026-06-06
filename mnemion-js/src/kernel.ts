// Kernel pattern pre-mutation rules
//
// Declarative hooks that validate and transform data before the generic
// INSERT/UPDATE/ARCHIVE logic in store.ts runs. Each kernel table's
// special behavior is visible in one place.

export interface KernelContext {
  patternExists(name: string): boolean;
  facetMeta(pattern: string, facet: string): { type: string; options?: string[] } | null;
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

  _links(data, ctx) {
    // Accept shorthand: source: "pattern/id", target: "pattern/id"
    if (data.source && typeof data.source === "string") {
      const parts = (data.source as string).split("/");
      if (parts.length !== 2) return { error: true, message: `Invalid source format "${data.source}". Use "pattern/id".` };
      data.source_pattern = parts[0];
      data.source_id = Number(parts[1]);
      delete data.source;
    }
    if (data.target && typeof data.target === "string") {
      const parts = (data.target as string).split("/");
      if (parts.length !== 2) return { error: true, message: `Invalid target format "${data.target}". Use "pattern/id".` };
      data.target_pattern = parts[0];
      data.target_id = Number(parts[1]);
      delete data.target;
    }

    if (!data.source_pattern) return { error: true, message: "source is required (e.g. source: \"tasks/6\")" };
    if (data.source_id == null) return { error: true, message: "source is required (e.g. source: \"tasks/6\")" };
    if (!data.target_pattern) return { error: true, message: "target is required (e.g. target: \"goals/9\")" };
    if (data.target_id == null) return { error: true, message: "target is required (e.g. target: \"goals/9\")" };

    if (!ctx.patternExists(data.source_pattern as string))
      return { error: true, message: `Source pattern "${data.source_pattern}" does not exist` };
    if (!ctx.entryExists(data.source_pattern as string, data.source_id as number))
      return { error: true, message: `Source entry ${data.source_id} not found in "${data.source_pattern}"` };
    if (!ctx.patternExists(data.target_pattern as string))
      return { error: true, message: `Target pattern "${data.target_pattern}" does not exist` };
    if (!ctx.entryExists(data.target_pattern as string, data.target_id as number))
      return { error: true, message: `Target entry ${data.target_id} not found in "${data.target_pattern}"` };

    return data;
  },

  _short_term_fragments(data) {
    if (!data.content) return { error: true, message: "content is required for _short_term_fragments" };
    return data;
  },

  _web_cache(data) {
    if (!data.url) return { error: true, message: "url is required for _web_cache" };
    if (!data.content) return { error: true, message: "content is required for _web_cache" };
    if (!data.source_adapter) return { error: true, message: "source_adapter is required for _web_cache" };
    if (!data.fetched_at) data.fetched_at = new Date().toISOString();
    return data;
  },

  _canvases(data) {
    if (!data.name) return { error: true, message: "name is required for _canvases" };
    if (!data.snapshot) data.snapshot = '{}';
    return data;
  },

  _system_tasks(data) {
    if (!data.task) return { error: true, message: "task is required" };
    data.status = "pending";
    delete data.result;
    return data;
  },

  _federation_hosts(data) {
    if (!data.host || typeof data.host !== "string")
      return { error: true, message: "host is required for _federation_hosts (e.g. \"other.hive.dev\")" };
    const host = normalizeHost(data.host as string);
    if (!host) return { error: true, message: "host is required for _federation_hosts" };
    if (/\s/.test(host) || host.includes("/"))
      return { error: true, message: `Invalid federation host "${data.host}"` };
    if (!host.includes("."))
      return { error: true, message: `Federation host "${host}" must be a fully-qualified domain — federation is recognized by a dot in the host segment.` };
    if (isBlockedFederationHost(host))
      return { error: true, message: `Cannot add non-public host "${host}" to the federation allow-list (loopback/private/link-local/internal hosts are never federatable).` };
    data.host = host;
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

// === Mutate shortcuts — kernel-level aliases for common operations ===

export interface Shortcut { pattern: string; operation: string }

export const SHORTCUTS: Record<string, Shortcut> = {
  fragment: { pattern: "_short_term_fragments", operation: "create" },
  link:     { pattern: "_links", operation: "create" },
  unlink:   { pattern: "_links", operation: "unlink" },
};

/** Expand a shortcut name to pattern + operation, or return null if not a shortcut. */
export function expandShortcut(name: string): Shortcut | null {
  return SHORTCUTS[name] ?? null;
}

// === Federation host validation ===

/** Normalize a federation host: lowercase, strip scheme and any path. */
export function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/\/.*$/, "");
}

/**
 * True if a federation target points at a loopback, private, link-local, or
 * internal-only host. Such hosts can never be added to the allow-list and are
 * refused at resolve time — defense against SSRF and against an agent acting on
 * prompt-injected content probing internal infrastructure or cloud metadata.
 */
export function isBlockedFederationHost(host: string): boolean {
  // Strip an optional :port and IPv6 brackets.
  const bare = host.replace(/^\[/, "").replace(/\](:\d+)?$/, "").split(":")[0].toLowerCase();

  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  if (bare.endsWith(".local") || bare.endsWith(".internal") || bare.endsWith(".lan")) return true;

  // IPv6 loopback / unique-local / link-local
  if (bare === "::1" || bare.startsWith("fc") || bare.startsWith("fd") || bare.startsWith("fe80")) return true;

  // IPv4 literals in non-public ranges
  const m = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;   // this-network, private, loopback
    if (a === 169 && b === 254) return true;             // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;    // private
    if (a === 192 && b === 168) return true;             // private
    if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT
  }

  return false;
}

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
