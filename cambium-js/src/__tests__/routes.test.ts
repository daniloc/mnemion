import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("HTTP Routes (unauthenticated)", () => {
  it("returns 404 for root", async () => {
    const res = await SELF.fetch("https://test.local/");
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown paths", async () => {
    const res = await SELF.fetch("https://test.local/random/path");
    expect(res.status).toBe(404);
  });

  it("returns 404 for GET on upload path", async () => {
    const res = await SELF.fetch("https://test.local/upload/abc123");
    expect(res.status).toBe(404);
  });

  it("returns 400 for POST on upload with invalid token", async () => {
    const res = await SELF.fetch("https://test.local/upload/abc123", {
      method: "POST",
      body: "test content",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe(true);
  });

  it("rejects non-hex upload tokens", async () => {
    const res = await SELF.fetch("https://test.local/upload/not-hex!", {
      method: "POST",
      body: "test",
    });
    // Should be 404 because regex doesn't match
    expect(res.status).toBe(404);
  });
});

describe("Public Marketplace", () => {
  it("serves info/refs on public marketplace", async () => {
    const res = await SELF.fetch(
      "https://test.local/marketplace/public/info/refs?service=git-upload-pack"
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/x-git-upload-pack-advertisement"
    );
  });

  it("rejects non-upload-pack services", async () => {
    const res = await SELF.fetch(
      "https://test.local/marketplace/public/info/refs?service=git-receive-pack"
    );
    // This goes through handleMarketplaceGit which returns 403 for unsupported services
    expect(res.status).toBe(403);
  });
});

describe("Dev Mode", () => {
  // These tests run without CAMBIUM_SECRET, so dev mode is active

  it("serves private marketplace without auth in dev mode", async () => {
    const res = await SELF.fetch(
      "https://test.local/marketplace/info/refs?service=git-upload-pack"
    );
    expect(res.status).toBe(200);
  });
});
