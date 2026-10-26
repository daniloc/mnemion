/**
 * What the spec model asks of a Swift file: whether its top level declares
 * a name. A func, type, protocol, typealias, let or var at bracket depth
 * zero, attributes on the lines above included; a member of a type, a local
 * inside a body, a name inside a comment or string, or a type an extension
 * reopens is not one. Read through swift-source.js, the plugin's one model
 * of Swift.
 */

import { declarationsIn } from "./swift-source.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether the text declares the name at its top level. */
export function swiftDeclaresAtTop(text, name) {
  if (!IDENT.test(name)) return false;
  return declarationsIn(text).some((d) => d.name === name);
}
