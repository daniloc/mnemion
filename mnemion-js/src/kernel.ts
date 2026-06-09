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

// === Internal patterns — written only by the system, never via agent mutate ===
//
// These are caches/audit logs maintained by internal code (direct SQL), not part
// of the agent API. Letting an agent mutate them is dangerous: e.g. planting a
// _web_cache row would make resolve() serve attacker-chosen content as a trusted
// cache hit (and embed it into prime recall). Legitimate writers bypass the
// mutate path, so this denylist costs them nothing.
export const INTERNAL_WRITE_PROTECTED = new Set<string>([
  "_web_cache",
  "_fragment_access_log",
  "_entry_access_log",
  "_mutation_log",
  "_schema_history",
  "_pending_changes",
]);

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
      if ((c.target_pattern as string).startsWith("_"))
        return { error: true, message: `Upload tokens cannot target kernel pattern "${c.target_pattern}" — uploads write user patterns only.` };
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
    const vis = (data.visibility as string) || "public";
    if (!["public", "unlisted", "private"].includes(vis))
      return { error: true, message: `Invalid visibility "${vis}". Use "public", "unlisted", or "private".` };
    data.visibility = vis;
    return data;
  },

  _inputs(data, ctx) {
    if (!data.path) return { error: true, message: "path is required for _inputs" };
    if (!data.target_pattern) return { error: true, message: "target_pattern is required for _inputs" };
    if ((data.target_pattern as string).startsWith("_"))
      return { error: true, message: `Ingress cannot target kernel pattern "${data.target_pattern}" — inputs write user patterns only.` };
    if (!ctx.patternExists(data.target_pattern as string))
      return { error: true, message: `Target pattern "${data.target_pattern}" does not exist` };
    if (data.facet_mapping && typeof data.facet_mapping === "string") {
      try { JSON.parse(data.facet_mapping as string); } catch {
        return { error: true, message: "facet_mapping must be valid JSON" };
      }
    }
    if (data.body_facet && !ctx.facetMeta(data.target_pattern as string, data.body_facet as string))
      return { error: true, message: `Facet "${data.body_facet}" does not exist on "${data.target_pattern}"` };
    const vis = (data.visibility as string) || "public";
    if (!["public", "unlisted", "private"].includes(vis))
      return { error: true, message: `Invalid visibility "${vis}". Use "public", "unlisted", or "private".` };
    data.visibility = vis;
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

  _publications(data, ctx) {
    if (!data.path || typeof data.path !== "string" || !(data.path as string).trim())
      return { error: true, message: "path is required for _publications (served at GET /p/{path})" };
    data.path = (data.path as string).trim().replace(/^\/+/, "");
    if (!data.source_pattern || typeof data.source_pattern !== "string")
      return { error: true, message: "source_pattern is required for _publications" };
    if ((data.source_pattern as string).startsWith("_"))
      return { error: true, message: `Kernel pattern "${data.source_pattern}" cannot be published — publications project user patterns only.` };
    if (!ctx.patternExists(data.source_pattern as string))
      return { error: true, message: `Pattern "${data.source_pattern}" does not exist` };
    if (!data.format || !["html", "rss", "json", "markdown"].includes(data.format as string))
      return { error: true, message: `format is required for _publications. Use "html", "rss", "json", or "markdown".` };
    if (data.filters != null) {
      try {
        const parsed = JSON.parse(data.filters as string);
        if (!Array.isArray(parsed) || parsed.some((f) => typeof f !== "string"))
          return { error: true, message: 'filters must be a JSON array of filter strings, e.g. ["status=done"]' };
      } catch {
        return { error: true, message: "filters must be valid JSON (an array of filter strings)" };
      }
    }
    if (data.limit != null && (typeof data.limit !== "number" || !(data.limit > 0)))
      return { error: true, message: "limit must be a positive number" };
    const vis = (data.visibility as string) || "public";
    if (!["public", "unlisted", "private"].includes(vis))
      return { error: true, message: `Invalid visibility "${vis}". Use "public", "unlisted", or "private".` };
    data.visibility = vis;
    return data;
  },

  _maintenance_passes(data) {
    if (!data.summary || typeof data.summary !== "string" || !(data.summary as string).trim())
      return { error: true, message: "summary is required — record what was reviewed and changed in this maintenance pass" };
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

/** True if an IPv4 address (by its high two octets) is in a non-public range. */
function isPrivateIPv4(a: number, b: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;   // this-network, private, loopback
  if (a === 169 && b === 254) return true;             // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;    // private
  if (a === 192 && b === 168) return true;             // private
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT
  return false;
}

/**
 * Parse an IPv4 literal in any inet_aton form (dotted 1-4 parts in decimal/octal/
 * hex, or a single integer) to its high two octets. Returns null when the string
 * is not an all-numeric IP literal (i.e. it is a hostname). WHATWG URL already
 * normalizes these to dotted-decimal, but we do not rely on that.
 */
function parseIPv4Literal(h: string): { a: number; b: number } | null {
  if (h.includes(":")) return null;
  const parts = h.split(".");
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (p === "") return null;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null; // not numeric -> hostname, not an IP literal
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  let value: number;
  if (nums.length === 1) value = nums[0];
  else if (nums.length === 2) value = (nums[0] << 24) | (nums[1] & 0xffffff);
  else if (nums.length === 3) value = (nums[0] << 24) | ((nums[1] & 0xff) << 16) | (nums[2] & 0xffff);
  else value = (nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3];
  value = value >>> 0;
  return { a: (value >>> 24) & 0xff, b: (value >>> 16) & 0xff };
}

/**
 * Expand an IPv6 literal (brackets already stripped, optional zone id) to its 16
 * bytes, handling :: compression and a trailing embedded IPv4 (::ffff:1.2.3.4 /
 * ::1.2.3.4). Returns null for anything that is not a well-formed IPv6 literal.
 */
function parseIPv6Literal(str: string): number[] | null {
  let s = str.toLowerCase().split("%")[0]; // strip zone id (fe80::1%eth0)
  if (s.length === 0) return null;
  // Embedded IPv4 in the trailing 32 bits -> rewrite as two hextets.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = tail.split(".");
    if (v4.length !== 4) return null;
    const o: number[] = [];
    for (const part of v4) {
      if (!/^\d{1,3}$/.test(part)) return null;
      const n = Number(part);
      if (n > 255) return null;
      o.push(n);
    }
    s = s.slice(0, lastColon + 1) +
      (((o[0] << 8) | o[1]).toString(16)) + ":" + (((o[2] << 8) | o[3]).toString(16));
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const hasGap = halves.length === 2;
  const back = hasGap ? (halves[1] ? halves[1].split(":") : []) : [];
  let hextets: string[];
  if (hasGap) {
    const missing = 8 - head.length - back.length;
    if (missing < 1) return null; // :: must stand for at least one zero group
    hextets = [...head, ...Array(missing).fill("0"), ...back];
  } else {
    hextets = head;
  }
  if (hextets.length !== 8) return null;
  const bytes: number[] = [];
  for (const h of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    const n = parseInt(h, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

/** True if a 16-byte IPv6 address is loopback/unspecified/ULA/link-local, or an
 *  embedded (mapped/compatible/NAT64) private IPv4. */
function isBlockedIPv6Bytes(b: number[]): boolean {
  const firstZero = (n: number) => b.slice(0, n).every((x) => x === 0);
  if (firstZero(15) && (b[15] === 0 || b[15] === 1)) return true;        // :: and ::1
  if ((b[0] & 0xfe) === 0xfc) return true;                               // ULA fc00::/7
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;              // link-local fe80::/10
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true;              // site-local fec0::/10 (deprecated)
  if (firstZero(10) && b[10] === 0xff && b[11] === 0xff)                 // IPv4-mapped ::ffff:0:0/96
    return isPrivateIPv4(b[12], b[13]);
  if (firstZero(12)) return isPrivateIPv4(b[12], b[13]);                 // IPv4-compatible ::/96 (deprecated)
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b &&   // NAT64 64:ff9b::/96
      b.slice(4, 12).every((x) => x === 0))
    return isPrivateIPv4(b[12], b[13]);
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateIPv4(b[2], b[3]);  // 6to4 2002::/16 wrapping a private v4
  return false;
}

/**
 * True if a federation target points at a loopback, private, link-local, or
 * internal-only host. Such hosts can never be added to the allow-list and are
 * refused at resolve time - defense against SSRF and against an agent acting on
 * prompt-injected content probing internal infrastructure or cloud metadata.
 *
 * The host is normalized through the same URL parser fetch() uses, so the check
 * operates on the exact host the network stack will contact (handles userinfo,
 * ports, IPv4 in any base, IPv6 brackets, case). Anything unparseable as a host
 * fails closed (blocked). A public hostname whose DNS resolves to a private IP
 * cannot be caught here (no DNS API on Workers); that residual is covered by the
 * federation consent allow-list and per-hop redirect re-validation.
 */
export function isBlockedFederationHost(host: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(`https://${host}`).hostname.toLowerCase();
  } catch {
    return true; // not a parseable host -> refuse
  }

  // Strip a single trailing dot — "localhost." / "box.local." are the FQDN-root
  // form and resolve identically to the dotless name.
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);

  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".lan")) return true;

  // IPv6 literal - WHATWG keeps the brackets on .hostname
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const bytes = parseIPv6Literal(hostname.slice(1, -1));
    if (!bytes) return true; // malformed IPv6 literal -> refuse
    return isBlockedIPv6Bytes(bytes);
  }

  // IPv4 literal in any base
  const v4 = parseIPv4Literal(hostname);
  if (v4 && isPrivateIPv4(v4.a, v4.b)) return true;

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
