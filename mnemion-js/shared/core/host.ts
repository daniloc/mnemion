// Instance identity is configuration, not request data.
//
// `resolveHost` is the single decision behind every generated capability URL
// (upload_url / page_url / og_image / the _system/instance doc): which host does
// this instance call itself?
//
// @why A meaningfully-configured WORKER_HOST is AUTHORITATIVE and the inbound Host
// header is IGNORED — so an attacker who sends a spoofed `Host` on an
// unauthenticated request (e.g. a /ws upgrade) cannot poison a capability URL
// handed to the owner. The observed/inbound host is trusted ONLY in local dev
// (DEV=true), where WORKER_HOST is unset or still the deploy placeholder and the
// request host IS the right answer. Outside dev an unconfigured host fails
// CLOSED: no host at all, so no URL is generated, rather than a URL built from
// request data or from the placeholder (a workers.dev name anyone could claim).
// Pulling the priority into a pure function makes the property enumerable and
// testable away from the Durable Object, instead of asserted only by convention.

/** The wrangler.toml `[vars]` default for WORKER_HOST. A deploy that never ran
 *  `npm run setup` (which pins the real host) leaves this placeholder — treated
 *  as "not configured". */
export const WORKER_HOST_PLACEHOLDER = "your-worker.workers.dev";

/** True when `configured` names a real host (not unset, empty, or the placeholder). */
export function isConfiguredHost(configured: string | null | undefined): configured is string {
  return !!configured && configured !== WORKER_HOST_PLACEHOLDER;
}

/**
 * Resolve the instance host. A real `configured` WORKER_HOST wins and the inbound
 * `lastKnownHost` is ignored (the security boundary). Without one, local dev
 * (`dev`) falls back to the observed host, then "localhost"; anywhere else the
 * answer is null — fail closed, the caller generates no URL.
 */
export function resolveHost(
  configured: string | null | undefined,
  lastKnownHost: string | null,
  dev: boolean,
): string | null {
  if (isConfiguredHost(configured)) return configured;
  if (dev) return lastKnownHost ?? "localhost";
  return null;
}

/** What a caller says in place of a URL it refused to generate. */
export const HOST_UNCONFIGURED_NOTE =
  "This instance has no WORKER_HOST configured, so it will not generate links (a link built from the request's Host header could be spoofed). Set WORKER_HOST to the deployed host (npm run setup does this) and redeploy.";
