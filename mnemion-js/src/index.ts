import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { SessionDO } from "./session";
import { StoreDO } from "./store";
import { Method, Auth, createRouter, type Route, type Env } from "./router";

// Auth
import { authorize, authVerify, setupPage, setupBegin, setupComplete, passkeyBegin, passkeyComplete } from "./routes/auth";
// I/O
import { serveOutput, receiveInput, upload } from "./routes/io";
// Marketplace
import { seedMarketplace, marketplaceToken, marketplaceGit } from "./routes/marketplace";

// Re-export DO classes for wrangler
export { SessionDO, StoreDO };

// === Route table ===

const routes: Route[] = [
  // Auth & passkeys
  { method: Method.GET,  pattern: "/authorize",            handler: authorize },
  { method: Method.POST, pattern: "/auth/verify",          handler: authVerify },
  { method: Method.GET,  pattern: "/setup",                auth: Auth.CONFIGURED, handler: setupPage },
  { method: Method.POST, pattern: "/setup/begin",          auth: Auth.CONFIGURED, handler: setupBegin },
  { method: Method.POST, pattern: "/setup/complete",       auth: Auth.CONFIGURED, handler: setupComplete },
  { method: Method.POST, pattern: "/auth/passkey/begin",   handler: passkeyBegin },
  { method: Method.POST, pattern: "/auth/passkey/complete", handler: passkeyComplete },

  // HTTP I/O
  { method: Method.GET,  pattern: "/o/:path",              handler: serveOutput },
  { method: Method.POST, pattern: "/i/:path",              handler: receiveInput },
  { method: Method.POST, pattern: "/upload/:token",        where: { token: /^[a-fA-F0-9]+$/ }, handler: upload },

  // Marketplace
  { method: Method.ANY,  pattern: "/dev/seed-marketplace", auth: Auth.DEV, handler: seedMarketplace },
  { method: Method.ANY,  pattern: "/marketplace/token",    auth: Auth.SECRET, handler: marketplaceToken },
  { method: Method.ANY,  pattern: "/marketplace*",         handler: marketplaceGit },
];

const dispatch = createRouter(routes);

// === Export ===

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: SessionDO.serve("/mcp"),
  defaultHandler: { fetch: (request: Request, env: Env) => dispatch(request, env) },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["read", "write"],

  async resolveExternalToken({ token, env }) {
    if (!/^[a-f0-9]{32}$/.test(token)) return null;

    const storeId = (env as any).MNEMION_STORE.idFromName("user:owner");
    const store = (env as any).MNEMION_STORE.get(storeId) as DurableObjectStub<StoreDO>;
    const valid = await store.validateAuthCode(token);
    if (!valid) return null;

    return { props: { userId: "owner" } };
  },
});
