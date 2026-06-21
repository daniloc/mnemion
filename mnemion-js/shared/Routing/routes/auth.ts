import type { RouteHandler } from "../router";
import { createSessionCookie, revokeAllSessions, timingSafeEqual, isDevAutoApprove } from "../router";
import { PRODUCT_NAME, HIVE_ID, OWNER_ACTOR } from "../../core/constants";

// Passkey module loaded lazily to avoid tslib issues in test environments
type PasskeyModule = typeof import("../../Auth/passkey");
let _passkey: PasskeyModule | null = null;
async function passkey(): Promise<PasskeyModule> {
  if (!_passkey) _passkey = await import("../../Auth/passkey");
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

// Complete the OAuth grant, attributing the resulting session to a member.
// `actor` is the member label that authenticated (defaults to the owner
// sentinel for secret/code logins, which aren't tied to a specific member).
async function completeOAuth(env: any, oauthReq: any, actor: string = OWNER_ACTOR) {
  return (env as any).OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: actor,
    metadata: {},
    scope: oauthReq.scope || [],
    props: { hiveId: HIVE_ID, actor, userId: actor },
  });
}

// === Route handlers ===

export const authorize: RouteHandler = async (ctx) => {
  const oauthReq = await (ctx.env as any).OAUTH_PROVIDER.parseAuthRequest(ctx.request);
  if (!oauthReq) {
    return new Response("Invalid OAuth request", { status: 400 });
  }

  // Dev mode is an EXPLICIT opt-in (no secret AND DEV=true), exactly like every
  // other auth path (isDevAutoApprove, router.ts). A secretless deploy WITHOUT
  // DEV must NOT auto-grant an owner OAuth session — it fails CLOSED (503). This
  // is the highest-value gate: completeOAuth here mints a full owner grant, so
  // the bare `!MNEMION_SECRET` check used to be a fail-OPEN on a misconfigured
  // production deploy (the one site the fail-closed reversal had missed).
  if (isDevAutoApprove(ctx.env)) {
    const { redirectTo } = await completeOAuth(ctx.env, oauthReq);
    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  }
  if (!ctx.env.MNEMION_SECRET) {
    return new Response(
      "This instance is not configured (no MNEMION_SECRET). Run `npm run setup` to provision it.",
      { status: 503 },
    );
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

// Resolve a /setup token to the member being provisioned. Two kinds of token
// open the setup page:
//   - the master secret → registers the owner's bootstrap passkey (member null)
//   - a "register"-scoped, single-use access token → registers an invited
//     member's passkey (member from the token's constraints)
// Returns null for any invalid token. `tokenId` is set for register tokens so
// completion can consume them.
async function resolveSetupToken(ctx: any, token: string): Promise<
  | { member: string | null; userName: string; userDisplayName: string; tokenId: number | null }
  | null
> {
  if (!token) return null;
  if (ctx.env.MNEMION_SECRET && (await timingSafeEqual(token, ctx.env.MNEMION_SECRET))) {
    return { member: null, userName: OWNER_ACTOR, userDisplayName: `${PRODUCT_NAME} Owner`, tokenId: null };
  }
  const reg = await ctx.hive.resolveRegisterToken(token);
  if (!reg) return null;
  return { member: reg.member, userName: reg.userName, userDisplayName: reg.userDisplayName, tokenId: reg.id };
}

export const setupPage: RouteHandler = async (ctx) => {
  const token = ctx.url.searchParams.get("token");
  const setup = token ? await resolveSetupToken(ctx, token) : null;
  if (!setup) {
    return new Response("Invalid or missing token", { status: 403 });
  }
  return new Response((await passkey()).setupPage(token!), {
    headers: { "Content-Type": "text/html" },
  });
};

export const setupBegin: RouteHandler = async (ctx) => {
  const { token } = (await ctx.request.json()) as { token: string };
  const setup = await resolveSetupToken(ctx, token);
  if (!setup) {
    return Response.json({ error: "Invalid token" }, { status: 403 });
  }

  const { options, challenge } = await (await passkey()).beginRegistration(ctx.request, {
    userName: setup.userName,
    userDisplayName: setup.userDisplayName,
  });
  // Per-attempt challenge id so concurrent/overlapping flows don't clobber a
  // shared key, and the challenge is bound to this specific attempt.
  const cid = crypto.randomUUID();
  await ctx.env.OAUTH_KV.put(`passkey_challenge:reg:${cid}`, challenge, { expirationTtl: 300 });
  return Response.json({ options, cid });
};

export const setupComplete: RouteHandler = async (ctx) => {
  const { token, credential, cid } = (await ctx.request.json()) as { token: string; credential: any; cid: string };
  const setup = await resolveSetupToken(ctx, token);
  if (!setup) {
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
    await ctx.hive.storePasskey(stored.credential_id, stored.public_key, stored.counter, stored.transports, setup.member);
    // Burn the single-use invite token so the setup link can't be replayed.
    if (setup.tokenId != null) await ctx.hive.consumeAccessToken(setup.tokenId);
    return Response.json({ ok: true });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 400 });
  }
};

// === Invite approval (human-present passkey gate for member invites) ===
//
// Minting a register token is no longer enough to let someone register a passkey
// — the token is inert until a current member approves it here, in person, with
// their passkey (master-secret fallback for the bootstrap case). This defeats an
// agent acting on injected content that mints an invite and exfiltrates the URL:
// the attacker still can't activate it without a real member's authenticator.
// The agent-satisfiable mutate round-trip can't clear this gate.

function inviteApprovalPage(token: string, displayName: string, hasPasskey: boolean): string {
  const safeName = displayName.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] as string));
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${PRODUCT_NAME} — Approve invite</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 420px; margin: 80px auto; padding: 0 20px; }
    h1 { font-size: 1.4em; }
    p { color: #555; line-height: 1.5; }
    .who { font-weight: 600; color: #111; }
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
    .ok { color: #080; } .err { color: #c00; }
    code { background: #f3f3f3; padding: 2px 5px; border-radius: 4px; word-break: break-all; }
  </style>
</head>
<body>
  <h1>Approve invite</h1>
  <p>Approve a new member for this ${PRODUCT_NAME} hive: <span class="who">${safeName}</span>. Approving grants them standing read/write access to everything in the hive. Authenticate to confirm it's you.</p>
  <button id="passkey-btn">Approve with passkey</button>
  <div id="passkey-divider" class="divider">or</div>
  <button id="toggle">Use master secret instead</button>
  <form id="secret-form">
    <input type="password" id="secret" placeholder="Master secret" autofocus />
    <button type="submit">Approve</button>
  </form>
  <div id="status"></div>
  <script type="module">
    import { startAuthentication } from 'https://esm.sh/@simplewebauthn/browser@13';
    const token = ${JSON.stringify(token)};
    const status = document.getElementById('status');
    const passkeyBtn = document.getElementById('passkey-btn');

    function done(result) {
      if (result && result.ok) {
        const setupUrl = location.origin + result.setupPath;
        status.innerHTML = '<p class="ok">Invite approved.</p><p>Send this one-time setup link to the invitee:</p><p><code>' + setupUrl + '</code></p>';
        passkeyBtn.disabled = true;
        document.getElementById('secret-form').style.display = 'none';
        document.getElementById('toggle').style.display = 'none';
        document.getElementById('passkey-divider').style.display = 'none';
        return true;
      }
      return false;
    }

    passkeyBtn.addEventListener('click', async () => {
      passkeyBtn.disabled = true;
      status.textContent = '';
      try {
        const beginRes = await fetch('/invite/' + token + '/begin', { method: 'POST' });
        if (!beginRes.ok) throw new Error('Failed to start authentication');
        const options = await beginRes.json();
        const assertion = await startAuthentication({ optionsJSON: options });
        const completeRes = await fetch('/invite/' + token + '/complete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assertion }),
        });
        const result = await completeRes.json();
        if (!done(result)) throw new Error(result.error || 'Approval failed');
      } catch (err) {
        const span = document.createElement('span');
        span.className = 'err'; span.textContent = err.message || 'Approval failed';
        status.replaceChildren(span);
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
      try {
        const res = await fetch('/invite/' + token + '/complete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret }),
        });
        const result = await res.json();
        if (!done(result)) throw new Error(result.error || 'Approval failed');
      } catch (err) {
        const span = document.createElement('span');
        span.className = 'err'; span.textContent = err.message || 'Approval failed';
        status.replaceChildren(span);
      }
    });
  </script>
</body>
</html>`;
}

export const invitePage: RouteHandler = async (ctx) => {
  const info = await ctx.hive.getRegisterToken(ctx.params.token);
  if (!info) {
    return new Response("Invalid, expired, or already-used invite.", { status: 404 });
  }
  if (info.approved) {
    return new Response("This invite has already been approved.", { status: 409 });
  }
  const hasPasskey = await ctx.hive.hasPasskey();
  return new Response(inviteApprovalPage(ctx.params.token, info.userDisplayName, hasPasskey), {
    headers: { "Content-Type": "text/html" },
  });
};

export const inviteBegin: RouteHandler = async (ctx) => {
  // Only proceed for a genuine, unapproved invite token.
  const info = await ctx.hive.getRegisterToken(ctx.params.token);
  if (!info || info.approved) {
    return Response.json({ error: "Invalid or already-approved invite" }, { status: 404 });
  }
  const storedPasskeys = await ctx.hive.getPasskeys();
  if (storedPasskeys.length === 0) {
    // No passkeys registered yet — approval must use the master-secret fallback.
    return Response.json({ error: "No passkey registered; use the master secret" }, { status: 404 });
  }
  const { options, challenge } = await (await passkey()).beginAuthentication(ctx.request, storedPasskeys);
  await ctx.env.OAUTH_KV.put(`invite_challenge:${ctx.params.token}`, challenge, { expirationTtl: 300 });
  return Response.json(options);
};

export const inviteComplete: RouteHandler = async (ctx) => {
  const token = ctx.params.token;
  const info = await ctx.hive.getRegisterToken(token);
  if (!info || info.approved) {
    return Response.json({ error: "Invalid or already-approved invite" }, { status: 404 });
  }
  const body = (await ctx.request.json()) as { assertion?: any; secret?: string };

  // Path A: master-secret approval (bootstrap / no-passkey fallback). Only a
  // human with the deploy secret can use this — agents never hold it.
  if (body.secret != null) {
    if (!ctx.env.MNEMION_SECRET || !(await timingSafeEqual(body.secret, ctx.env.MNEMION_SECRET))) {
      return Response.json({ error: "Invalid secret" }, { status: 401 });
    }
    const approved = await ctx.hive.approveRegisterToken(token);
    if (!approved) return Response.json({ error: "Invalid invite" }, { status: 404 });
    return Response.json({ ok: true, setupPath: `/setup?token=${encodeURIComponent(token)}` });
  }

  // Path B: passkey approval. The asserted credential must belong to an active
  // member (the owner sentinel counts). This is the human-presence proof.
  const challenge = await ctx.env.OAUTH_KV.get(`invite_challenge:${token}`);
  if (!challenge) {
    return Response.json({ error: "Challenge expired" }, { status: 400 });
  }
  await ctx.env.OAUTH_KV.delete(`invite_challenge:${token}`);

  const storedPasskeys = await ctx.hive.getPasskeys();
  if (storedPasskeys.length === 0) {
    return Response.json({ error: "No passkey registered" }, { status: 404 });
  }
  try {
    const { verified, credentialId } = await (await passkey()).completeAuthentication(ctx.request, body.assertion, challenge, storedPasskeys);
    if (!verified) {
      return Response.json({ error: "Passkey verification failed" }, { status: 401 });
    }
    const approver = await actorForCredential(ctx, credentialId);
    if (!approver) {
      return Response.json({ error: "Only an active member can approve invites" }, { status: 403 });
    }
    const approved = await ctx.hive.approveRegisterToken(token);
    if (!approved) return Response.json({ error: "Invalid invite" }, { status: 404 });
    return Response.json({ ok: true, setupPath: `/setup?token=${encodeURIComponent(token)}` });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 401 });
  }
};

export const passkeyBegin: RouteHandler = async (ctx) => {
  const { authStateId } = (await ctx.request.json()) as { authStateId: string };

  const storedPasskeys = await ctx.hive.getPasskeys();
  if (storedPasskeys.length === 0) {
    return Response.json({ error: "No passkey registered" }, { status: 404 });
  }

  const { options, challenge } = await (await passkey()).beginAuthentication(ctx.request, storedPasskeys);
  await ctx.env.OAUTH_KV.put(`passkey_challenge:${authStateId}`, challenge, { expirationTtl: 300 });
  return Response.json(options);
};

// Resolve which member a verified assertion authenticated as, enforcing that the
// member is still active. Returns the member label (or owner sentinel), or null
// if the credential belongs to a suspended/removed member.
async function actorForCredential(ctx: any, credentialId: string | null): Promise<string | null> {
  const rows = await ctx.hive.getPasskeys();
  const row = rows.find((r: any) => r.credential_id === credentialId);
  const member: string | null = row?.member ?? null;
  if (member != null && !(await ctx.hive.isMemberActive(member))) return null;
  return member ?? OWNER_ACTOR;
}

export const passkeyComplete: RouteHandler = async (ctx) => {
  const { authStateId, assertion } = (await ctx.request.json()) as { authStateId: string; assertion: any };

  const challenge = await ctx.env.OAUTH_KV.get(`passkey_challenge:${authStateId}`);
  if (!challenge) {
    return Response.json({ error: "Challenge expired" }, { status: 400 });
  }
  await ctx.env.OAUTH_KV.delete(`passkey_challenge:${authStateId}`);

  const storedPasskeys = await ctx.hive.getPasskeys();
  if (storedPasskeys.length === 0) {
    return Response.json({ error: "No passkey registered" }, { status: 404 });
  }

  try {
    const { verified, newCounter, credentialId } = await (await passkey()).completeAuthentication(ctx.request, assertion, challenge, storedPasskeys);
    if (!verified) {
      return Response.json({ error: "Passkey verification failed" }, { status: 401 });
    }

    const actor = await actorForCredential(ctx, credentialId);
    if (!actor) {
      return Response.json({ error: "Member access has been revoked" }, { status: 403 });
    }
    await ctx.hive.updatePasskeyCounter(credentialId!, newCounter);

    const oauthReq = await ctx.env.OAUTH_KV.get(`auth_state:${authStateId}`, { type: "json" }) as any;
    if (!oauthReq) {
      return Response.json({ error: "Session expired" }, { status: 400 });
    }
    await ctx.env.OAUTH_KV.delete(`auth_state:${authStateId}`);

    const { redirectTo } = await completeOAuth(ctx.env, oauthReq, actor);
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
  const storedPasskeys = await ctx.hive.getPasskeys();
  if (storedPasskeys.length === 0) {
    return Response.json({ error: "No passkey registered" }, { status: 404 });
  }

  const { options, challenge } = await (await passkey()).beginAuthentication(ctx.request, storedPasskeys);
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

  const storedPasskeys = await ctx.hive.getPasskeys();
  if (storedPasskeys.length === 0) {
    return Response.json({ error: "No passkey registered" }, { status: 404 });
  }

  try {
    const { verified, newCounter, credentialId } = await (await passkey()).completeAuthentication(ctx.request, assertion, challenge, storedPasskeys);
    if (!verified) {
      return Response.json({ error: "Passkey verification failed" }, { status: 401 });
    }
    const actor = await actorForCredential(ctx, credentialId);
    if (!actor) {
      return Response.json({ error: "Member access has been revoked" }, { status: 403 });
    }
    await ctx.hive.updatePasskeyCounter(credentialId!, newCounter);

    const cookie = await createSessionCookie(ctx.env.MNEMION_SECRET, ctx.url.host, ctx.env.OAUTH_KV, actor);
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
