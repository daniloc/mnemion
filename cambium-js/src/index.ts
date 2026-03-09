import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { CambiumSession } from "./session";
import { CambiumStore } from "./store";

// Re-export DO classes for wrangler
export { CambiumSession, CambiumStore };

// === Types ===

interface Env {
  OAUTH_KV: KVNamespace;
  CAMBIUM_STORE: DurableObjectNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  CAMBIUM_SECRET: string;
}

// === Login page ===

function loginPage(authStateId: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cambium</title>
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
  <h1>Cambium</h1>
  <form id="form">
    <input type="password" id="secret" placeholder="Password" autofocus />
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

// === Default handler ===

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // GET /authorize — show login page
    if (url.pathname === "/authorize") {
      const oauthReq = await (env as any).OAUTH_PROVIDER.parseAuthRequest(request);
      if (!oauthReq) {
        return new Response("Invalid OAuth request", { status: 400 });
      }

      // Dev mode: no secret configured, auto-approve
      if (!env.CAMBIUM_SECRET) {
        const { redirectTo } = await (env as any).OAUTH_PROVIDER.completeAuthorization({
          request: oauthReq,
          userId: "owner",
          metadata: {},
          scope: oauthReq.scope || [],
          props: { userId: "owner" },
        });
        return new Response(null, { status: 302, headers: { Location: redirectTo } });
      }

      // Store OAuth request for after password verification
      const authStateId = crypto.randomUUID();
      await env.OAUTH_KV.put(
        `auth_state:${authStateId}`,
        JSON.stringify(oauthReq),
        { expirationTtl: 600 }
      );

      return new Response(loginPage(authStateId), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // POST /auth/verify — check password, complete OAuth
    if (url.pathname === "/auth/verify" && request.method === "POST") {
      const { authStateId, secret } = (await request.json()) as {
        authStateId: string;
        secret: string;
      };

      if (secret !== env.CAMBIUM_SECRET) {
        return Response.json({ error: "Wrong password" }, { status: 401 });
      }

      const oauthReq = await env.OAUTH_KV.get(`auth_state:${authStateId}`, {
        type: "json",
      }) as any;
      if (!oauthReq) {
        return Response.json({ error: "Session expired" }, { status: 400 });
      }
      await env.OAUTH_KV.delete(`auth_state:${authStateId}`);

      const { redirectTo } = await (env as any).OAUTH_PROVIDER.completeAuthorization({
        request: oauthReq,
        userId: "owner",
        metadata: {},
        scope: oauthReq.scope || [],
        props: { userId: "owner" },
      });

      return Response.json({ redirectTo });
    }

    return new Response("Not found", { status: 404 });
  },
};

// === Export ===

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: CambiumSession.serve("/mcp"),
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["read", "write"],
});
