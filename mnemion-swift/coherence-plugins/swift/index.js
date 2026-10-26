/**
 * The Swift plugin: Coherence's reading of Swift through sourcekit-lsp (the
 * toolchain's language server, found through xcrun or on the PATH), run by a
 * project whose config names it under plugins and swift under language.
 */

import { SwiftAdapter } from "./swift.js";

const swift = {
  adapter: ({ root }) => new SwiftAdapter(root),
};

export default swift;
