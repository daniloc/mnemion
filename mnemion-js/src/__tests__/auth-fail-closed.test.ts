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
});
