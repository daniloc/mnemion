// Structured-log shape + the positional-asymmetry footgun.
//
// logError(event, err?, fields?)  — err is arg2
// logWarn(event, fields?, err?)   — err is arg3
// The two helpers carry the throwable in DIFFERENT positions. A caller who writes
// `logWarn(event, err)` (treating it like logError) would have spread the Error
// object as a fields record and dropped its message/stack. The emit() hardening
// neutralizes that: a throwable landing in the `fields` slot (no explicit err) is
// serialized as an error instead of spread. Detection is now `err !== undefined`,
// not `arguments.length`, so forwarding/normalization is safe.
import { describe, it, expect, vi, afterEach } from "vitest";
import { logError, logWarn } from "../../shared/core/log";

function lastJson(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const calls = spy.mock.calls;
  expect(calls.length, "the sink must have been called").toBeGreaterThan(0);
  const line = calls[calls.length - 1][0];
  expect(typeof line, "the sink must receive a single JSON string").toBe("string");
  return JSON.parse(line as string);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logError", () => {
  it("serializes an Error's message/name/stack", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new TypeError("boom");
    logError("mutate.write_failed", err);

    const payload = lastJson(spy);
    expect(payload.event).toBe("mutate.write_failed");
    expect(payload.error).toBe("boom");
    expect(payload.name).toBe("TypeError");
    expect(typeof payload.stack).toBe("string");
    expect(payload.stack as string).toContain("boom");
    // No undefined garbage.
    expect("event" in payload && payload.event !== undefined).toBe(true);
  });

  it("merges fields alongside the serialized error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("prime.embed_failed", new Error("nope"), { id: 7, op: "embed" });

    const payload = lastJson(spy);
    expect(payload.event).toBe("prime.embed_failed");
    expect(payload.id).toBe(7);
    expect(payload.op).toBe("embed");
    expect(payload.error).toBe("nope");
  });

  it("with no error emits just event + fields (no error keys)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("some.event");

    const payload = lastJson(spy);
    expect(payload.event).toBe("some.event");
    expect("error" in payload).toBe(false);
    expect("stack" in payload).toBe(false);
  });
});

describe("logWarn", () => {
  it("logs a plain fields record (the normal arg2 use)", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logWarn("fallback.taken", { reason: "no-r2", path: "/f" });

    const payload = lastJson(spy);
    expect(payload.event).toBe("fallback.taken");
    expect(payload.reason).toBe("no-r2");
    expect(payload.path).toBe("/f");
    // A plain record is NOT an error — no error keys leak in.
    expect("error" in payload).toBe(false);
    expect("stack" in payload).toBe(false);
  });

  it("FOOTGUN NEUTRALIZED: an Error passed in the fields slot is serialized as an error", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = new RangeError("out of range");
    // The asymmetric misuse: caller treats logWarn like logError.
    logWarn("capability.unavailable", err);

    const payload = lastJson(spy);
    expect(payload.event).toBe("capability.unavailable");
    // It is serialized as an error — message AND name AND stack survive...
    expect(payload.error).toBe("out of range");
    expect(payload.name).toBe("RangeError");
    expect(typeof payload.stack).toBe("string");
    // ...and the Error's enumerable props were NOT blindly spread as fields
    // (an Error has no own enumerable message/name; spreading it would have lost them).
  });

  it("an explicit err in arg3 still wins (normal three-arg use)", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logWarn("side_effect.swallowed", { entry: 42 }, new Error("downstream"));

    const payload = lastJson(spy);
    expect(payload.event).toBe("side_effect.swallowed");
    expect(payload.entry).toBe(42);
    expect(payload.error).toBe("downstream");
    expect(typeof payload.stack).toBe("string");
  });

  it("with no fields/err emits just the event (no undefined garbage)", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logWarn("bare.event");

    const payload = lastJson(spy);
    expect(payload.event).toBe("bare.event");
    expect("error" in payload).toBe(false);
    // No literal 'undefined' or undefined-valued keys.
    expect(JSON.stringify(payload).includes("undefined")).toBe(false);
    expect(Object.values(payload).every((v) => v !== undefined)).toBe(true);
  });
});
