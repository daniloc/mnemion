// OAuth bearer on Auth.SESSION routes — the native-client twin of the session
// cookie. A native app (iOS/macOS/visionOS) completes the same /authorize passkey
// flow MCP clients use and presents the resulting access token as a Bearer on
// /api/* and /ws. The gate must attribute writes to the granting member and fail
// CLOSED on everything else: unknown token, foreign hive, an audience bound to
// another resource (an MCP token replayed at /api), and a member suspended after
// the grant was issued.
//
// The router is driven directly with a stub OAUTH_PROVIDER (the provider's
// token crypto is library code; the decisions here are ours) and the real HiveDO
// for roster state.
import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createRouter, Method, Auth, type Env } from "../../shared/Routing/router";
import { HIVE_ID } from "../../shared/core/constants";
import type { HiveDO } from "../../entities/Hive/hive";

type Grant = { audience?: string | string[]; grant: { props: { hiveId?: string; actor?: string } } };

function routerWith(tokens: Record<string, Grant>, extra: Partial<Env> & { DEV?: string } = {}) {
  const dispatch = createRouter([
    { method: Method.GET, pattern: "/api/whoami", auth: Auth.SESSION, handler: async (ctx) => Response.json({ actor: ctx.actor }) },
  ]);
  const testEnv = {
    ...env,
    MNEMION_SECRET: "test-secret",
    OAUTH_PROVIDER: { unwrapToken: async (t: string) => tokens[t] ?? null },
    ...extra,
  } as unknown as Env;
  return (headers: Record<string, string> = {}) =>
    dispatch(new Request("https://hive.test/api/whoami", { headers }), testEnv);
}

const grant = (actor: string, more: Partial<Grant> = {}): Grant =>
  ({ grant: { props: { hiveId: HIVE_ID, actor } }, ...more });

function hive(): DurableObjectStub<HiveDO> {
  return env.MNEMION_HIVE.get(env.MNEMION_HIVE.idFromName(HIVE_ID)) as DurableObjectStub<HiveDO>;
}

describe("session bearer gate", () => {
  it("a valid OAuth bearer authenticates as the granting member", async () => {
    const call = routerWith({ ownerTok: grant("owner") });
    const res = await call({ Authorization: "Bearer ownerTok" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actor: "owner" });
  });

  it("an unknown bearer is a 401, never a cookie redirect or owner fallback", async () => {
    const res = await routerWith({})({ Authorization: "Bearer nope" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("invalid_token");
  });

  it("refuses a grant for another hive", async () => {
    const res = await routerWith({ t: { grant: { props: { hiveId: "user:other", actor: "owner" } } } })({ Authorization: "Bearer t" });
    expect(res.status).toBe(401);
  });

  it("refuses a token bound to another resource (MCP token replayed at /api)", async () => {
    const call = routerWith({
      mcp: grant("owner", { audience: "https://hive.test/mcp" }),
      root: grant("owner", { audience: "https://hive.test/" }),
      api: grant("owner", { audience: ["https://hive.test/api"] }),
      foreign: grant("owner", { audience: "https://evil.test/" }),
    });
    expect((await call({ Authorization: "Bearer mcp" })).status).toBe(401);
    expect((await call({ Authorization: "Bearer foreign" })).status).toBe(401);
    expect((await call({ Authorization: "Bearer root" })).status).toBe(200);
    expect((await call({ Authorization: "Bearer api" })).status).toBe(200);
  });

  it("re-checks the roster per request: suspending a member revokes their bearer", async () => {
    const store = hive();
    const m = JSON.parse(await store.mutate("_members", "create", JSON.stringify({ label: "ios-sam", display_name: "Sam" })));
    const call = routerWith({ samTok: grant("ios-sam") });
    expect(await (await call({ Authorization: "Bearer samTok" })).json()).toEqual({ actor: "ios-sam" });

    await store.mutate("_members", "update", JSON.stringify({ id: m.entry.id, version: m.entry.version, status: "suspended" }));
    expect((await call({ Authorization: "Bearer samTok" })).status).toBe(401);
  });

  it("refuses a grant for a member who was never on the roster", async () => {
    expect((await routerWith({ t: grant("ghost") })({ Authorization: "Bearer t" })).status).toBe(401);
  });

  it("without a Bearer header the cookie path is unchanged (redirect to login)", async () => {
    const res = await routerWith({ t: grant("owner") })();
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/login");
  });

  it("an unconfigured instance stays closed even with a valid-looking bearer", async () => {
    const call = routerWith({ t: grant("owner") }, { MNEMION_SECRET: "" });
    expect((await call({ Authorization: "Bearer t" })).status).toBe(503);
    // and through the real worker (no secret, no DEV in the test env)
    expect((await SELF.fetch("https://test.local/api/index", { headers: { Authorization: "Bearer a:b:c" } })).status).toBe(503);
  });

  it("explicit dev mode still validates a presented bearer", async () => {
    const call = routerWith({ t: grant("owner") }, { MNEMION_SECRET: "", DEV: "true" });
    expect((await call({ Authorization: "Bearer t" })).status).toBe(200);
    expect((await call({ Authorization: "Bearer bad" })).status).toBe(401);
    expect((await call()).status).toBe(200); // dev auto-approve without a bearer, as before
  });
});
