import Foundation

/// `GET /api/index` — the hive's master index: what patterns exist, their facets,
/// and the relation registry (`mnemion://relations`) that every link must name.
public struct HiveIndex: Decodable, Sendable {
    public let patterns: [PatternSummary]
    public let relations: [Relation]

    public init(patterns: [PatternSummary], relations: [Relation] = []) {
        self.patterns = patterns
        self.relations = relations
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        patterns = try c.decode([PatternSummary].self, forKey: .patterns)
        relations = try c.decodeIfPresent([Relation].self, forKey: .relations) ?? []
    }

    enum CodingKeys: String, CodingKey { case patterns, relations }

    public func pattern(_ name: String) -> PatternSummary? {
        patterns.first { $0.name == name }
    }

    /// A relation by its name or its inverse (the hive accepts either on a write).
    public func relation(_ name: String) -> Relation? {
        relations.first { $0.name == name } ?? relations.first { $0.inverse == name }
    }
}

/// A declared relation: the label a link carries, which patterns it joins, and
/// whether every entry of its source patterns must hold one (then a create has
/// to carry it inline in `_relate`). `"*"` in an end admits any pattern.
public struct Relation: Decodable, Sendable, Hashable {
    public let name: String
    public let inverse: String
    public let description: String?
    public let source: [String]
    public let target: [String]
    public let cardinality: String
    public let required: Bool
    /// Computed from a chain of stored relations at read time; never written.
    public let derived: Bool

    enum CodingKeys: String, CodingKey {
        case name, inverse, description, source, target, cardinality, required, derived
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        inverse = try c.decode(String.self, forKey: .inverse)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        source = try c.decodeIfPresent([String].self, forKey: .source) ?? []
        target = try c.decodeIfPresent([String].self, forKey: .target) ?? []
        cardinality = try c.decodeIfPresent(String.self, forKey: .cardinality) ?? "many"
        required = try c.decodeIfPresent(Bool.self, forKey: .required) ?? false
        derived = try c.decodeIfPresent(Bool.self, forKey: .derived) ?? false
    }

    public func admitsSource(_ pattern: String) -> Bool { source.contains(pattern) || source.contains("*") }
    public func admitsTarget(_ pattern: String) -> Bool { target.contains(pattern) || target.contains("*") }
}

public struct PatternSummary: Decodable, Sendable, Hashable, Identifiable {
    public let name: String
    public let description: String?
    public let doctrine: String?
    public let facets: [Facet]
    public let entryCount: Int?
    public let latestActivity: String?

    public var id: String { name }

    public func facet(_ name: String) -> Facet? { facets.first { $0.name == name } }

    enum CodingKeys: String, CodingKey {
        case name, description, doctrine, facets
        case entryCount = "entry_count"
        case latestActivity = "latest_activity"
    }
}

public struct Facet: Decodable, Sendable, Hashable {
    public let name: String
    public let type: String
    public let required: Bool
    public let defaultValue: JSONValue?
    public let options: [String]?
    public let readonly: Bool
    /// datetime facets: "day" holds calendar days only (the hive refuses a time of day).
    public let resolution: String?
    /// select facets: the options that end an item, declared once for every reader.
    public let closed: [String]?

    enum CodingKeys: String, CodingKey {
        case name, type, required, options, readonly, resolution, closed
        case defaultValue = "default"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        type = try c.decode(String.self, forKey: .type)
        required = (try? c.decode(JSONValue.self, forKey: .required))?.boolValue ?? false
        defaultValue = try c.decodeIfPresent(JSONValue.self, forKey: .defaultValue)
        options = try c.decodeIfPresent([String].self, forKey: .options)
        readonly = try c.decodeIfPresent(Bool.self, forKey: .readonly) ?? false
        resolution = try c.decodeIfPresent(String.self, forKey: .resolution)
        closed = try c.decodeIfPresent([String].self, forKey: .closed)
    }
}
