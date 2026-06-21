// Structured logging over Cloudflare Workers Logs.
//
// The `[observability]` block in wrangler.toml turns on Workers Logs, which
// ingests every console.* line for 7 days AND (invocation_logs) attaches the
// per-request envelope — method, url, status, outcome, ray id — automatically.
// So a log site only emits the EVENT plus its own context; request identity is
// never re-derived here.
//
// This is the ONE home for log SHAPE: every sink emits a single JSON object with
// a stable `event` key (so the dashboard can group/filter by it) plus an
// `error`/`stack` when a throwable is attached. Use `logError` at a caught
// failure worth investigating; `logWarn` for a degraded-but-handled path (a
// swallowed side effect, a fallback taken, a capability unavailable) that would
// otherwise vanish silently. Keep `event` a short stable slug
// (`mutate.write_failed`, `prime.embed_failed`), not a sentence.

export type LogFields = Record<string, unknown>;

function serializeErr(err: unknown): LogFields {
  if (err instanceof Error) return { error: err.message, name: err.name, stack: err.stack };
  return { error: String(err) };
}

function emit(
  level: "error" | "warn",
  event: string,
  fields: LogFields | undefined,
  err: unknown,
  hasErr: boolean,
): void {
  const payload: LogFields = { event, ...(fields ?? {}) };
  if (hasErr) Object.assign(payload, serializeErr(err));
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else console.warn(line);
}

/** A caught failure worth investigating. `err` is the throwable (serialized to
 *  message/name/stack); `fields` add structured context (ids, the op, the path). */
export function logError(event: string, err?: unknown, fields?: LogFields): void {
  emit("error", event, fields, err, arguments.length >= 2);
}

/** A degraded-but-handled path that must not vanish silently (a swallowed
 *  side-effect failure, a fallback taken, an optional capability unavailable). */
export function logWarn(event: string, fields?: LogFields, err?: unknown): void {
  emit("warn", event, fields, err, arguments.length >= 3);
}
