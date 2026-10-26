/**
 * Swift's facts for the component interface reading: which declaration
 * lines declare a type only, and what the word index reads of a file's
 * imports (component-interfaces.ts reads them through the interfaces slot).
 */

import { declarationAt } from "./swift-source.js";

/**
 * A protocol or a typealias declares a type only; a struct, class, actor or
 * enum carries methods, so a reach goes on through it. Swift has no default
 * export and renames nothing on import (`import struct M.T` narrows, never
 * renames), so no import list extends a name to an alias; a whole-module
 * import brings every name in unqualified, which the word index reads as
 * any other token. sourcekit-lsp reads its workspace whole, so it takes no
 * bounds.
 */
export const SWIFT_INTERFACES = {
  isTypeDeclaration(line) {
    const keyword = declarationAt(line)?.keyword;
    return keyword === "protocol" || keyword === "typealias" || keyword === "associatedtype";
  },
  isDefaultExport: () => false,
  serverBounds: false,
  importLists: () => [],
  defaultNames: () => [],
  wildcardModules: () => [],
};
