import Foundation

/// `GET /api/index` — the hive's master index: what patterns exist and their facets.
public struct HiveIndex: Decodable, Sendable {
    public let patterns: [PatternSummary]

    public func pattern(_ name: String) -> PatternSummary? {
        patterns.first { $0.name == name }
    }
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

    enum CodingKeys: String, CodingKey {
        case name, type, required, options, readonly
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
    }
}
