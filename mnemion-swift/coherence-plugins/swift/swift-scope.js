/**
 * Swift's facts for the component interface reading that are no reading of
 * its text: sourcekit-lsp reads its workspace whole, so it takes no bounds,
 * and Swift has no default export. Which declarations are types, and every
 * import, are read through its parser (the manifest's treeSitter).
 */

export const SWIFT_INTERFACES = {
  serverBounds: false,
  isDefaultExport: () => false,
};
