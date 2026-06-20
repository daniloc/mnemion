// federation.ts — cross-hive (foreign-URI) resolution, evicted from HiveDO.
//
// This is the security-critical seam: it is the only place that sends THIS
// hive's access token (?token= → Authorization: Bearer) to another origin. The
// entire point of keeping it as one module is CO-LOCATION — the allow-list
// consent check and the token-bearing fetch live side-by-side in `federatedResolve`,
// so "the host the human approved" and "the host we actually contacted" can never
// drift apart. A token is attached only to a request whose host is BOTH
// (a) not `isBlockedFederationHost(host)` (SSRF block) AND (b) `ctx.isHostAllowed(host)`
// (consent allow-list) — and that pair is re-checked on the INITIAL request AND on
// EVERY redirect hop, in lockstep with the fetch loop. Splitting the gate from the
// fetch would let a future edit move one without the other; here they move as a unit.
//
// FederationContext is deliberately narrow: a bound `isHostAllowed(host)` (which
// wraps the `_federation_hosts` lookup — the module never sees `db`) plus `errorJson`.
// `isBlockedFederationHost` / `normalizeHost` are pure and imported directly.
import { normalizeHost, isBlockedFederationHost } from "./kernel";
import { uri } from "../../shared/core/constants";

export interface FederationContext {
  /** True if `host` is on this hive's federation allow-list (active _federation_hosts
   *  row). Bound by the DO over the `_federation_hosts` lookup so this module never
   *  touches `db` — the consent gate is the only DB capability it gets. */
  isHostAllowed(host: string): boolean;
  errorJson(message: string): string;
}

/** Resolve a foreign-hive URI (`mnemion://other.hive.dev/entry/axioms/7`) by
 *  fetching `https://<host>/o/<path>`, optionally carrying `?token=` as a Bearer.
 *  The allow-list/SSRF gate and the token-bearing fetch are co-located here so an
 *  approved host and a contacted host can never diverge. */
export async function federatedResolve(
  ctx: FederationContext, host: string, path: string,
): Promise<string> {
  const [cleanPath, queryString] = path.split("?");
  const params = new URLSearchParams(queryString || "");
  const token = params.get("token");

  if (!cleanPath) {
    return ctx.errorJson(`Foreign URI ${uri(host + "/")} requires a path after the host`);
  }

  // SSRF guard: refuse to fetch loopback / private / link-local / internal
  // targets. Federation is for sovereign public hives; an attacker-influenced
  // URI must not be able to probe internal infrastructure or cloud metadata.
  if (isBlockedFederationHost(host)) {
    return ctx.errorJson(`Refusing to federate with non-public host: ${host}`);
  }

  // Consent boundary: only federate with hosts the human has explicitly
  // approved (entries in _federation_hosts). This is what stops an agent —
  // possibly acting on untrusted content — from sending this hive's access
  // token (?token=) to an arbitrary attacker-controlled host.
  if (!ctx.isHostAllowed(host)) {
    return ctx.errorJson(
      `Host "${normalizeHost(host)}" is not on this hive's federation allow-list, so resolve will not contact it (and will not send any token). ` +
      `If the human approves federating with it, add it: mutate(pattern: "_federation_hosts", data: {host: "${normalizeHost(host)}"}).`
    );
  }

  // Build the fetch URL from the SAME normalized host we authorized above —
  // never the raw segment — so "what we approved" and "what we contact" can't
  // diverge.
  let currentUrl = `https://${normalizeHost(host)}/o/${cleanPath}`;

  // Manual redirect handling. The host block + consent allow-list are only
  // meaningful if every hop is re-validated: with the default redirect:"follow"
  // a compromised or redirecting peer could bounce us to 169.254.169.254 /
  // loopback (SSRF) or carry the owner's token to an un-approved host. We
  // follow at most MAX_REDIRECTS hops, re-checking the block list AND the
  // allow-list on each, and only send the token to allow-listed hosts.
  const MAX_REDIRECTS = 3;

  try {
    let response: Response;
    for (let hop = 0; ; hop++) {
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      response = await fetch(currentUrl, { headers, redirect: "manual" });

      const location = response.headers.get("Location");
      if (response.status >= 300 && response.status < 400 && location) {
        if (hop >= MAX_REDIRECTS) {
          return ctx.errorJson(`Foreign hive ${host} exceeded the redirect limit for: ${cleanPath}`);
        }
        let next: URL;
        try {
          next = new URL(location, currentUrl);
        } catch {
          return ctx.errorJson(`Foreign hive ${host} returned an invalid redirect for: ${cleanPath}`);
        }
        if (next.protocol !== "https:") {
          return ctx.errorJson(`Refusing to follow non-https redirect from ${host} (token not sent).`);
        }
        if (isBlockedFederationHost(next.host) || !ctx.isHostAllowed(next.host)) {
          return ctx.errorJson(`Refusing to follow redirect from ${host} to non-allow-listed host ${next.host} (token not sent).`);
        }
        currentUrl = next.toString();
        continue;
      }
      break;
    }

    if (!response.ok) {
      const status = response.status;
      if (status === 401) return ctx.errorJson(`Foreign hive at ${host} requires authorization for: ${cleanPath}`);
      if (status === 404) return ctx.errorJson(`Not found on foreign hive ${host}: ${cleanPath}`);
      return ctx.errorJson(`Foreign hive ${host} returned ${status} for: ${cleanPath}`);
    }

    const content = await response.text();
    const contentType = response.headers.get("Content-Type") || "text/plain";

    // Parse JSON responses so they nest cleanly
    if (contentType.includes("application/json")) {
      try {
        return JSON.stringify({ federated: true, host, path: cleanPath, content: JSON.parse(content) }, null, 2);
      } catch { /* fall through to text */ }
    }

    return JSON.stringify({ federated: true, host, path: cleanPath, content_type: contentType, content }, null, 2);
  } catch (e: any) {
    return ctx.errorJson(`Failed to reach foreign hive at ${host}: ${e.message}`);
  }
}
