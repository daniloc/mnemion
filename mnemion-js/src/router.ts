import type { StoreDO } from "./store";
import { PRODUCT_NAME } from "./constants";

// === Types ===

export interface Env {
  OAUTH_KV: KVNamespace;
  MNEMION_STORE: DurableObjectNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  MNEMION_SECRET: string;
}

export enum Method {
  GET = "GET",
  POST = "POST",
  ANY = "*",
}

export enum Auth {
  NONE = "none",
  DEV = "dev",
  CONFIGURED = "configured",
  SECRET = "secret",
}

export interface RouteContext {
  request: Request;
  url: URL;
  env: Env;
  params: Record<string, string>;
  store: DurableObjectStub<StoreDO>;
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response>;

export interface Route {
  method: Method;
  pattern: string;
  auth?: Auth;
  where?: Record<string, RegExp>;
  handler: RouteHandler;
}

// === Helpers ===

export function extractBasicPassword(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(auth.slice(6));
    return decoded.split(":").slice(1).join(":");
  } catch {
    return null;
  }
}

// === Router ===

interface CompiledRoute {
  route: Route;
  regex: RegExp;
  paramNames: string[];
}

function compile(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const isPrefix = pattern.endsWith("*");
  const base = isPrefix ? pattern.slice(0, -1) : pattern;

  const escaped = base.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const re = escaped.replace(/:([a-zA-Z_]+)/g, (_, name) => {
    paramNames.push(name);
    return "([^/]+)";
  });

  return {
    regex: isPrefix ? new RegExp(`^${re}(.*)$`) : new RegExp(`^${re}$`),
    paramNames: isPrefix ? [...paramNames, "_rest"] : paramNames,
  };
}

export function createRouter(routes: Route[]) {
  const compiled: CompiledRoute[] = routes.map(route => ({
    route,
    ...compile(route.pattern),
  }));

  return async function dispatch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    for (const { route, regex, paramNames } of compiled) {
      if (route.method !== Method.ANY && route.method !== request.method) continue;

      const m = url.pathname.match(regex);
      if (!m) continue;

      // Auth gate
      const auth = route.auth ?? Auth.NONE;
      if (auth === Auth.DEV && env.MNEMION_SECRET) continue;
      if (auth === Auth.CONFIGURED && !env.MNEMION_SECRET) continue;
      if (auth === Auth.SECRET) {
        if (!env.MNEMION_SECRET) continue;
        const password = extractBasicPassword(request);
        if (password !== env.MNEMION_SECRET) {
          return new Response("Master password required", {
            status: 401,
            headers: { "WWW-Authenticate": `Basic realm="${PRODUCT_NAME}"` },
          });
        }
      }

      // Extract params
      const params: Record<string, string> = {};
      paramNames.forEach((name, i) => { params[name] = m[i + 1] ?? ""; });

      // Param constraints
      if (route.where) {
        const failed = Object.entries(route.where).some(([k, re]) => !re.test(params[k] ?? ""));
        if (failed) continue;
      }

      // Build context
      const storeId = env.MNEMION_STORE.idFromName("user:owner");
      const store = env.MNEMION_STORE.get(storeId) as DurableObjectStub<StoreDO>;

      return route.handler({ request, url, env, params, store });
    }

    return new Response("Not found", { status: 404 });
  };
}
