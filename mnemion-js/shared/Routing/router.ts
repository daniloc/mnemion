// Declarative HTTP dispatch: a route table matched in declaration order.
//
// @why The auth helpers here are security-load-bearing: timingSafeEqual is
// constant-time specifically to close a timing-attack finding on master-secret
// / setup-token / session-signature checks (replacing `===`), and session
// cookies carry a random sid plus a KV-stored epoch so every session can be
// revoked without rotating MNEMION_SECRET. The route table keeps the whole HTTP
// surface scannable (method, pattern, auth gate, handler per line) so the
// system's shape is graspable from the declarations alone.

import type { HiveDO } from "../../entities/Hive/hive";
import { PRODUCT_NAME, HIVE_ID, OWNER_ACTOR } from "../core/constants";

// === Types ===

export interface Env {
  OAUTH_KV: KVNamespace;
  MNEMION_HIVE: DurableObjectNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  DOCUMENTS?: R2Bucket;  // optional — present only when R2 is enabled + bound
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
  /** The authenticated member for this request (owner sentinel by default). */
  actor: string;
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

// base64url for the actor segment so a member label can't inject a "." into the
// dot-delimited cookie payload.
function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function b64urlDecode(s: string): string {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b + "=".repeat((4 - (b.length % 4)) % 4));
}

export async function createSessionCookie(secret: string, host: string, kv: KVNamespace, actor: string = OWNER_ACTOR): Promise<string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  // Random per-session id: gives each session a distinct, signable identity
  // (two logins in the same second no longer collide) and an audit handle.
  const sid = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const epoch = await getSessionEpoch(kv);
  // Payload carries the authenticated member so browser-UI writes are attributed.
  const payload = `${ts}.${sid}.${epoch}.${b64urlEncode(actor)}`;
  const sig = await hmacSign(secret, `session:${payload}`);
  const secure = !host.includes("localhost");
  return `${SESSION_COOKIE}=${payload}.${sig}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

/**
 * Validate a session cookie and return the authenticated member (actor), or null
 * if invalid. Accepts both the new 5-part (ts.sid.epoch.actor.sig) and the legacy
 * 4-part (ts.sid.epoch.sig → owner) format, so existing sessions aren't forced to
 * re-login on deploy. Pre-actor (2-part) cookies fail and re-login.
 */
async function validateSession(request: Request, secret: string, kv: KVNamespace): Promise<string | null> {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  const parts = match[1].split(".");
  let ts: string, sid: string, epoch: string, sig: string, signed: string, actorB64: string | null;
  if (parts.length === 5) {
    [ts, sid, epoch, actorB64, sig] = parts;
    signed = `session:${ts}.${sid}.${epoch}.${actorB64}`;
  } else if (parts.length === 4) {
    [ts, sid, epoch, sig] = parts;
    signed = `session:${ts}.${sid}.${epoch}`;
    actorB64 = null;
  } else {
    return null;
  }
  const age = Math.floor(Date.now() / 1000) - parseInt(ts);
  if (isNaN(age) || age < 0 || age > SESSION_MAX_AGE) return null;
  const expected = await hmacSign(secret, signed);
  if (!(await timingSafeEqual(sig, expected))) return null;
  // Revocation: reject cookies minted under a superseded epoch.
  if (epoch !== (await getSessionEpoch(kv))) return null;
  if (!actorB64) return OWNER_ACTOR;
  try {
    return b64urlDecode(actorB64) || OWNER_ACTOR;
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
        if (!password || !(await timingSafeEqual(password, env.MNEMION_SECRET))) {
          return new Response("Master password required", {
            status: 401,
            headers: { "WWW-Authenticate": `Basic realm="${PRODUCT_NAME}"` },
          });
        }
      }
      // Default actor (dev mode, or non-session routes) is the owner sentinel;
      // a validated browser session resolves the actual member.
      let actor = OWNER_ACTOR;
      if (auth === Auth.SESSION && env.MNEMION_SECRET) {
        const sessionActor = await validateSession(request, env.MNEMION_SECRET, env.OAUTH_KV);
        if (!sessionActor) {
          const returnTo = encodeURIComponent(url.pathname + url.search);
          return new Response(null, {
            status: 302,
            headers: { Location: `/login?return=${returnTo}` },
          });
        }
        actor = sessionActor;
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
      const hiveId = env.MNEMION_HIVE.idFromName(HIVE_ID);
      const hive = env.MNEMION_HIVE.get(hiveId) as DurableObjectStub<HiveDO>;

      return route.handler({ request, url, env, params, hive, actor });
    }

    return new Response("Not found", { status: 404 });
  };
}
