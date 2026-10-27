/**
 * Swift's facts for the component interface reading that are no reading of
 * its text: sourcekit-lsp reads its workspace whole, so it takes no bounds.
 * Which declarations are types, every import, and (none, in Swift) default
 * exports are read through its parser (the manifest's treeSitter).
 */

export const SWIFT_INTERFACES = {
  serverBounds: false,
};
