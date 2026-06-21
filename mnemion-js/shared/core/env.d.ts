// Optional-binding augmentation for the generated worker Env.
//
// R2 (the DOCUMENTS bucket) ships COMMENTED OUT in wrangler.toml by design —
// Mnemion runs fully without it (see "Document storage requires R2"). So
// `wrangler types` never emits DOCUMENTS on the generated global `Env`, yet the
// code reads `env.DOCUMENTS` on the optional path. Declare it here with the honest
// optional type so the worker type-checks whether or not R2 is enabled/bound.
export {};

declare global {
  // `DurableObject<Env = Cloudflare.Env>` resolves `this.env` to Cloudflare.Env,
  // so the optional binding must be declared on the namespaced interface (the bare
  // global `Env` is a different merge target).
  namespace Cloudflare {
    interface Env {
      DOCUMENTS?: R2Bucket;
    }
  }
}
