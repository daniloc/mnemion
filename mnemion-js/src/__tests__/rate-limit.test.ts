// rateLimit helper contract — the public-surface cost guard. The local miniflare
// limiter always succeeds, so the 429 + fail-open branches are tested here against a
// stub RateLimit. The helper FAILS OPEN (returns null = allow) whenever the limiter
// is absent or throws, because rate limiting is an operational guard, not a security
// boundary, and must never take down a deploy/test env that doesn't provide it.
import { describe, it, expect } from "vitest";
import { rateLimit } from "../../shared/Routing/router";

const stub = (outcome: { success: boolean } | Error) =>
  ({ limit: async () => { if (outcome instanceof Error) throw outcome; return outcome; } } as unknown as RateLimit);

describe("rateLimit guard", () => {
  it("allows (null) when the limiter reports success", async () => {
    expect(await rateLimit(stub({ success: true }), "k")).toBeNull();
  });

  it("returns 429 with Retry-After when the limiter rejects", async () => {
    const r = await rateLimit(stub({ success: false }), "k");
    expect(r).not.toBeNull();
    expect(r!.status).toBe(429);
    expect(r!.headers.get("Retry-After")).toBe("60");
  });

  it("fails OPEN (null) when the binding is absent", async () => {
    expect(await rateLimit(undefined, "k")).toBeNull();
  });

  it("fails OPEN (null) when the limiter throws", async () => {
    expect(await rateLimit(stub(new Error("limiter unavailable")), "k")).toBeNull();
  });
});
