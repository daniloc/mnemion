import type { RouteHandler } from "../router";
import { createSessionCookie, revokeAllSessions, timingSafeEqual } from "../router";
import { PRODUCT_NAME } from "../constants";

// Passkey module loaded lazily to avoid tslib issues in test environments
type PasskeyModule = typeof import("../passkey");
let _passkey: PasskeyModule | null = null;
async function passkey(): Promise<PasskeyModule> {
  if (!_passkey) _passkey = await import("../passkey");
  return _passkey;
}

// === Login page (secret-only fallback, used when no passkey is registered) ===

function secretOnlyLoginPage(authStateId: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${PRODUCT_NAME}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 400px; margin: 80px auto; padding: 0 20px; }
    h1 { font-size: 1.4em; }
    input { display: block; width: 100%; padding: 10px; margin: 8px 0; font-size: 1em;
      border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; }
    button { display: block; width: 100%; padding: 12px; margin: 8px 0; font-size: 1em;
      border: 1px solid #111; border-radius: 6px; cursor: pointer; background: #111; color: #fff; }
    button:hover { background: #333; }
    #error { color: #c00; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>${PRODUCT_NAME}</h1>
  <form id="form">
    <input type="password" id="secret" placeholder="Master secret or one-time code" autofocus />
    <button type="submit">Sign in</button>
  </form>
  <div id="error"></div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const secret = document.getElementById('secret').value;
      const res = await fetch('/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authStateId: ${JSON.stringify(authStateId)}, secret })
      });
      const result = await res.json();
      if (result.redirectTo) {
        window.location.href = result.redirectTo;
      } else {
        document.getElementById('error').textContent = result.error || 'Authentication failed';
      }
    });
  </script>
</body>
</html>`;
}

// === Helpers ===

async function completeOAuth(env: any, oauthReq: any) {
  return (env as any).OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: "owner",
    metadata: {},
    scope: oauthReq.scope || [],
    props: { userId: "owner" },
  });
}

// === Route handlers ===

export const authorize: RouteHandler = async (ctx) => {
  const oauthReq = await (ctx.env as any).OAUTH_PROVIDER.parseAuthRequest(ctx.request);
  if (!oauthReq) {
    return new Response("Invalid OAuth request", { status: 400 });
  }

  // Dev mode: no secret configured, auto-approve
  if (!ctx.env.MNEMION_SECRET) {
    const { redirectTo } = await completeOAuth(ctx.env, oauthReq);
    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  }

  // Store OAuth request for after verification
  const authStateId = crypto.randomUUID();
  await ctx.env.OAUTH_KV.put(
    `auth_state:${authStateId}`,
    JSON.stringify(oauthReq),
    { expirationTtl: 600 }
  );

  // Check if a passkey is registered — show passkey-first page if so
  const hasPasskey = await ctx.hive.hasPasskey();
  const pk = await passkey();
  const html = hasPasskey
    ? pk.passkeyLoginPage(authStateId)
    : secretOnlyLoginPage(authStateId);

  return new Response(html, { headers: { "Content-Type": "text/html" } });
};

export const authVerify: RouteHandler = async (ctx) => {
  const { authStateId, secret } = (await ctx.request.json()) as {
    authStateId: string;
    secret: string;
  };

  // Try master secret first, then one-time auth code
  let authenticated = false;
  if (ctx.env.MNEMION_SECRET && await timingSafeEqual(secret, ctx.env.MNEMION_SECRET)) {
    authenticated = true;
  } else {
    authenticated = await ctx.hive.consumeAuthCode(secret);
  }

  if (!authenticated) {
    return Response.json({ error: "Invalid secret or code" }, { status: 401 });
  }

  const oauthReq = await ctx.env.OAUTH_KV.get(`auth_state:${authStateId}`, { type: "json" }) as any;
  if (!oauthReq) {
    return Response.json({ error: "Session expired" }, { status: 400 });
  }
  await ctx.env.OAUTH_KV.delete(`auth_state:${authStateId}`);

  const { redirectTo } = await completeOAuth(ctx.env, oauthReq);
  return Response.json({ redirectTo });
};

export const setupPage: RouteHandler = async (ctx) => {
  const token = ctx.url.searchParams.get("token");
  if (!token || !(await timingSafeEqual(token, ctx.env.MNEMION_SECRET))) {
    return new Response("Invalid or missing token", { status: 403 });
  }
  return new Response((await passkey()).setupPage(token), {
    headers: { "Content-Type": "text/html" },
  });
};

export const setupBegin: RouteHandler = async (ctx) => {
  const { token } = (await ctx.request.json()) as { token: string };
  if (!token || !(await timingSafeEqual(token, ctx.env.MNEMION_SECRET))) {
    return Response.json({ error: "Invalid token" }, { status: 403 });
  }

  const { options, challenge } = await (await passkey()).beginRegistration(ctx.request);
  // Per-attempt challenge id so concurrent/overlapping flows don't clobber a
  // shared key, and the challenge is bound to this specific attempt.
  const cid = crypto.randomUUID();
  await ctx.env.OAUTH_KV.put(`passkey_challenge:reg:${cid}`, challenge, { expirationTtl: 300 });
  return Response.json({ options, cid });
};

export const setupComplete: RouteHandler = async (ctx) => {
  const { token, credential, cid } = (await ctx.request.json()) as { token: string; credential: any; cid: string };
  if (!token || !(await timingSafeEqual(token, ctx.env.MNEMION_SECRET))) {
    return Response.json({ error: "Invalid token" }, { status: 403 });
  }
  if (!cid || !/^[a-f0-9-]{36}$/.test(cid)) {
    return Response.json({ error: "Invalid challenge id" }, { status: 400 });
  }

  const challengeKey = `passkey_challenge:reg:${cid}`;
  const challenge = await ctx.env.OAUTH_KV.get(challengeKey);
  if (!challenge) {
    return Response.json({ error: "Challenge expired" }, { status: 400 });
  }
  await ctx.env.OAUTH_KV.delete(challengeKey);

  try {
    const stored = await (await passkey()).completeRegistration(ctx.request, credential, challenge);
    await ctx.hive.storePasskey(stored.credential_id, stored.public_key, stored.counter, stored.transports);
    return Response.json({ ok: true });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 400 });
  }
};

export const passkeyBegin: RouteHandler = async (ctx) => {
  const { authStateId } = (await ctx.request.json()) as { authStateId: string };

  const storedPasskey = await ctx.hive.getPasskey();
  if (!storedPasskey) {
    return Response.json({ error: "No passkey registered" }, { status: 404 });
  }

  const { options, challenge } = await (await passkey()).beginAuthentication(ctx.request, storedPasskey);
  await ctx.env.OAUTH_KV.put(`passkey_challenge:${authStateId}`, challenge, { expirationTtl: 300 });
  return Response.json(options);
};

export const passkeyComplete: RouteHandler = async (ctx) => {
  const { authStateId, assertion } = (await ctx.request.json()) as { authStateId: string; assertion: any };

  const challenge = await ctx.env.OAUTH_KV.get(`passkey_challenge:${authStateId}`);
  if (!challenge) {
    return Response.json({ error: "Challenge expired" }, { status: 400 });
  }
  await ctx.env.OAUTH_KV.delete(`passkey_challenge:${authStateId}`);

  const storedPasskey = await ctx.hive.getPasskey();
  if (!storedPasskey) {
    return Response.json({ error: "No passkey registered" }, { status: 404 });
  }

  try {
    const { verified, newCounter } = await (await passkey()).completeAuthentication(ctx.request, assertion, challenge, storedPasskey);
    if (!verified) {
      return Response.json({ error: "Passkey verification failed" }, { status: 401 });
    }

    await ctx.hive.updatePasskeyCounter(newCounter);

    const oauthReq = await ctx.env.OAUTH_KV.get(`auth_state:${authStateId}`, { type: "json" }) as any;
    if (!oauthReq) {
      return Response.json({ error: "Session expired" }, { status: 400 });
    }
    await ctx.env.OAUTH_KV.delete(`auth_state:${authStateId}`);

    const { redirectTo } = await completeOAuth(ctx.env, oauthReq);
    return Response.json({ redirectTo });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 401 });
  }
};

// === Session login (for browser pages, not OAuth) ===

function sessionLoginPage(returnTo: string, hasPasskey: boolean): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${PRODUCT_NAME}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 400px; margin: 80px auto; padding: 0 20px; }
    h1 { font-size: 1.4em; }
    button { display: block; width: 100%; padding: 12px; margin: 8px 0; font-size: 1em;
      border: 1px solid #111; border-radius: 6px; cursor: pointer; background: #111; color: #fff; }
    button:hover { background: #333; }
    button:disabled { background: #999; border-color: #999; cursor: default; }
    input { display: block; width: 100%; padding: 10px; margin: 8px 0; font-size: 1em;
      border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; }
    .divider { text-align: center; color: #999; margin: 16px 0; font-size: 0.9em; }
    #secret-form { display: ${hasPasskey ? "none" : "block"}; }
    #toggle { background: none; color: #555; border: none; text-decoration: underline;
      cursor: pointer; font-size: 0.9em; padding: 4px; width: auto; display: ${hasPasskey ? "inline" : "none"}; }
    #passkey-btn { display: ${hasPasskey ? "block" : "none"}; }
    #passkey-divider { display: ${hasPasskey ? "block" : "none"}; }
    #error { color: #c00; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>${PRODUCT_NAME}</h1>
  <button id="passkey-btn">Sign in with passkey</button>
  <div id="passkey-divider" class="divider">or</div>
  <button id="toggle">Use master secret instead</button>
  <form id="secret-form">
    <input type="password" id="secret" placeholder="Master secret or one-time code" autofocus />
    <button type="submit">Sign in</button>
  </form>
  <div id="error"></div>
  <script type="module">
    import { startAuthentication } from 'https://esm.sh/@simplewebauthn/browser@13';

    const returnTo = ${JSON.stringify(returnTo)};
    const errorEl = document.getElementById('error');
    const passkeyBtn = document.getElementById('passkey-btn');

    passkeyBtn.addEventListener('click', async () => {
      passkeyBtn.disabled = true;
      errorEl.textContent = '';
      try {
        const beginRes = await fetch('/login/begin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!beginRes.ok) throw new Error('Failed to start authentication');
        const { options, cid } = await beginRes.json();

        const assertion = await startAuthentication({ optionsJSON: options });

        const completeRes = await fetch('/login/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assertion, returnTo, cid }),
        });
        const result = await completeRes.json();
        if (result.redirectTo) {
          window.location.href = result.redirectTo;
        } else {
          throw new Error(result.error || 'Authentication failed');
        }
      } catch (err) {
        errorEl.textContent = err.message || 'Passkey authentication failed';
        passkeyBtn.disabled = false;
      }
    });

    document.getElementById('toggle').addEventListener('click', () => {
      document.getElementById('secret-form').style.display = 'block';
      document.getElementById('toggle').style.display = 'none';
    });

    document.getElementById('secret-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const secret = document.getElementById('secret').value;
      const res = await fetch('/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, returnTo }),
      });
      const result = await res.json();
      if (result.redirectTo) {
        window.location.href = result.redirectTo;
      } else {
        errorEl.textContent = result.error || 'Authentication failed';
      }
    });
  </script>
</body>
</html>`;
}

/**
 * Restrict a post-login redirect target to a same-origin path. Rejects
 * absolute URLs (open redirect) and anything containing characters that
 * could break out of the JS string / <script> context when embedded in the
 * login page (reflected XSS). Falls back to "/".
 */
function safeReturnPath(raw: string | null): string {
  if (!raw) return "/";
  // Must be a root-relative path, not a scheme-relative "//evil.com" URL,
  // and must not contain quote/angle-bracket/backslash characters.
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (/[<>'"\\]/.test(raw)) return "/";
  return raw;
}

export const loginPage: RouteHandler = async (ctx) => {
  const returnTo = safeReturnPath(ctx.url.searchParams.get("return"));
  const hasPasskey = await ctx.hive.hasPasskey();
  return new Response(sessionLoginPage(returnTo, hasPasskey), {
    headers: { "Content-Type": "text/html" },
  });
};

export const loginBegin: RouteHandler = async (ctx) => {
  const storedPasskey = await ctx.hive.getPasskey();
  if (!storedPasskey) {
    return Response.json({ error: "No passkey registered" }, { status: 404 });
  }

  const { options, challenge } = await (await passkey()).beginAuthentication(ctx.request, storedPasskey);
  const cid = crypto.randomUUID();
  await ctx.env.OAUTH_KV.put(`passkey_challenge:login:${cid}`, challenge, { expirationTtl: 300 });
  return Response.json({ options, cid });
};

export const loginComplete: RouteHandler = async (ctx) => {
  const { assertion, returnTo, cid } = (await ctx.request.json()) as { assertion: any; returnTo: string; cid: string };

  if (!cid || !/^[a-f0-9-]{36}$/.test(cid)) {
    return Response.json({ error: "Invalid challenge id" }, { status: 400 });
  }
  const challengeKey = `passkey_challenge:login:${cid}`;
  const challenge = await ctx.env.OAUTH_KV.get(challengeKey);
  if (!challenge) {
    return Response.json({ error: "Challenge expired" }, { status: 400 });
  }
  await ctx.env.OAUTH_KV.delete(challengeKey);

  const storedPasskey = await ctx.hive.getPasskey();
  if (!storedPasskey) {
    return Response.json({ error: "No passkey registered" }, { status: 404 });
  }

  try {
    const { verified, newCounter } = await (await passkey()).completeAuthentication(ctx.request, assertion, challenge, storedPasskey);
    if (!verified) {
      return Response.json({ error: "Passkey verification failed" }, { status: 401 });
    }
    await ctx.hive.updatePasskeyCounter(newCounter);

    const cookie = await createSessionCookie(ctx.env.MNEMION_SECRET, ctx.url.host, ctx.env.OAUTH_KV);
    const safePath = safeReturnPath(returnTo);
    return new Response(JSON.stringify({ redirectTo: safePath }), {
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": cookie,
      },
    });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 401 });
  }
};

export const loginVerify: RouteHandler = async (ctx) => {
  const { secret, returnTo } = (await ctx.request.json()) as { secret: string; returnTo: string };

  let authenticated = false;
  if (ctx.env.MNEMION_SECRET && await timingSafeEqual(secret, ctx.env.MNEMION_SECRET)) {
    authenticated = true;
  } else {
    authenticated = await ctx.hive.consumeAuthCode(secret);
  }

  if (!authenticated) {
    return Response.json({ error: "Invalid secret or code" }, { status: 401 });
  }

  const cookie = await createSessionCookie(ctx.env.MNEMION_SECRET, ctx.url.host, ctx.env.OAUTH_KV);
  const safePath = safeReturnPath(returnTo);
  return new Response(JSON.stringify({ redirectTo: safePath }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookie,
    },
  });
};

// POST /sessions/revoke — invalidate ALL browser sessions (Auth.SECRET gated).
// Bumps the session epoch so every issued cookie stops validating, without
// rotating MNEMION_SECRET. Use after a suspected session-cookie compromise.
export const revokeSessions: RouteHandler = async (ctx) => {
  await revokeAllSessions(ctx.env.OAUTH_KV);
  return Response.json({ ok: true, message: "All sessions revoked. Existing cookies are now invalid (propagation up to ~60s)." });
};
