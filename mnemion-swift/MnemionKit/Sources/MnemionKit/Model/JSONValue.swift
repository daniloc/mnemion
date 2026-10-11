import Foundation

/// A facet value as the hive stores it. Patterns are agent-evolved, so the client
/// never hard-codes a row shape: entries are facet-name → JSONValue maps, and
/// views read the facets they know about.
public enum JSONValue: Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])
}

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n):
            if n.rounded() == n, abs(n) < 9e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}

extension JSONValue {
    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    public var intValue: Int? {
        switch self {
        case .number(let n): return Int(exactly: n.rounded())
        case .string(let s): return Int(s)
        default: return nil
        }
    }

    public var boolValue: Bool? {
        switch self {
        case .bool(let b): return b
        case .number(let n): return n != 0
        default: return nil
        }
    }

    public var isNull: Bool { self == .null }

    /// A human-readable rendering for generic facet display.
    public var displayString: String {
        switch self {
        case .null: return ""
        case .bool(let b): return b ? "Yes" : "No"
        case .number(let n): return n.rounded() == n ? String(Int64(n)) : String(n)
        case .string(let s): return s
        case .array(let a): return a.map(\.displayString).joined(separator: ", ")
        case .object:
            let data = (try? JSONEncoder().encode(self)) ?? Data()
            return String(decoding: data, as: UTF8.self)
        }
    }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral, ExpressibleByNilLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(nilLiteral: ()) { self = .null }
}
