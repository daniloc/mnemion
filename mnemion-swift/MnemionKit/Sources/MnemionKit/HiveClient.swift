import Foundation

public enum HiveError: LocalizedError, Sendable {
    /// The hive answered `{error: true, message}` — validation, version conflict, etc.
    case hive(String)
    case http(status: Int, body: String)
    case decoding(String)

    public var errorDescription: String? {
        switch self {
        case .hive(let m): return m
        case .http(let s, let b): return "HTTP \(s)\(b.isEmpty ? "" : ": \(b.prefix(200))")"
        case .decoding(let m): return "Unexpected response from the hive: \(m)"
        }
    }

    /// Optimistic-lock miss: someone else (another surface, an agent) wrote first.
    public var isVersionConflict: Bool {
        if case .hive(let m) = self { return m.localizedCaseInsensitiveContains("version conflict") }
        return false
    }
}

public enum MutateOperation: String, Sendable {
    case create, update, patch, archive, unarchive
}

public struct MutateResult: Decodable, Sendable {
    public let operation: String
    public let pattern: String
    public let entry: Entry?
    public let uri: String?
    /// The links a create was born with (`_relate`), written in the same transaction.
    public let links: [CreatedLink]?

    public struct CreatedLink: Decodable, Sendable {
        public let id: Int
        public let source: String
        public let target: String
        public let label: String
    }
}

/// `POST /api/resolve` — an entry plus everything one link-hop away.
public struct Resolution: Decodable, Sendable {
    public let pattern: String
    public let entry: Entry
    public let linked: [Linked]?

    public struct Linked: Decodable, Sendable {
        public let pattern: String
        public let id: Int
        public let entry: Entry
        public let uri: String
        public let label: String?
    }
}

/// The hive's owner-plane HTTP API (`/api/*`), authenticated by an OAuth bearer.
/// The same semantics the web app and MCP tools use: query/mutate/resolve over
/// patterns, with every write attributed to the signed-in member server-side.
public final class HiveClient: Sendable {
    public let baseURL: URL
    public let tokens: TokenStore
    let session: URLSession

    public init(baseURL: URL, tokens: TokenStore, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.tokens = tokens
        self.session = session
    }

    // MARK: Reads

    public func index() async throws -> HiveIndex {
        try decode(HiveIndex.self, from: try await send(get("api/index")))
    }

    /// Filters use the hive grammar: `facet<op>value`, op ∈ `= != > < >= <= ~ |=`.
    public func query(_ pattern: String, filters: [String] = [], sort: String? = nil, limit: Int? = nil, facets: [String]? = nil) async throws -> [Entry] {
        var items = filters.map { URLQueryItem(name: "filter", value: $0) }
        if let sort { items.append(.init(name: "sort", value: sort)) }
        if let limit { items.append(.init(name: "limit", value: String(limit))) }
        if let facets { items.append(.init(name: "facets", value: facets.joined(separator: ","))) }
        let page = try decode(QueryPage.self, from: try await send(get("api/query/\(pattern)", query: items)))
        return page.entries
    }

    public func resolve(_ uri: String) async throws -> Resolution {
        try decode(Resolution.self, from: try await send(post("api/resolve", body: ["uri": .string(uri)])))
    }

    /// Active `_links` rows matching the given ends (nil = any).
    public func links(source: EntryRef? = nil, targetPattern: String? = nil, targetID: Int? = nil, label: String? = nil) async throws -> [Link] {
        var filters: [String] = []
        if let source { filters += ["source_pattern=\(source.pattern)", "source_id=\(source.id)"] }
        if let targetPattern { filters.append("target_pattern=\(targetPattern)") }
        if let targetID { filters.append("target_id=\(targetID)") }
        if let label { filters.append("label=\(label)") }
        return try await query("_links", filters: filters, limit: 1000).compactMap(Link.init)
    }

    /// Fetch specific entries of one pattern in a single round-trip (`id|=…`).
    public func entries(_ pattern: String, ids: [Int]) async throws -> [Entry] {
        guard !ids.isEmpty else { return [] }
        return try await query(pattern, filters: ["id|=\(ids.map(String.init).joined(separator: ","))"], limit: 1000)
    }

    // MARK: Writes

    /// Pass `version` in `data` on update to get optimistic locking. On create,
    /// `relate` (relation name or inverse → targets) becomes `_relate`: the entry
    /// and all its links are written together, or the create is refused whole.
    @discardableResult
    public func mutate(_ pattern: String, _ operation: MutateOperation, _ data: [String: JSONValue], relate: [String: [EntryRef]] = [:]) async throws -> MutateResult {
        var data = data
        let relate = relate.filter { !$0.value.isEmpty }
        if !relate.isEmpty {
            data["_relate"] = .object(relate.mapValues { refs in
                refs.count == 1 ? .string(refs[0].description) : .array(refs.map { .string($0.description) })
            })
        }
        let body: [String: JSONValue] = ["operation": .string(operation.rawValue), "data": .object(data)]
        return try decode(MutateResult.self, from: try await send(post("api/mutate/\(pattern)", body: body)))
    }

    /// Create a `_links` row (`source` —label→ `target`).
    public func link(_ source: EntryRef, to target: EntryRef, label: String) async throws {
        let body: [String: JSONValue] = [
            "operation": "create",
            "data": .object(["source": .string(source.description), "target": .string(target.description), "label": .string(label)]),
        ]
        _ = try await send(post("api/mutate/link", body: body))
    }

    // MARK: Plumbing

    private struct QueryPage: Decodable { let entries: [Entry] }

    func get(_ path: String, query: [URLQueryItem] = []) -> URLRequest {
        var comps = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query }
        return URLRequest(url: comps.url!)
    }

    func post(_ path: String, body: [String: JSONValue]) -> URLRequest {
        var req = URLRequest(url: baseURL.appending(path: path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONEncoder().encode(body)
        return req
    }

    /// Attach the bearer; on a 401 refresh once and retry. Surfaces the hive's
    /// in-band `{error: true}` as `HiveError.hive`.
    func send(_ request: URLRequest) async throws -> Data {
        var req = request
        let token = try await tokens.accessToken()
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        var (data, response) = try await session.data(for: req)
        if (response as? HTTPURLResponse)?.statusCode == 401 {
            let fresh = try await tokens.refreshAfterRejection(of: token)
            req.setValue("Bearer \(fresh)", forHTTPHeaderField: "Authorization")
            (data, response) = try await session.data(for: req)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw HiveError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        if let err = try? JSONDecoder().decode(InBandError.self, from: data), err.error {
            throw HiveError.hive(err.message ?? "The hive refused the request.")
        }
        return data
    }

    private struct InBandError: Decodable { let error: Bool; let message: String? }

    func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) }
        catch { throw HiveError.decoding(String(describing: error)) }
    }
}
