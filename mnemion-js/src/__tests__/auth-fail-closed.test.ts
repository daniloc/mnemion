// Foundational fail-closed posture: an UNCONFIGURED instance (no MNEMION_SECRET)
// locks down its owner-only APIs instead of auto-approving every request as owner.
//
// The old default — `!MNEMION_SECRET` ⇒ dev mode ⇒ auto-approve — was fail-OPEN: a
// secretless PRODUCTION deploy served `/api/*`, `/export`, `/ws` to anyone,
// unauthenticated. Now auto-approve is opt-IN (DEV=true, set by the dev scripts +
// [env.test]); absence of configuration means NO access, not ALL access. The vitest
// worker env runs with neither MNEMION_SECRET nor DEV — i.e. the unconfigured case —
// so these Auth.SESSION routes must lock down here.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { isDevAutoApprove } from "../../shared/Routing/router";

describe("unconfigured auth fails closed", () => {
  it("isDevAutoApprove requires BOTH no-secret AND an explicit DEV=true", () => {
    expect(isDevAutoApprove({})).toBe(false);                               // unconfigured (prod) → closed
    expect(isDevAutoApprove({ DEV: "true" })).toBe(true);                   // explicit dev opt-in → open
    expect(isDevAutoApprove({ MNEMION_SECRET: "s", DEV: "true" })).toBe(false); // secret present → normal auth; DEV irrelevant
    expect(isDevAutoApprove({ DEV: "1" })).toBe(false);                     // only the exact string "true" opts in
    expect(isDevAutoApprove({ DEV: true })).toBe(false);                    // a non-string truthy value does not
  });

  it("owner-only Auth.SESSION routes return 503 when unconfigured", async () => {
    expect((await SELF.fetch("https://test.local/api/index")).status).toBe(503);
    expect((await SELF.fetch("https://test.local/api/tools")).status).toBe(503);
    expect((await SELF.fetch("https://test.local/export/anything")).status).toBe(503);
  });

  it("/authorize must NOT auto-grant an owner OAuth session when unconfigured", async () => {
    // Register an OAuth client (DCR), then drive a VALID /authorize request so
    // parseAuthRequest succeeds and we actually reach the dev-mode gate. The bug:
    // `if (!MNEMION_SECRET) completeOAuth(...)` minted a full owner grant on any
    // secretless deploy. Now it requires the explicit DEV=true opt-in; this env
    // has neither secret nor DEV, so it MUST fail closed — never a 302 redirect
    // carrying an authorization code back to the client.
    const reg = await SELF.fetch("https://test.local/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://client.example/cb"], token_endpoint_auth_method: "none" }),
    });
    expect(reg.status, "DCR should succeed").toBeLessThan(300);
    const { client_id } = (await reg.json()) as { client_id: string };

    const q = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: "https://client.example/cb",
      scope: "*",
      state: "xyz",
    });
    const res = await SELF.fetch(`https://test.local/authorize?${q}`, { redirect: "manual" });

    // The request is well-formed (DCR'd client, matching redirect_uri), so
    // parseAuthRequest succeeds and we DO reach the dev-mode gate — which now
    // fails closed. Asserting exactly 503 both pins the fail-closed outcome and
    // proves this test actually exercises the fixed gate (a 400 would mean the
    // request bailed earlier and the regression wasn't testing anything).
    expect(res.status, "unconfigured /authorize must fail closed at the dev gate").toBe(503);
    const loc = res.headers.get("Location") || "";
    expect(loc.startsWith("https://client.example/cb"), "must never redirect to the client with a code").toBe(false);
  });
});
