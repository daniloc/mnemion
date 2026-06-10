import type { HiveDO } from "./hive";
import { PRODUCT_NAME } from "./constants";

// === Types ===

export interface Env {
  OAUTH_KV: KVNamespace;
  MNEMION_HIVE: DurableObjectNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  DOCUMENTS: R2Bucket;
  MNEMION_SECRET: string;
  WORKER_HOST?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
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
  SESSION = "session",
}

export interface RouteContext {
  request: Request;
  url: URL;
  env: Env;
  params: Record<string, string>;
  hive: DurableObjectStub<HiveDO>;
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

/**
 * Constant-time string comparison. Hashes both inputs to fixed-length digests
 * and compares with a branch-free XOR accumulator, so timing does not leak the
 * length or content of the expected value. Use for any comparison against the
 * master secret or an HMAC signature.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

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

// === Session cookies ===

const SESSION_COOKIE = "__session";
const SESSION_MAX_AGE = 86400; // 24 hours
const SESSION_EPOCH_KEY = "session_epoch";

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getSessionEpoch(kv: KVNamespace): Promise<string> {
  return (await kv.get(SESSION_EPOCH_KEY)) ?? "0";
}

/**
 * Revoke every existing session by bumping the stored epoch. Cookies embed the
 * epoch they were minted under, and validateSession rejects any whose epoch no
 * longer matches — so the owner can invalidate all sessions (e.g. after a
 * suspected cookie theft) without rotating MNEMION_SECRET. KV is eventually
 * consistent, so global propagation can take up to ~60s.
 */
export async function revokeAllSessions(kv: KVNamespace): Promise<void> {
  const current = Number(await getSessionEpoch(kv)) || 0;
  await kv.put(SESSION_EPOCH_KEY, String(current + 1));
}

export async function createSessionCookie(secret: string, host: string, kv: KVNamespace): Promise<string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  // Random per-session id: gives each session a distinct, signable identity
  // (two logins in the same second no longer collide) and an audit handle.
  const sid = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const epoch = await getSessionEpoch(kv);
  const payload = `${ts}.${sid}.${epoch}`;
  const sig = await hmacSign(secret, `session:${payload}`);
  const secure = !host.includes("localhost");
  return `${SESSION_COOKIE}=${payload}.${sig}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

async function validateSession(request: Request, secret: string, kv: KVNamespace): Promise<boolean> {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return false;
  const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) return false;
  // Format: ts.sid.epoch.sig (older ts.sig cookies fail length check → re-login)
  const parts = match[1].split(".");
  if (parts.length !== 4) return false;
  const [ts, sid, epoch, sig] = parts;
  const age = Math.floor(Date.now() / 1000) - parseInt(ts);
  if (isNaN(age) || age < 0 || age > SESSION_MAX_AGE) return false;
  const expected = await hmacSign(secret, `session:${ts}.${sid}.${epoch}`);
  if (!(await timingSafeEqual(sig, expected))) return false;
  // Revocation: reject cookies minted under a superseded epoch.
  return epoch === (await getSessionEpoch(kv));
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
        if (!password || !(await timingSafeEqual(password, env.MNEMION_SECRET))) {
          return new Response("Master password required", {
            status: 401,
            headers: { "WWW-Authenticate": `Basic realm="${PRODUCT_NAME}"` },
          });
        }
      }
      if (auth === Auth.SESSION) {
        if (env.MNEMION_SECRET && !(await validateSession(request, env.MNEMION_SECRET, env.OAUTH_KV))) {
          const returnTo = encodeURIComponent(url.pathname + url.search);
          return new Response(null, {
            status: 302,
            headers: { Location: `/login?return=${returnTo}` },
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
      const hiveId = env.MNEMION_HIVE.idFromName("user:owner");
      const hive = env.MNEMION_HIVE.get(hiveId) as DurableObjectStub<HiveDO>;

      return route.handler({ request, url, env, params, hive });
    }

    return new Response("Not found", { status: 404 });
  };
}
