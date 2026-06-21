import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { SessionDO } from "../entities/Session/session";
import { HiveDO } from "../entities/Hive/hive";
import { HIVE_ID, HEX_TOKEN_RE } from "../shared/core/constants";
import { Method, Auth, createRouter, type Route, type RouteHandler, type Env } from "../shared/Routing/router";
import { FEATURES } from "../entities/features";
import { composeRoutes, assertWiredSlots } from "../entities/features/compose";
import type { FeatureRoute } from "../entities/features/feature";
import { logError } from "../shared/core/log";

// Auth
import { authorize, authVerify, setupPage, setupBegin, setupComplete, passkeyBegin, passkeyComplete, loginPage, loginBegin, loginComplete, loginVerify, revokeSessions, invitePage, inviteBegin, inviteComplete } from "../shared/Routing/routes/auth";
// I/O
import { serveSharedEntry, serveOutput, servePublication, receiveInput, upload, exportPattern } from "../shared/Routing/routes/io";
// Marketplace
import { seedMarketplace, marketplaceToken, marketplaceGit } from "../shared/Routing/routes/marketplace";
// Pages (JSON APIs the React SPA consumes)
import { queryIndex, queryEntries, queryTools, queryHistory, queryLabel, mutateEntry, evolveSchema, resolveUri, liveSocket } from "../shared/Routing/routes/pages";
// Dev
import { seedTestData, seedVectors } from "../shared/Routing/routes/dev";

// Re-export DO classes for wrangler
export { SessionDO, HiveDO };

// === Route table ===
//
// The full HTTP surface = CORE_ROUTES (below) + per-feature routes (declared in
// their own manifests under entities/features/<name>/manifest.ts and folded in by
// composeRoutes). To see every route a request can hit: read CORE_ROUTES here,
// then each feature manifest's `routes`. Feature routes are appended AFTER core,
// and the router matches in declaration order (first match wins) — so a feature
// route can never shadow a core route. Each route stays a single declarative row
// (method, pattern, auth, where, handler), here or in the manifest.

const CORE_ROUTES: Route[] = [
  // Auth & passkeys
  { method: Method.GET,  pattern: "/authorize",            handler: authorize },
  { method: Method.POST, pattern: "/auth/verify",          handler: authVerify },
  { method: Method.GET,  pattern: "/setup",                auth: Auth.CONFIGURED, handler: setupPage },
  { method: Method.POST, pattern: "/setup/begin",          auth: Auth.CONFIGURED, handler: setupBegin },
  { method: Method.POST, pattern: "/setup/complete",       auth: Auth.CONFIGURED, handler: setupComplete },
  { method: Method.POST, pattern: "/auth/passkey/begin",   handler: passkeyBegin },
  { method: Method.POST, pattern: "/auth/passkey/complete", handler: passkeyComplete },

  // Invite approval (human passkey gate before a register token can be used)
  { method: Method.GET,  pattern: "/invite/:token",          auth: Auth.CONFIGURED, where: { token: HEX_TOKEN_RE }, handler: invitePage },
  { method: Method.POST, pattern: "/invite/:token/begin",    auth: Auth.CONFIGURED, where: { token: HEX_TOKEN_RE }, handler: inviteBegin },
  { method: Method.POST, pattern: "/invite/:token/complete", auth: Auth.CONFIGURED, where: { token: HEX_TOKEN_RE }, handler: inviteComplete },

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
  // /page/* (pages feature) and /f/* (documents feature) routes are declared in
  // their feature manifests and appended below via composeRoutes(FEATURES).
  { method: Method.POST, pattern: "/i/:path",              handler: receiveInput },
  { method: Method.POST, pattern: "/upload/:token",        where: { token: HEX_TOKEN_RE }, handler: upload },
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
  { method: Method.POST, pattern: "/api/resolve",          auth: Auth.SESSION, handler: resolveUri },

  // Dev / Admin
  { method: Method.ANY,  pattern: "/dev/seed",              auth: Auth.DEV, handler: seedTestData },
  { method: Method.ANY,  pattern: "/dev/seed-vectors",      auth: Auth.SECRET, handler: seedVectors },
  { method: Method.ANY,  pattern: "/dev/seed-marketplace", auth: Auth.DEV, handler: seedMarketplace },
  { method: Method.ANY,  pattern: "/marketplace/token",    auth: Auth.SECRET, handler: marketplaceToken },
  { method: Method.ANY,  pattern: "/marketplace*",         handler: marketplaceGit },
];

// Feature routes carry their `method`/`auth` as plain strings (the manifest is
// dependency-light and doesn't import the router enums); both map 1:1 onto the
// enum values (Method/Auth values ARE those strings), except "ANY" → Method.ANY.
const FEATURE_METHODS: Record<FeatureRoute["method"], Method> = {
  GET: Method.GET, POST: Method.POST, ANY: Method.ANY,
};
function toRoute(r: FeatureRoute): Route {
  return {
    method: FEATURE_METHODS[r.method],
    // composeRoutes has already validated `r.auth` is a real Auth value (fail-closed),
    // so this cast is sound rather than a silent NONE-on-typo trap.
    pattern: r.pattern,
    auth: r.auth ? (r.auth as Auth) : undefined,
    where: r.where,
    // FeatureRoute.handler is typed loosely (sync|async, ctx: any) so the manifest
    // stays router-runtime-free; the concrete handlers are all `RouteHandler`.
    handler: r.handler as RouteHandler,
  };
}

// Loudly reject any feature populating a slot that isn't wired into its host yet
// (tools→session.ts, systemDocs→schema.ts) — otherwise it boots clean and is ignored.
assertWiredSlots(FEATURES);

// Composed feature routes (declared in entities/features/*/manifest.ts). Appended
// AFTER core so a feature route can never shadow a core route (first-match-wins).
// We pass IN the live Auth value set + CORE route keys so composeRoutes can fail
// CLOSED on an invalid auth and reject a route that would be silently shadowed by core.
const VALID_AUTH_VALUES: ReadonlySet<string> = new Set(Object.values(Auth));
// Core keys are namespaced with the SAME method strings a FeatureRoute uses
// ("GET"/"POST"/"ANY"), so the collision compare is apples-to-apples. Method.GET/POST
// already equal "GET"/"POST"; only Method.ANY ("*") needs mapping back to "ANY".
const METHOD_TO_FEATURE_STRING: Record<Method, FeatureRoute["method"]> = {
  [Method.GET]: "GET", [Method.POST]: "POST", [Method.ANY]: "ANY",
};
const CORE_ROUTE_KEYS: ReadonlySet<string> = new Set(
  CORE_ROUTES.map((r) => `${METHOD_TO_FEATURE_STRING[r.method]} ${r.pattern}`),
);
const FEATURE_ROUTES = composeRoutes(FEATURES, {
  validAuthValues: VALID_AUTH_VALUES,
  coreRouteKeys: CORE_ROUTE_KEYS,
});

// Full surface = core (above) + per-feature routes (in their manifests).
const routes: Route[] = [...CORE_ROUTES, ...FEATURE_ROUTES.map(toRoute)];

const dispatch = createRouter(routes);

// Backend path prefixes the worker owns. Anything else is a browser route that
// resolves to the React SPA shell. (Static asset files — /assets/* etc. — are
// served by the runtime before the worker runs; only unmatched paths reach
// here, so a 404 on a non-backend GET means "serve the SPA".) The feature-owned
// prefixes (/page/, /f/) are derived from the manifests' `backendPrefix`, so a
// moved route's SPA-exclusion travels with its declaration.
const BACKEND_PREFIXES = [
  "/api", "/mcp", "/o/", "/p/", "/i/", "/upload/", "/export/", "/ws",
  "/token", "/register", "/authorize", "/auth/", "/setup", "/login",
  "/sessions/", "/invite/", "/marketplace", "/dev/", "/.well-known",
  ...FEATURE_ROUTES.flatMap((r) => (r.backendPrefix ? [r.backendPrefix] : [])),
];
function isAppRoute(path: string): boolean {
  return !BACKEND_PREFIXES.some((p) => path === p || path.startsWith(p));
}

async function handle(request: Request, env: Env): Promise<Response> {
  // Top-level error boundary: any throw outside routing (the router catch handles
  // per-route handler throws and returns its own 500) is logged with sanitized
  // context — method + pathname ONLY, never url.search, which can carry tokens —
  // and answered with a generic 500. Error internals are logged, never leaked.
  try {
    const res = await dispatch(request, env);
    if (res.status === 404 && request.method === "GET" && env.ASSETS && isAppRoute(new URL(request.url).pathname)) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), { headers: request.headers }));
    }
    return res;
  } catch (err) {
    logError("request.unhandled", err, { method: request.method, path: new URL(request.url).pathname });
    return new Response("Internal Server Error", { status: 500 });
  }
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
