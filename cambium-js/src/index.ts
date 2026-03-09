import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { CambiumSession } from "./session";
import { CambiumStore } from "./store";
import { handleMarketplaceGit, type MarketplacePlugin } from "./git";

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

// === Auth helpers ===

function extractBasicPassword(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(auth.slice(6));
    return decoded.split(":").slice(1).join(":");
  } catch {
    return null;
  }
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

    // Dev-only: seed test marketplace data
    if (url.pathname === "/dev/seed-marketplace" && !env.CAMBIUM_SECRET) {
      const storeId = env.CAMBIUM_STORE.idFromName("user:owner");
      const store = env.CAMBIUM_STORE.get(storeId) as DurableObjectStub<CambiumStore>;

      // Create _plugins schema
      let result = await store.proposeChange("Create _plugins object", JSON.stringify({
        type: "create_object",
        object_name: "_plugins",
        object_description: "Plugin packages for the marketplace",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "description", type: "text", required: true },
          { name: "version", type: "text", required: true },
          { name: "visibility", type: "text", required: true },
          { name: "author", type: "text" },
          { name: "claude_md", type: "text" },
          { name: "settings_json", type: "text" },
          { name: "mcp_json", type: "text" },
        ],
      }));
      let parsed = JSON.parse(result);
      if (parsed.change_id) {
        await store.applyChange(parsed.change_id);
      }

      // Create _skills schema
      result = await store.proposeChange("Create _skills object", JSON.stringify({
        type: "create_object",
        object_name: "_skills",
        object_description: "Skills within plugins",
        fields: [
          { name: "plugin_id", type: "integer", required: true },
          { name: "name", type: "text", required: true },
          { name: "description", type: "text" },
          { name: "argument_hint", type: "text" },
          { name: "skill_md", type: "text", required: true },
          { name: "visibility", type: "text", required: true },
        ],
      }));
      parsed = JSON.parse(result);
      if (parsed.change_id) {
        await store.applyChange(parsed.change_id);
      }

      // Create a test plugin
      result = await store.mutate("_plugins", "create", JSON.stringify({
        name: "cambium-test",
        description: "Test plugin for marketplace validation",
        version: "0.1.0",
        visibility: "public",
      }));
      const plugin = JSON.parse(result);

      // Create a test skill
      await store.mutate("_skills", "create", JSON.stringify({
        plugin_id: plugin.record.id,
        name: "hello-world",
        description: "A test skill that greets the user",
        argument_hint: "[name]",
        visibility: "public",
        skill_md: "# Hello World\n\nGreet the user by name. This is a test skill to validate marketplace delivery.\n",
      }));

      return Response.json({ ok: true, message: "Test marketplace data seeded" });
    }

    // Marketplace token management (master password required)
    if (url.pathname === "/marketplace/token" && env.CAMBIUM_SECRET) {
      const password = extractBasicPassword(request);
      if (password !== env.CAMBIUM_SECRET) {
        return new Response("Master password required", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="Cambium"' },
        });
      }

      const storeId = env.CAMBIUM_STORE.idFromName("user:owner");
      const store = env.CAMBIUM_STORE.get(storeId) as DurableObjectStub<CambiumStore>;

      if (request.method === "POST") {
        // Create a new scoped token
        const body = await request.json().catch(() => ({})) as { name?: string; scope?: string[] };
        const result = await store.mutate("_marketplace_tokens", "create", JSON.stringify({
          name: body.name || "default",
          scope: body.scope ? JSON.stringify(body.scope) : null,
        }));
        const parsed = JSON.parse(result);
        if (parsed.error) return Response.json(parsed, { status: 500 });
        const token = parsed.record.token;
        return Response.json({
          token,
          name: parsed.record.name,
          scope: parsed.record.scope ? JSON.parse(parsed.record.scope) : null,
          install: `https://cambium:${token}@${url.host}/marketplace.git`,
        });
      }

      // GET: list all active tokens
      const result = await store.query("_marketplace_tokens", "", "id,name,token,scope,created_at", "-created_at", 100, false);
      return Response.json(JSON.parse(result));
    }

    // Upload endpoint: POST /upload/{token} — capability-URL, no other auth needed
    const uploadMatch = url.pathname.match(/^\/upload\/([a-fA-F0-9]+)$/);
    if (uploadMatch && request.method === "POST") {
      const token = uploadMatch[1];
      const storeId = env.CAMBIUM_STORE.idFromName("user:owner");
      const store = env.CAMBIUM_STORE.get(storeId) as DurableObjectStub<CambiumStore>;
      const content = await request.text();
      const result = await store.consumeUpload(token, content);
      const parsed = JSON.parse(result);
      return Response.json(parsed, { status: parsed.error ? 400 : 200 });
    }

    // Marketplace git endpoints: /marketplace[/public]/{info/refs,git-upload-pack}
    if (url.pathname.startsWith("/marketplace")) {
      const isPublic = url.pathname.startsWith("/marketplace/public");

      const storeId = env.CAMBIUM_STORE.idFromName("user:owner");
      const store = env.CAMBIUM_STORE.get(storeId) as DurableObjectStub<CambiumStore>;

      // Get marketplace data (auth + scoping)
      let raw: string;
      if (isPublic) {
        raw = await store.getMarketplaceDataPublic();
      } else if (!env.CAMBIUM_SECRET) {
        // Dev mode: serve all data without auth
        raw = await store.getMarketplaceDataPublic();
      } else {
        const password = extractBasicPassword(request);
        if (!password) {
          return new Response("Authentication required", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="Cambium"' },
          });
        }
        raw = await store.getMarketplaceDataForToken(password);
        const check = JSON.parse(raw);
        if (check.error) {
          return new Response("Invalid token", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="Cambium"' },
          });
        }
      }

      const { plugins: dbPlugins } = JSON.parse(raw) as { plugins: any[] };

      // Map store records to git marketplace format
      const plugins: MarketplacePlugin[] = dbPlugins.map((p: any) => ({
        name: p.name,
        description: p.description,
        version: p.version || "0.1.0",
        claude_md: p.claude_md || undefined,
        mcp_json: p.mcp_json || undefined,
        settings_json: p.settings_json || undefined,
        skills: (p.skills || []).map((s: any) => ({
          name: s.name,
          description: s.description || undefined,
          argument_hint: s.argument_hint || undefined,
          skill_md: s.skill_md,
        })),
      }));

      // Strip the marketplace prefix (and optional .git suffix) for routing
      let gitPath = isPublic
        ? url.pathname.replace(/^\/marketplace\/public(\.git)?/, "")
        : url.pathname.replace(/^\/marketplace(\.git)?/, "");

      return handleMarketplaceGit(request, gitPath, plugins);
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
