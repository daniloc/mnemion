// Client ID Metadata Documents (CIMD): an MCP client may use an https URL as its
// OAuth client_id instead of registering through DCR. The provider fetches the
// document at that URL, checks that its client_id matches the URL, and takes the
// redirect URIs from it. These tests pin that the worker advertises and accepts
// CIMD clients, refuses a document that doesn't match its URL, and that the
// sign-in page names the client by its verified host.
import { SELF } from "cloudflare:test";
import { describe, it, expect, afterEach } from "vitest";
import { fetchMock } from "./fetch-mock";
import { clientLine } from "../../shared/Routing/routes/auth";
import wranglerConfig from "../../wrangler.toml?raw";

const CLIENT_ORIGIN = "https://client.example";
const CLIENT_ID = `${CLIENT_ORIGIN}/oauth/client.json`;
const REDIRECT = `${CLIENT_ORIGIN}/cb`;

async function authorizeUrl(clientId: string): Promise<string> {
  const verifier = "mnemion-test-pkce-verifier-with-sufficient-entropy-0123456789";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "*",
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://test.local/authorize?${q}`;
}

function serveDocument(doc: Record<string, unknown>) {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock.get(CLIENT_ORIGIN)
    .intercept({ path: "/oauth/client.json" })
    .reply(200, JSON.stringify(doc), { headers: { "Content-Type": "application/json" } });
}

afterEach(() => fetchMock.deactivate());

describe("client ID metadata documents", () => {
  it("every deployed worker sets the flag CIMD needs", () => {
    // The provider only enables CIMD when global_fetch_strictly_public is set
    // (SSRF protection for the metadata fetch). env.test inherits the top-level flags.
    expect(wranglerConfig).toMatch(/^compatibility_flags = \[[^\]]*"global_fetch_strictly_public"/m);
  });

  it("advertises CIMD in the authorization server metadata", async () => {
    const res = await SELF.fetch("https://test.local/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.client_id_metadata_document_supported).toBe(true);
  });

  it("accepts a URL client_id whose document matches it", async () => {
    serveDocument({
      client_id: CLIENT_ID,
      client_name: "Example MCP client",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    });
    const res = await SELF.fetch(await authorizeUrl(CLIENT_ID), { redirect: "manual" });
    // This env has no secret, so a request the provider accepted stops at the
    // fail-closed dev gate (503). A 400 would mean the CIMD client was refused.
    expect(res.status).toBe(503);
  });

  it("refuses a document whose client_id doesn't match its URL", async () => {
    serveDocument({
      client_id: `${CLIENT_ORIGIN}/someone-else.json`,
      client_name: "Impostor",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    });
    const res = await SELF.fetch(await authorizeUrl(CLIENT_ID), { redirect: "manual" });
    expect(res.status).toBe(400);
    expect((res.headers.get("Location") || "").startsWith(REDIRECT)).toBe(false);
  });

  it("names a CIMD client by its verified host on the sign-in page", () => {
    const line = clientLine({ clientId: CLIENT_ID, clientName: "Example <MCP>" });
    expect(line).toContain("Example &lt;MCP&gt;");
    expect(line).toContain("from client.example");
  });

  it("marks a registered (DCR) client's name as unverified", () => {
    const line = clientLine({ clientId: "abc123", clientName: "Claude" });
    expect(line).toContain("Claude");
    expect(line).toContain("self-registered, unverified");
    expect(clientLine(null)).toBe("");
  });
});
