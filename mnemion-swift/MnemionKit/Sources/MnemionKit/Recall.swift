import Foundation

/// Recall for the human: `POST /api/prime` and `GET /api/search`, the same
/// calls the MCP tools make. Prime is recall by meaning with one-hop links;
/// search is full text across every text facet.
public struct PrimeHit: Decodable, Sendable, Hashable {
    public let pattern: String
    public let id: Int
    public let relevance: Double?
    public let entry: Entry
    public let uri: String
    public var ref: EntryRef { EntryRef(pattern: pattern, id: id) }
    public var label: String { entry.label }
}

public struct SearchHit: Decodable, Sendable, Hashable {
    public let pattern: String
    public let entry: Entry
    public let matchedFacets: [String]?
    public var ref: EntryRef { EntryRef(pattern: pattern, id: entry.id) }
    public var label: String { entry.label }

    enum CodingKeys: String, CodingKey { case pattern, entry, matchedFacets = "matched_facets" }
}

struct PrimePage: Decodable {
    let results: [PrimeHit]
    let degraded: Bool?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        results = try c.decodeIfPresent([PrimeHit].self, forKey: .results) ?? []
        degraded = try c.decodeIfPresent(Bool.self, forKey: .degraded)
    }

    enum CodingKeys: String, CodingKey { case results, degraded }
}

struct SearchPage: Decodable {
    let results: [SearchHit]
}

extension Entry {
    /// The entry as one line, the way the worker's deriveLabel reads it: the first
    /// of the label keys, then the longest text value, then the id.
    public var label: String {
        for key in ["name", "title", "label", "key", "context", "axiom", "principle", "frame", "body"] {
            if let v = string(key) { return v }
        }
        let texts = values.compactMap { k, v -> String? in
            guard !Entry.kernelColumns.contains(k), case .string(let s) = v, !s.isEmpty else { return nil }
            return s
        }
        return texts.max { $0.count < $1.count } ?? "#\(id)"
    }

    static let kernelColumns: Set<String> = ["id", "version", "created_at", "updated_at", "archived_at", "created_by", "updated_by"]
}

extension HiveClient {
    /// Recall by meaning: the nearest entries to `context`, across every pattern
    /// unless `patterns` narrows it. Each hit's one-hop links ride in `linked`
    /// on the wire but are not decoded here; `resolve` has them when needed.
    public func prime(_ context: String, patterns: [String] = [], limit: Int = 8) async throws -> [PrimeHit] {
        var body: [String: JSONValue] = ["context": .string(context), "limit": .number(Double(limit))]
        if !patterns.isEmpty { body["patterns"] = .array(patterns.map { .string($0) }) }
        return try decode(PrimePage.self, from: try await send(post("api/prime", body: body))).results
    }

    /// Full-text search across text facets.
    public func search(_ term: String, patterns: [String] = [], limit: Int = 20) async throws -> [SearchHit] {
        var items = [URLQueryItem(name: "q", value: term), URLQueryItem(name: "limit", value: String(limit))]
        if !patterns.isEmpty { items.append(URLQueryItem(name: "patterns", value: patterns.joined(separator: ","))) }
        return try decode(SearchPage.self, from: try await send(get("api/search", query: items))).results
    }
}
