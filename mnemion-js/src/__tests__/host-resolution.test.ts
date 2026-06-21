// instance-identity host resolution — the contract that closes the last tier-3
// crossing in the trust atlas (public-egress → owner-trusted via currentHost).
//
// THE security property: a meaningfully-configured WORKER_HOST is authoritative
// and the inbound/observed Host is IGNORED, so an attacker who poisons
// `lastKnownHost` with a spoofed Host on an unauthenticated request can never
// shift a generated capability URL (upload_url / page_url / og_image). The
// observed host is the LOCAL-DEV fallback only (WORKER_HOST unset / placeholder).
// `currentHost` (hive.ts) delegates the whole decision here, so testing this pure
// function IS testing the boundary.
import { describe, it, expect } from "vitest";
import { resolveHost, WORKER_HOST_PLACEHOLDER } from "../../shared/core/host";

describe("instance-identity host resolution", () => {
  // A spread of inbound/observed hosts an attacker might plant via a spoofed Host.
  const SPOOFED = ["evil.example", "attacker.tld:8080", "169.254.169.254", "localhost", null];

  it("a real WORKER_HOST is authoritative — the inbound Host is IGNORED for every spoof", () => {
    const configured = "mnemion.real-host.dev";
    for (const spoofed of SPOOFED) {
      expect(
        resolveHost(configured, spoofed),
        `configured WORKER_HOST must win over inbound "${spoofed}"`,
      ).toBe(configured);
    }
  });

  it("falls back to the observed host ONLY when WORKER_HOST is unset or the placeholder (local dev)", () => {
    // [configured, lastKnown, expected]
    const CASES: Array<[string | null | undefined, string | null, string]> = [
      [WORKER_HOST_PLACEHOLDER, "observed.local", "observed.local"], // placeholder → dev fallback
      [WORKER_HOST_PLACEHOLDER, null, WORKER_HOST_PLACEHOLDER],       // placeholder, nothing observed
      [undefined, "observed.local", "observed.local"],               // unset → dev fallback
      [null, null, "localhost"],                                     // nothing at all → localhost
      ["", "observed.local", "observed.local"],                      // empty string is not "configured"
    ];
    for (const [configured, lastKnown, expected] of CASES) {
      expect(resolveHost(configured, lastKnown), `resolveHost(${JSON.stringify(configured)}, ${JSON.stringify(lastKnown)})`).toBe(expected);
    }
  });

  it("the placeholder is never treated as a configured host", () => {
    // If it were, a deploy that skipped `npm run setup` would pin every URL to the
    // literal placeholder domain instead of falling back to the real request host.
    expect(resolveHost(WORKER_HOST_PLACEHOLDER, "real-request.host")).not.toBe(WORKER_HOST_PLACEHOLDER);
  });
});
