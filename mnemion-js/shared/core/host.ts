// Instance identity is configuration, not request data.
//
// `resolveHost` is the single decision behind every generated capability URL
// (upload_url / page_url / og_image / the _system/instance doc): which host does
// this instance call itself?
//
// @why A meaningfully-configured WORKER_HOST is AUTHORITATIVE and the inbound Host
// header is IGNORED — so an attacker who sends a spoofed `Host` on an
// unauthenticated request (e.g. a /ws upgrade) cannot poison a capability URL
// handed to the owner. The observed/inbound host is only the fallback for LOCAL
// DEV, where WORKER_HOST is unset or still the deploy placeholder and the request
// host IS the right answer. Pulling the priority into a pure function makes the
// "ignore inbound when configured" property enumerable and testable away from the
// Durable Object, instead of a behavior asserted only by convention.

/** The wrangler.toml `[vars]` default for WORKER_HOST. A deploy that never ran
 *  `npm run setup` (which pins the real host) leaves this placeholder — treated
 *  as "not meaningfully configured", so the dev fallback applies. */
export const WORKER_HOST_PLACEHOLDER = "your-worker.workers.dev";

/**
 * Resolve the instance host. A real `configured` WORKER_HOST wins and the inbound
 * `lastKnownHost` is ignored (the security boundary); otherwise fall back to the
 * observed host, then the placeholder, then "localhost" (local dev only).
 */
export function resolveHost(
  configured: string | null | undefined,
  lastKnownHost: string | null,
): string {
  if (configured && configured !== WORKER_HOST_PLACEHOLDER) return configured;
  return lastKnownHost ?? configured ?? "localhost";
}
