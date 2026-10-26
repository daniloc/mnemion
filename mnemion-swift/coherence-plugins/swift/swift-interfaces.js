/**
 * Swift's facts for the interface map: what a declaration line's keyword
 * says can execute (interfaces.ts reads them through the declares slot).
 */

import { declarationAt } from "./swift-source.js";

/**
 * A func, a class, a struct, an actor or an enum has a body (a type's
 * methods are its own); a protocol, a typealias or an associatedtype
 * declares a type; a let set to a literal is a value; a var, or a let set
 * to anything else (a closure, a call's result), may hold code, so it is
 * counted as able to execute.
 */
export function swiftDeclares(line) {
  const declared = declarationAt(line);
  if (declared === undefined) return "unknown";
  switch (declared.keyword) {
    case "protocol":
    case "typealias":
    case "associatedtype":
      return "type";
    case "let":
      return /^(?:[\d"'.-]|true\b|false\b|nil\b|\[)/.test(declared.value) ? "value" : /^\{/.test(declared.value) ? "body" : "unknown";
    case "var":
      return /^\{/.test(declared.value) ? "body" : "unknown";
    default:
      return "body";
  }
}
