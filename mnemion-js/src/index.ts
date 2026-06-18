import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { SessionDO } from "../entities/Session/session";
import { HiveDO } from "../entities/Hive/hive";
import { HIVE_ID } from "../shared/core/constants";
import { Method, Auth, createRouter, type Route, type Env } from "../shared/Routing/router";

// Auth
import { authorize, authVerify, setupPage, setupBegin, setupComplete, passkeyBegin, passkeyComplete, loginPage, loginBegin, loginComplete, loginVerify, revokeSessions, invitePage, inviteBegin, inviteComplete } from "../shared/Routing/routes/auth";
// I/O
import { serveSharedEntry, serveOutput, servePublication, servePage, servePageOg, receiveInput, upload, uploadDocument, serveDocument, exportPattern } from "../shared/Routing/routes/io";
// Marketplace
import { seedMarketplace, marketplaceToken, marketplaceGit } from "../shared/Routing/routes/marketplace";
// Pages (JSON APIs the React SPA consumes)
import { queryIndex, queryEntries, queryTools, queryHistory, queryLabel, mutateEntry, evolveSchema, liveSocket } from "../shared/Routing/routes/pages";
// Canvas
import { canvasPage, listCanvases, saveCanvas, resolveUri } from "../shared/Routing/routes/canvas";
// Dev
import { seedTestData, seedVectors } from "../shared/Routing/routes/dev";

// Re-export DO classes for wrangler
export { SessionDO, HiveDO };

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

  // Invite approval (human passkey gate before a register token can be used)
  { method: Method.GET,  pattern: "/invite/:token",          auth: Auth.CONFIGURED, where: { token: /^[a-fA-F0-9]+$/ }, handler: invitePage },
  { method: Method.POST, pattern: "/invite/:token/begin",    auth: Auth.CONFIGURED, where: { token: /^[a-fA-F0-9]+$/ }, handler: inviteBegin },
  { method: Method.POST, pattern: "/invite/:token/complete", auth: Auth.CONFIGURED, where: { token: /^[a-fA-F0-9]+$/ }, handler: inviteComplete },

  // Session login (for browser pages)
  { method: Method.GET,  pattern: "/login",                auth: Auth.CONFIGURED, handler: loginPage },
  { method: Method.POST, pattern: "/login/begin",          auth: Auth.CONFIGURED, handler: loginBegin },
  { method: Method.POST, pattern: "/login/complete",       auth: Auth.CONFIGURED, handler: loginComplete },
  { method: Method.POST, pattern: "/login/verify",         auth: Auth.CONFIGURED, handler: loginVerify },
  { method: Method.POST, pattern: "/sessions/revoke",      auth: Auth.SECRET, handler: revokeSessions },

  // HTTP I/O
  { method: Method.GET,  pattern: "/o/entry/:pattern/:id", where: { id: /^\d+$/ }, handler: serveSharedEntry },
  { method: Method.GET,  pattern: "/o/:path",              handler: serveOutput },
  { method: Method.GET,  pattern: "/p/:path",              handler: servePublication },
  { method: Method.GET,  pattern: "/page/:path/og.svg",   handler: servePageOg },
  { method: Method.GET,  pattern: "/page/:path",           handler: servePage },
  { method: Method.POST, pattern: "/i/:path",              handler: receiveInput },
  { method: Method.POST, pattern: "/upload/:token",        where: { token: /^[a-fA-F0-9]+$/ }, handler: upload },
  { method: Method.POST, pattern: "/f/:token",             where: { token: /^[a-fA-F0-9]+$/ }, handler: uploadDocument },
  { method: Method.GET,  pattern: "/f/:id",                where: { id: /^\d+$/ }, handler: serveDocument },
  { method: Method.GET,  pattern: "/export/:pattern",       auth: Auth.SESSION, handler: exportPattern },

  // Pages (JSON APIs for the React SPA; the SPA itself is served as static assets)
  { method: Method.GET,  pattern: "/api/index",            auth: Auth.SESSION, handler: queryIndex },
  { method: Method.GET,  pattern: "/api/tools",             auth: Auth.SESSION, handler: queryTools },
  { method: Method.GET,  pattern: "/api/query/:pattern",   auth: Auth.SESSION, handler: queryEntries },
  { method: Method.GET,  pattern: "/api/history/:pattern/:id", auth: Auth.SESSION, where: { id: /^\d+$/ }, handler: queryHistory },
  { method: Method.GET,  pattern: "/api/label/:pattern/:id",   auth: Auth.SESSION, where: { id: /^\d+$/ }, handler: queryLabel },
  { method: Method.POST, pattern: "/api/mutate/:pattern",  auth: Auth.SESSION, handler: mutateEntry },
  { method: Method.POST, pattern: "/api/evolve",           auth: Auth.SESSION, handler: evolveSchema },
  { method: Method.GET,  pattern: "/ws",                   auth: Auth.SESSION, handler: liveSocket },

  // Canvas
  { method: Method.GET,  pattern: "/canvas",           auth: Auth.SESSION, handler: canvasPage },
  { method: Method.GET,  pattern: "/api/canvases",     auth: Auth.SESSION, handler: listCanvases },
  { method: Method.POST, pattern: "/api/canvas",       auth: Auth.SESSION, handler: saveCanvas },
  { method: Method.POST, pattern: "/api/resolve",      auth: Auth.SESSION, handler: resolveUri },

  // Dev / Admin
  { method: Method.ANY,  pattern: "/dev/seed",              auth: Auth.DEV, handler: seedTestData },
  { method: Method.ANY,  pattern: "/dev/seed-vectors",      auth: Auth.SECRET, handler: seedVectors },
  { method: Method.ANY,  pattern: "/dev/seed-marketplace", auth: Auth.DEV, handler: seedMarketplace },
  { method: Method.ANY,  pattern: "/marketplace/token",    auth: Auth.SECRET, handler: marketplaceToken },
  { method: Method.ANY,  pattern: "/marketplace*",         handler: marketplaceGit },
];

const dispatch = createRouter(routes);

// Backend path prefixes the worker owns. Anything else is a browser route that
// resolves to the React SPA shell. (Static asset files — /assets/* etc. — are
// served by the runtime before the worker runs; only unmatched paths reach
// here, so a 404 on a non-backend GET means "serve the SPA".)
const BACKEND_PREFIXES = [
  "/api", "/mcp", "/o/", "/p/", "/page/", "/i/", "/f/", "/upload/", "/export/", "/ws",
  "/token", "/register", "/authorize", "/auth/", "/setup", "/login",
  "/sessions/", "/invite/", "/marketplace", "/dev/", "/.well-known", "/canvas",
];
function isAppRoute(path: string): boolean {
  return !BACKEND_PREFIXES.some((p) => path === p || path.startsWith(p));
}

async function handle(request: Request, env: Env): Promise<Response> {
  const res = await dispatch(request, env);
  if (res.status === 404 && request.method === "GET" && env.ASSETS && isAppRoute(new URL(request.url).pathname)) {
    return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), { headers: request.headers }));
  }
  return res;
}

// === Export ===

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: SessionDO.serve("/mcp"),
  defaultHandler: { fetch: (request: Request, env: Env) => handle(request, env) },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["read", "write"],

  async resolveExternalToken({ token, env }) {
    // Tokens are generated via SQLite hex(randomblob(16)) → 32 uppercase hex
    // chars. Accept either case so a valid wildcard token actually validates.
    if (!/^[a-fA-F0-9]{32}$/.test(token)) return null;

    const storeId = (env as any).MNEMION_HIVE.idFromName(HIVE_ID);
    const store = (env as any).MNEMION_HIVE.get(storeId) as DurableObjectStub<HiveDO>;
    // Resolve which member this token authenticates as (null = invalid/out of
    // scope/suspended). Member-less tokens resolve to the owner sentinel.
    const actor = await store.resolveTokenActor(token, "*");
    if (!actor) return null;

    return { props: { hiveId: HIVE_ID, actor, userId: actor } };
  },
});
