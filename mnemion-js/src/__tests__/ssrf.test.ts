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

// === TOTALITY: every category the guard must block ===
//
// Convention → contract. isBlockedFederationHost is the SSRF chokepoint; this
// table names EVERY class it is supposed to refuse, keyed by category. A future
// edit that drops a class (an inet_aton encoding, an IPv6 form, a suffix) makes
// that category's representative host(s) leak — and FAILS the matching loop case
// below by name. The table is the spec the guard derives from; the loop is the
// totality oracle. To widen the guard, add a category here too.
describe("SSRF block-host totality", () => {
  // Each category maps to representative host(s) that MUST be blocked. Read off
  // the guard's actual branches (isPrivateIPv4 / parseIPv4Literal /
  // parseIPv6Literal / isBlockedIPv6Bytes / the suffix + normalize logic), not
  // guessed — every example below corresponds to a live branch in kernel.ts.
  const BLOCKED_CATEGORIES: Record<string, string[]> = {
    // --- IPv4 ranges (isPrivateIPv4) ---
    "ipv4 loopback 127.0.0.0/8": ["127.0.0.1", "127.1.2.3"],
    "ipv4 this-network 0.0.0.0/8": ["0.0.0.0", "0.1.2.3"],
    "ipv4 private 10.0.0.0/8": ["10.0.0.5", "10.255.255.255"],
    "ipv4 private 172.16.0.0/12": ["172.16.0.1", "172.31.255.255"],
    "ipv4 private 192.168.0.0/16": ["192.168.1.1", "192.168.0.0"],
    "ipv4 CGNAT 100.64.0.0/10": ["100.64.0.1", "100.127.255.255"],
    "ipv4 link-local 169.254.0.0/16": ["169.254.0.1", "169.254.255.255"],
    "ipv4 cloud metadata 169.254.169.254": ["169.254.169.254"],

    // --- the SAME metadata IP in every inet_aton encoding (parseIPv4Literal) ---
    "metadata: dotted-decimal": ["169.254.169.254"],
    // octal 0251.0376.0251.0376 == 169.254.169.254 (0251₈=169, 0376₈=254);
    // mixed-base 0xa9.0xfe.0xa9.0xfe is the same address.
    "metadata: octal": ["0251.0376.0251.0376", "0xa9.0xfe.0xa9.0xfe"],
    "metadata: hex": ["0xA9FEA9FE", "0xa9fea9fe"],
    "metadata: single 32-bit integer": ["2852039166"],
    // loopback in alternate encodings too (each must collapse to 127.x)
    "loopback: alternate encodings": ["2130706433", "0x7f000001", "0177.0.0.1", "127.1"],

    // --- IPv6 (parseIPv6Literal + isBlockedIPv6Bytes); brackets as URL yields ---
    "ipv6 loopback ::1": ["[::1]", "[0:0:0:0:0:0:0:1]"],
    "ipv6 unspecified ::": ["[::]"],
    "ipv6 ULA fc00::/7": ["[fc00::1]", "[fd12:3456::1]"],
    "ipv6 link-local fe80::/10": ["[fe80::1]"],
    "ipv6 site-local fec0::/10": ["[fec0::1]"],
    "ipv6 link-local with zone id": ["[fe80::1%eth0]"],
    "ipv6 IPv4-mapped ::ffff:<private-v4>": ["[::ffff:169.254.169.254]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]"],
    "ipv6 IPv4-compatible ::<private-v4>": ["[::127.0.0.1]", "[::7f00:1]"],
    "ipv6 NAT64 64:ff9b::<private-v4>": ["[64:ff9b::169.254.169.254]", "[64:ff9b::127.0.0.1]", "[64:ff9b::7f00:1]"],
    "ipv6 6to4 2002:<private-v4>::": ["[2002:7f00:1::]", "[2002:a9fe:a9fe::]"],

    // --- hostname suffixes (the suffix branch) ---
    "hostname localhost": ["localhost"],
    "hostname *.localhost": ["foo.localhost", "svc.app.localhost"],
    "hostname *.local": ["box.local"],
    "hostname *.internal": ["svc.internal"],
    "hostname *.lan": ["host.lan"],
    "hostname trailing-dot FQDN form": ["localhost.", "box.local.", "svc.internal.", "host.lan.", "127.0.0.1."],

    // --- normalizeHost must strip these BEFORE the host is judged ---
    "normalize: scheme-prefixed": ["x://169.254.169.254", "https://169.254.169.254"],
    "normalize: userinfo": ["user@169.254.169.254", "user:pass@127.0.0.1"],
    "normalize: port": ["169.254.169.254:8080", "127.0.0.1:443"],

    // --- malformed / unparseable → fail closed ---
    "malformed → fail closed": ["[::ffff:zzzz]", "[fe80:::1]", "[not-an-ip]", "256.256.256.256:::", "["],
  };

  for (const [category, examples] of Object.entries(BLOCKED_CATEGORIES)) {
    for (const host of examples) {
      it(`blocks category «${category}» — ${host}`, () => {
        expect(isBlockedFederationHost(host)).toBe(true);
      });
    }
  }

  // The dual: representative PUBLIC hosts the guard must NOT block. A category
  // that over-blocks (a public host wrongly refused) fails here.
  const ALLOWED_CATEGORIES: Record<string, string[]> = {
    "public domain": ["example.com", "other.hive.dev", "sub.domain.co.uk"],
    "public IPv4": ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1"],
    "public IPv6": ["[2606:4700:4700::1111]", "[2001:db8::1]"],
    "public 6to4 wrapping a public v4": ["[2002:0808:0808::]"],
  };

  for (const [category, examples] of Object.entries(ALLOWED_CATEGORIES)) {
    for (const host of examples) {
      it(`allows category «${category}» — ${host}`, () => {
        expect(isBlockedFederationHost(host)).toBe(false);
      });
    }
  }
});
