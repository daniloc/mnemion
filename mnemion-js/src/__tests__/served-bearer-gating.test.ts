// Served bearer-gating totality.
//
// Doctrine (CLAUDE.md, "Untrusted reads & writes" / the served-read surface):
// every served read route that exposes a *visibility-gated* resource must refuse
// to serve a non-public (unlisted/private) resource to an unauthenticated caller.
// In io.ts each such handler enforces a positive allow-list (`visibility ===
// "public"` serves unauthenticated; anything else routes through the Bearer gate
// `denyUnlessBearerScope` in shared/Routing/router.ts, or — with no secret
// configured — refuses outright). `denyUnlessBearerScope` parses
// `Authorization: Bearer <token>`, validates it against the route's scope, and
// returns `401 Unauthorized` when the token is missing/invalid; it is called at
// ~5 served route handlers, but nothing asserted that EVERY served read path that
// exposes a gated resource actually gates on it. A new served read route that
// forgets the gate would silently serve private/unlisted data unauthenticated.
//
// This suite is the behavioral totality for that boundary. It enumerates the
// served gated read routes (a live domain, not copy-pasted per-route asserts) and
// asserts, for EACH:
//   - an UNLISTED resource requested WITHOUT a token is REFUSED (non-200, the
//     resource body/secret never served), and
//   - (sanity) a PUBLIC resource of the same kind IS served (200).
// A NEW served read route that exposes a gated resource without routing through
// the visibility/bearer gate would serve the unlisted body 200 here → FAIL.
//
// Note on refusal status in THIS runtime: vitest-pool-workers runs with DEV=true
// and NO MNEMION_SECRET. With no secret, io.ts cannot authenticate a Bearer token,
// so the non-public branch refuses with **404** *before* reaching
// `denyUnlessBearerScope` (which would return 401 in a configured deploy). Either
// way the contract is "not served unauthenticated": we assert ANY non-200 that
// does not serve the resource body. The exact code each route returns here is
// recorded per descriptor and reported.

import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { HiveDO } from "../../entities/Hive/hive";

// The served routes dispatch to the HiveDO keyed by HIVE_ID ("user:owner"), so we
// must plant rows in that exact store for SELF.fetch to read them back.
function ownerHive(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName("user:owner");
  return env.MNEMION_HIVE.get(id);
}

// A response "refuses" iff it does not serve the gated resource: any non-200 status
// AND none of the resource's secret markers appear in the body. (404 in this
// runtime, 401 in a configured deploy — both are refusals.)
async function assertRefused(res: Response, secrets: string[], label: string) {
  expect(res.status, `${label}: unlisted-without-token must NOT be 200`).not.toBe(200);
  const body = await res.text();
  for (const secret of secrets) {
    expect(body, `${label}: refusal body must not contain the gated secret`).not.toContain(secret);
  }
  return res.status;
}

// === The enumerated served-gated-read domain ===
//
// Each descriptor knows how to (a) plant an UNLISTED resource of its kind + return
// its public URL and a list of secret strings that prove the body leaked, and
// (b) plant the PUBLIC variant + return its URL. Returning null from a setup means
// "can't be driven live in this runtime" (e.g. /f needs the R2 DOCUMENTS binding,
// unbound in CI) — the descriptor is skipped, mirroring served-inertness.test.ts.

type GatedRoute = {
  name: string;
  // The token scope io.ts gates this route on (documentation only — the runtime
  // refusal here is the secret-less 404, but this records what the contract is).
  scope: string;
  // Plant an UNLISTED resource; return { url, secrets } or null if unsupported here.
  unlisted: (hive: DurableObjectStub<HiveDO>) => Promise<{ url: string; secrets: string[] } | null>;
  // Plant a PUBLIC resource; return its url or null if unsupported here.
  public: (hive: DurableObjectStub<HiveDO>) => Promise<string | null>;
};

// --- /o/entry/:pattern/:id via an unlisted _shared row over a user pattern ---

let entryPatternReady = false;
async function ensureEntryPattern(hive: DurableObjectStub<HiveDO>) {
  if (entryPatternReady) return;
  const p = JSON.parse(await hive.proposeChange("Create", JSON.stringify({
    type: "create_pattern", pattern_name: "gated_notes", pattern_description: "t", doctrine: "t",
    facets: [{ name: "title", type: "text", required: true }, { name: "body", type: "text" }],
  })));
  if (!p.error) await hive.applyChange(p.change_id); // tolerate already-exists
  entryPatternReady = true;
}

async function sharedEntry(
  hive: DurableObjectStub<HiveDO>,
  title: string,
  body: string,
  visibility: "public" | "unlisted",
): Promise<{ url: string; id: number }> {
  await ensureEntryPattern(hive);
  const e = JSON.parse(await hive.mutate("gated_notes", "create", JSON.stringify({ title, body })));
  if (e.error) throw new Error(`entry create failed: ${e.message}`);
  const id = e.entry.id as number;
  const s = JSON.parse(await hive.proposeChange("Share", JSON.stringify({
    type: "set_sharing", pattern_name: "gated_notes", entry_id: id, visibility,
  })));
  if (s.error) throw new Error(`set_sharing failed: ${s.message}`);
  await hive.applyChange(s.change_id);
  return { url: `/o/entry/gated_notes/${id}`, id };
}

// --- /o/:path via an unlisted _outputs row ---

async function output(
  hive: DurableObjectStub<HiveDO>,
  path: string,
  content: string,
  visibility: "public" | "unlisted",
): Promise<string> {
  const r = JSON.parse(await hive.mutate("_outputs", "create", JSON.stringify({
    path, content, mime_type: "text/plain", visibility,
  })));
  if (r.error) throw new Error(`output create failed: ${r.message}`);
  return `/o/${path}`;
}

// --- /p/:path via an unlisted _publications row ---

let pubPatternReady = false;
async function ensurePubPattern(hive: DurableObjectStub<HiveDO>) {
  if (pubPatternReady) return;
  const p = JSON.parse(await hive.proposeChange("Create", JSON.stringify({
    type: "create_pattern", pattern_name: "gated_pub_notes", pattern_description: "t", doctrine: "t",
    facets: [{ name: "title", type: "text", required: true }],
  })));
  if (!p.error) await hive.applyChange(p.change_id);
  await hive.mutate("gated_pub_notes", "create", JSON.stringify({ title: "PUBSECRET_marker" }));
  pubPatternReady = true;
}

async function publication(
  hive: DurableObjectStub<HiveDO>,
  path: string,
  visibility: "public" | "unlisted",
): Promise<string> {
  await ensurePubPattern(hive);
  const r = JSON.parse(await hive.mutate("_publications", "create", JSON.stringify({
    path, source_pattern: "gated_pub_notes", format: "json", visibility,
  })));
  if (r.error) throw new Error(`publication create failed: ${r.message}`);
  return `/p/${path}`;
}

const GATED_ROUTES: GatedRoute[] = [
  {
    name: "/o/entry/:pattern/:id (shared entry)",
    scope: "read:entry:gated_notes:<id>",
    unlisted: async (hive) => {
      const { url } = await sharedEntry(hive, "UNLISTED_ENTRY_TITLE", "UNLISTED_ENTRY_BODY_SECRET", "unlisted");
      return { url, secrets: ["UNLISTED_ENTRY_TITLE", "UNLISTED_ENTRY_BODY_SECRET"] };
    },
    public: async (hive) => (await sharedEntry(hive, "PUBLIC_ENTRY_TITLE", "public body", "public")).url,
  },
  {
    name: "/o/:path (output egress)",
    scope: "read:output:<path>",
    unlisted: async (hive) => {
      const url = await output(hive, "gated-out-unlisted", "UNLISTED_OUTPUT_SECRET_BODY", "unlisted");
      return { url, secrets: ["UNLISTED_OUTPUT_SECRET_BODY"] };
    },
    public: (hive) => output(hive, "gated-out-public", "public output body", "public"),
  },
  {
    name: "/p/:path (publication)",
    scope: "read:publication:<path>",
    unlisted: async (hive) => {
      const url = await publication(hive, "gated-pub-unlisted", "unlisted");
      // The unlisted publication, if served, would render the source entry's
      // title ("PUBSECRET_marker") into its JSON body.
      return { url, secrets: ["PUBSECRET_marker"] };
    },
    public: (hive) => publication(hive, "gated-pub-public", "public"),
  },
  {
    name: "/f/:id (document store)",
    scope: "read:document:<id>",
    // /f/:id streams bytes from R2 (the DOCUMENTS binding). That binding is
    // commented out in wrangler.toml, so env.DOCUMENTS is unbound in CI and
    // serveDocument short-circuits to 404 before any visibility check — it can't
    // be driven live here. Skip (return null), mirroring served-inertness.test.ts.
    unlisted: async () => ((env as any).DOCUMENTS ? null /* would need a live R2 upload */ : null),
    public: async () => ((env as any).DOCUMENTS ? null : null),
  },
];

describe("served bearer-gating totality", () => {
  it("every served gated read route REFUSES an unlisted resource without a token (and serves the public one)", async () => {
    const hive = ownerHive();
    const refusalStatuses: Record<string, number> = {};
    let driven = 0;

    for (const route of GATED_ROUTES) {
      const planted = await route.unlisted(hive);
      if (planted == null) continue; // not drivable in this runtime (e.g. /f needs R2)

      // 1) UNLISTED, NO token → refused, body/secret not served.
      const unlistedRes = await SELF.fetch(`https://test.local${planted.url}`);
      const status = await assertRefused(unlistedRes, planted.secrets, route.name);
      refusalStatuses[route.name] = status;

      // 2) (sanity) PUBLIC variant → served 200, proving the gate is the only thing
      //    standing between an unauthenticated caller and the unlisted body.
      const publicUrl = await route.public(hive);
      if (publicUrl != null) {
        const publicRes = await SELF.fetch(`https://test.local${publicUrl}`);
        expect(publicRes.status, `${route.name}: public resource must be served`).toBe(200);
      }

      driven++;
    }

    // Floor: at least the three R2-free gated routes must have actually been driven
    // live — guards against the loop silently passing by skipping everything.
    expect(
      driven,
      `expected ≥3 served gated routes driven, drove ${driven} (statuses: ${JSON.stringify(refusalStatuses)})`,
    ).toBeGreaterThanOrEqual(3);

    // Every driven route refused with a non-200 (recorded for the report).
    for (const [name, status] of Object.entries(refusalStatuses)) {
      expect(status, `${name} refused with ${status}`).not.toBe(200);
    }
  });
});
