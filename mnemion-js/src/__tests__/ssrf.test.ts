import { describe, it, expect } from "vitest";
import { isBlockedFederationHost } from "../../entities/Hive/kernel";

// Regression coverage for SSRF host blocking. Federation/web fetches must never
// reach loopback/private/link-local/internal targets, including via alternate
// IPv4 encodings and IPv6 literal forms. These are the cases that previously
// slipped through a string-based block list.

describe("isBlockedFederationHost", () => {
  const blocked = [
    // IPv4 private/reserved/metadata
    "127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "172.31.255.255",
    "169.254.169.254", "169.254.169.254:8080", "100.64.0.1", "0.0.0.0",
    // IPv4 alternate encodings (all == 127.0.0.1 / private)
    "2130706433", "0x7f000001", "0177.0.0.1", "127.1", "0x0a000001",
    // Hostnames that are internal by suffix (incl. FQDN-root trailing dot)
    "localhost", "foo.localhost", "svc.internal", "box.local", "host.lan",
    "localhost.", "box.local.", "svc.internal.", "host.lan.", "127.0.0.1.",
    // IPv6 loopback / unspecified / ULA / link-local / site-local
    "[::1]", "[::]", "[0:0:0:0:0:0:0:1]", "[fc00::1]", "[fd12:3456::1]",
    "[fe80::1]", "[fec0::1]",
    // IPv6 embedding a private IPv4: mapped, compatible, NAT64
    "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::ffff:169.254.169.254]",
    "[::127.0.0.1]", "[::7f00:1]", "[64:ff9b::7f00:1]", "[64:ff9b::127.0.0.1]",
    // 6to4 (2002::/16) wrapping a private/loopback IPv4
    "[2002:7f00:1::]", "[2002:a9fe:a9fe::]",
    // userinfo confusion — real host is the loopback
    "user@127.0.0.1",
  ];

  const allowed = [
    "example.com", "hive.example.dev", "peer.bsky.app", "sub.domain.co.uk",
    "my-hive.workers.dev", "example.com:8443",
    "8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "example.com.",
    "[2606:4700:4700::1111]", "[2001:db8::1]", "[2606:4700::1]",
    "[2002:0808:0808::]", // 6to4 wrapping a public IPv4 (8.8.8.8) — allowed
  ];

  for (const host of blocked) {
    it(`blocks ${host}`, () => {
      expect(isBlockedFederationHost(host)).toBe(true);
    });
  }

  for (const host of allowed) {
    it(`allows ${host}`, () => {
      expect(isBlockedFederationHost(host)).toBe(false);
    });
  }

  it("fails closed on an unparseable host", () => {
    expect(isBlockedFederationHost("::1")).toBe(true); // bare IPv6 → URL parse fails → refuse
    expect(isBlockedFederationHost("")).toBe(true);
  });
});
