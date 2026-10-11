import { describe, expect, it } from "vitest";
import { readLimitedBody } from "../../shared/Routing/routes/io";

describe("request body limit", () => {
  it("rejects an oversized body without Content-Length before buffering it all", async () => {
    const request = new Request("https://example.test/i/notes", { method: "POST", body: "abcdef" });
    expect(request.headers.has("content-length")).toBe(false);
    expect(await readLimitedBody(request, 5)).toBeNull();
  });

  it("accepts a body at the limit and rejects an oversized Content-Length", async () => {
    const exact = new Request("https://example.test/upload/token", { method: "POST", body: "abc" });
    expect(new TextDecoder().decode(await readLimitedBody(exact, 3) as ArrayBuffer)).toBe("abc");

    const declared = new Request("https://example.test/upload/token", {
      method: "POST", headers: { "Content-Length": "4" }, body: "abc",
    });
    expect(await readLimitedBody(declared, 3)).toBeNull();
  });
});
