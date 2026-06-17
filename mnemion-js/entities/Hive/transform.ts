// Transform DSL for ingress field mapping.
// Expressions: dot.path | transform arg | transform arg
// Resolvers: foo.bar, $header.X-Name, $query.param, $body, $now, "literal"
// Transforms: truncate N, lower, upper, default "value", json, join ", "
//
// @why A tiny declarative DSL for ingress field mapping so an _inputs endpoint
// can shape arbitrary inbound payloads into pattern facets without code — the
// mapping is data on the endpoint, evaluated at request time. Resolvers and
// transforms are a closed, side-effect-free set so an agent-authored mapping
// can't reach beyond the request envelope.

export interface TransformContext {
  body: unknown;                    // parsed JSON body (or null)
  rawBody: string;                  // raw body string
  headers: Record<string, string>;  // request headers (plain object for RPC)
  query: Record<string, string>;    // query parameters (plain object for RPC)
}

/** Split expression on | but respect quoted strings. */
function splitPipes(expr: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
    } else if (ch === "|") {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts.filter((p) => p.length > 0);
}

/** Walk a dot-separated path into an object. */
function dotPath(obj: unknown, path: string): unknown {
  let current = obj;
  for (const key of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Resolve the left-hand side (before any pipes). */
function resolve(expr: string, ctx: TransformContext): unknown {
  // Quoted literal
  if ((expr.startsWith('"') && expr.endsWith('"')) || (expr.startsWith("'") && expr.endsWith("'"))) {
    return expr.slice(1, -1);
  }

  // Special variables
  if (expr === "$body") return ctx.rawBody;
  if (expr === "$now") return new Date().toISOString();

  if (expr.startsWith("$header.")) {
    const name = expr.slice(8);
    // Case-insensitive header lookup
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(ctx.headers)) {
      if (k.toLowerCase() === lower) return v;
    }
    return undefined;
  }

  if (expr.startsWith("$query.")) {
    return ctx.query[expr.slice(7)] ?? undefined;
  }

  // Dot-path into body
  return dotPath(ctx.body, expr);
}

/** Extract a quoted string argument from a transform, e.g. default "hello" → hello */
function extractQuotedArg(arg: string): string {
  const trimmed = arg.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Apply a single transform to a value. */
function applyTransform(value: unknown, transform: string): unknown {
  const spaceIdx = transform.indexOf(" ");
  const name = spaceIdx === -1 ? transform : transform.slice(0, spaceIdx);
  const arg = spaceIdx === -1 ? "" : transform.slice(spaceIdx + 1).trim();

  switch (name) {
    case "truncate": {
      const n = parseInt(arg, 10);
      if (isNaN(n)) return value;
      return String(value ?? "").slice(0, n);
    }
    case "lower":
      return String(value ?? "").toLowerCase();
    case "upper":
      return String(value ?? "").toUpperCase();
    case "default":
      return value == null ? extractQuotedArg(arg) : value;
    case "json":
      try { return JSON.parse(String(value)); } catch { return value; }
    case "join": {
      const sep = extractQuotedArg(arg);
      return Array.isArray(value) ? value.join(sep) : value;
    }
    default:
      return value;
  }
}

/** Evaluate a single DSL expression against a context. */
export function evaluateExpression(expression: string, ctx: TransformContext): unknown {
  const parts = splitPipes(expression);
  if (parts.length === 0) return undefined;

  let value = resolve(parts[0], ctx);
  for (let i = 1; i < parts.length; i++) {
    value = applyTransform(value, parts[i]);
  }
  return value;
}

/** Evaluate a field mapping (object of field→expression) against a context. */
export function evaluateMapping(
  mapping: Record<string, string>,
  ctx: TransformContext,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [field, expr] of Object.entries(mapping)) {
    const value = evaluateExpression(expr, ctx);
    if (value !== undefined) {
      result[field] = value;
    }
  }
  return result;
}
