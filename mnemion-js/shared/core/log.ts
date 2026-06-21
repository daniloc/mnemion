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

/** Does this value look like a throwable worth serializing as an error (rather
 *  than spreading as a fields record)? */
function isThrowable(v: unknown): boolean {
  return v instanceof Error || (typeof v === "object" && v !== null && "stack" in v);
}

function emit(
  level: "error" | "warn",
  event: string,
  fields: LogFields | undefined,
  err: unknown,
): void {
  // Defensive against the positional asymmetry between logError (err is arg2) and
  // logWarn (err is arg3): if a caller passes a throwable into the `fields` slot,
  // serialize it as an error instead of spreading its enumerable props as fields
  // (which would drop the message/stack). An explicit `err` always wins.
  let errToSerialize = err;
  let fieldsToSpread = fields;
  if (err === undefined && isThrowable(fields)) {
    errToSerialize = fields;
    fieldsToSpread = undefined;
  }

  const payload: LogFields = { event, ...(fieldsToSpread ?? {}) };
  if (errToSerialize !== undefined) Object.assign(payload, serializeErr(errToSerialize));
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else console.warn(line);
}

/** A caught failure worth investigating. `err` is the throwable (serialized to
 *  message/name/stack); `fields` add structured context (ids, the op, the path). */
export function logError(event: string, err?: unknown, fields?: LogFields): void {
  emit("error", event, fields, err);
}

/** A degraded-but-handled path that must not vanish silently (a swallowed
 *  side-effect failure, a fallback taken, an optional capability unavailable). */
export function logWarn(event: string, fields?: LogFields, err?: unknown): void {
  emit("warn", event, fields, err);
}
