import Foundation

/// One entry: its kernel columns plus whatever facets its pattern declares.
public struct Entry: Codable, Hashable, Sendable {
    public var values: [String: JSONValue]

    public init(_ values: [String: JSONValue]) { self.values = values }

    public init(from decoder: Decoder) throws {
        values = try [String: JSONValue](from: decoder)
    }

    public func encode(to encoder: Encoder) throws { try values.encode(to: encoder) }

    public subscript(facet: String) -> JSONValue? { values[facet] }

    public func string(_ facet: String) -> String? {
        guard let v = values[facet], !v.isNull else { return nil }
        let s = v.displayString
        return s.isEmpty ? nil : s
    }

    // Kernel columns (auto-provided on every pattern).
    public var id: Int { values["id"]?.intValue ?? 0 }
    public var version: Int? { values["version"]?.intValue }
    public var createdAt: String? { string("created_at") }
    public var updatedAt: String? { string("updated_at") }
    public var createdBy: String? { string("created_by") }
    public var updatedBy: String? { string("updated_by") }
    public var isArchived: Bool { !(values["archived_at"]?.isNull ?? true) }
}

/// An entry's address: `pattern/id`, the same shorthand `link` takes.
public struct EntryRef: Hashable, Sendable, CustomStringConvertible {
    public let pattern: String
    public let id: Int

    public init(pattern: String, id: Int) {
        self.pattern = pattern
        self.id = id
    }

    public var description: String { "\(pattern)/\(id)" }
    public var uri: String { "mnemion://entry/\(pattern)/\(id)" }
}

/// An entry together with the pattern it lives in — the identity the UI keys on,
/// since ids are only unique within a pattern.
public struct PatternEntry: Hashable, Sendable, Identifiable {
    public let pattern: String
    public var entry: Entry

    public init(pattern: String, entry: Entry) {
        self.pattern = pattern
        self.entry = entry
    }

    public var ref: EntryRef { EntryRef(pattern: pattern, id: entry.id) }
    public var id: String { ref.description }
}

/// A `_links` row: `source` relates to `target` under `label`
/// (e.g. a project-task `belongs-to` a project).
public struct Link: Hashable, Sendable {
    public let id: Int
    public let source: EntryRef
    public let target: EntryRef
    public let label: String?

    init?(_ row: Entry) {
        guard let sp = row.string("source_pattern"), let sid = row["source_id"]?.intValue,
              let tp = row.string("target_pattern"), let tid = row["target_id"]?.intValue else { return nil }
        id = row.id
        source = EntryRef(pattern: sp, id: sid)
        target = EntryRef(pattern: tp, id: tid)
        label = row.string("label")
    }
}
