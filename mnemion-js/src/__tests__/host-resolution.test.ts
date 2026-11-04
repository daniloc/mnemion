// instance-identity host resolution — the contract that closes the last tier-3
// crossing in the trust atlas (public-egress → owner-trusted via currentHost).
//
// THE security property: a meaningfully-configured WORKER_HOST is authoritative
// and the inbound/observed Host is IGNORED, so an attacker who poisons
// `lastKnownHost` with a spoofed Host on an unauthenticated request can never
// shift a generated capability URL (upload_url / page_url / og_image). The
// observed host is the LOCAL-DEV fallback only (DEV=true); an unconfigured
// deployed instance fails CLOSED (null → no URL), never falling back to the
// request host or the claimable placeholder. `currentHost` (hive.ts) delegates
// the whole decision here, so testing this pure function IS testing the boundary.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { resolveHost, WORKER_HOST_PLACEHOLDER } from "../../shared/core/host";
import { renderInstanceDoc } from "../../entities/Hive/reports";
import wranglerConfig from "../../wrangler.toml?raw";

// A spread of inbound/observed hosts an attacker might plant via a spoofed Host.
const SPOOFED = ["evil.example", "attacker.tld:8080", "169.254.169.254", "localhost", null];
const UNCONFIGURED = [WORKER_HOST_PLACEHOLDER, undefined, null, ""];

describe("instance-identity host resolution", () => {
  it("a real WORKER_HOST is authoritative — the inbound Host is IGNORED for every spoof, dev or not", () => {
    const configured = "mnemion.real-host.dev";
    for (const spoofed of SPOOFED) {
      for (const dev of [false, true]) {
        expect(
          resolveHost(configured, spoofed, dev),
          `configured WORKER_HOST must win over inbound "${spoofed}" (dev=${dev})`,
        ).toBe(configured);
      }
    }
  });

  it("outside dev an unconfigured host fails CLOSED — never the inbound Host, never the placeholder", () => {
    for (const configured of UNCONFIGURED) {
      for (const spoofed of SPOOFED) {
        expect(
          resolveHost(configured, spoofed, false),
          `resolveHost(${JSON.stringify(configured)}, ${JSON.stringify(spoofed)}, false)`,
        ).toBeNull();
      }
    }
  });

  it("only local dev falls back to the observed host, then localhost", () => {
    for (const configured of UNCONFIGURED) {
      expect(resolveHost(configured, "observed.local", true)).toBe("observed.local");
      expect(resolveHost(configured, null, true)).toBe("localhost");
    }
  });

  it("the instance doc names no host when the host is unconfigured", () => {
    const doc = renderInstanceDoc({ currentHost: () => null } as any);
    expect(doc).toContain("WORKER_HOST");
    expect(doc).not.toMatch(/https:\/\//);
  });

  it("the committed config carries no host — each install sets its own", () => {
    // wrangler.toml is the one-click template: a host committed there would point
    // every fork's capability URLs at someone else's instance.
    expect(wranglerConfig).not.toMatch(/^\s*WORKER_HOST\s*=/m);
    expect(wranglerConfig).toMatch(/^keep_vars\s*=\s*true/m);
    expect((env as any).WORKER_HOST).toBe("hive.test"); // vitest.config supplies the suite's
  });
});
