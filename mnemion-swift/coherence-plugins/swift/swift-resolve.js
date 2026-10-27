/**
 * Where a Swift import leads: what no parse can say, since a module's place
 * is the SwiftPM or XcodeGen target layout, not its syntax. What a file
 * declares and imports is read through Swift's parser and swift.scm (the
 * manifest's treeSitter).
 *
 * A module is a target, a folder of files: `import MnemionKit` leads to the
 * target of that name, read off every Package.swift and project.yml under
 * the root (swift-source.js modulesOf). A system or dependency module
 * (Foundation, SwiftUI, a package the manifest fetches) resolves to nothing.
 * The module is returned whole, its folder and every file, and Coherence
 * joins the import to the files that declare the names the importer uses,
 * or to all of them when none does.
 *
 * Not read: the files of one module see each other with no import written
 * (internal is module-wide). The parser path reads imports from the text
 * alone, so a change's closure reaches a sibling file through the language
 * server's references, not through an import.
 */

import { resolveTarget } from "./swift-source.js";

export const SWIFT_RESOLVE = {
  resolveModule(root, _from, specifier, vanished) {
    return resolveTarget(root, specifier, vanished);
  },
  modulePaths: () => [],
};
