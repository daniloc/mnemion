// `cached` edge-wrapper behavior — proves the public-read cache actually offloads:
// a second GET of a public 200 is served from caches.default WITHOUT re-running the
// handler (and thus without touching the DO), while private/non-GET responses always
// run the handler. Keyed by URL; each test uses a unique URL to avoid contamination.
import { describe, it, expect } from "vitest";
import { cached } from "../../shared/Routing/router";
import type { RouteContext, RouteHandler } from "../../shared/Routing/router";

const ctxFor = (url: string, method = "GET") =>
  ({ request: new Request(url, { method }) } as unknown as RouteContext);

function counting(headers: Record<string, string>): { handler: RouteHandler; runs: () => number } {
  let n = 0;
  const handler: RouteHandler = async () => { n++; return new Response(`body-${n}`, { status: 200, headers }); };
  return { handler, runs: () => n };
}

describe("cached edge wrapper", () => {
  it("serves a public 200 from cache on the second GET — handler runs once", async () => {
    const { handler, runs } = counting({ "Cache-Control": "public, max-age=60" });
    const wrapped = cached(handler);
    const url = `https://x.local/o/pub-${Math.random()}`;
    const b1 = await (await wrapped(ctxFor(url))).text();
    const b2 = await (await wrapped(ctxFor(url))).text();
    expect(runs()).toBe(1);            // second call was a cache hit (no DO work)
    expect(b1).toBe("body-1");
    expect(b2).toBe("body-1");          // same cached body
  });

  it("does NOT cache a private response — handler runs every time", async () => {
    const { handler, runs } = counting({ "Cache-Control": "private, no-cache" });
    const wrapped = cached(handler);
    const url = `https://x.local/o/priv-${Math.random()}`;
    await wrapped(ctxFor(url));
    await wrapped(ctxFor(url));
    expect(runs()).toBe(2);
  });

  it("passes non-GET through uncached", async () => {
    const { handler, runs } = counting({ "Cache-Control": "public, max-age=60" });
    const wrapped = cached(handler);
    const url = `https://x.local/o/post-${Math.random()}`;
    await wrapped(ctxFor(url, "POST"));
    await wrapped(ctxFor(url, "POST"));
    expect(runs()).toBe(2);
  });
});
