// Product identity — single source of truth for the URI scheme and product name.
// Import from here instead of hardcoding "mnemion://" in string literals.

export const PRODUCT_NAME = "Mnemion";
export const URI_SCHEME = "mnemion";
export const URI_PREFIX = `${URI_SCHEME}://`;

/** Build a full URI from a path, e.g. uri("index") → "mnemion://index" */
export function uri(path: string): string {
  return `${URI_PREFIX}${path}`;
}
