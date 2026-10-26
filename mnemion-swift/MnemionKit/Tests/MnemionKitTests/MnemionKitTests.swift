import Foundation
import Synchronization
import Testing
@testable import MnemionKit

@Suite struct PKCETests {
    @Test func rfc7636AppendixBVector() {
        // RFC 7636 Appendix B: the S256 challenge for this verifier.
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        #expect(pkce.challenge == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    @Test func generatedVerifierIsURLSafeAndLongEnough() {
        let v = PKCE().verifier
        #expect(v.count >= 43)
        #expect(v.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
    }
}

@Suite struct OAuthTests {
    let oauth = OAuthClient(configuration: .init(clientName: "Test", redirectURI: URL(string: "com.example.app:/oauth/callback")!))

    @Test func normalizesHiveURLs() {
        #expect(OAuthClient.hiveURL(from: "hive.example.dev")?.absoluteString == "https://hive.example.dev")
        #expect(OAuthClient.hiveURL(from: " https://hive.example.dev/some/path?x=1 ")?.absoluteString == "https://hive.example.dev")
        #expect(OAuthClient.hiveURL(from: "http://localhost:8787")?.absoluteString == "http://localhost:8787")
        #expect(OAuthClient.hiveURL(from: "http://hive.example.dev") == nil) // plaintext only for local dev
        #expect(OAuthClient.hiveURL(from: "") == nil)
    }

    @Test func authorizeURLCarriesPKCEAndState() throws {
        let req = oauth.authorizationRequest(hive: URL(string: "https://hive.example.dev")!, clientID: "abc")
        let items = Dictionary(uniqueKeysWithValues: (URLComponents(url: req.url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(req.url.path == "/authorize")
        #expect(items["code_challenge_method"] == "S256")
        #expect(items["code_challenge"] == req.pkce.challenge)
        #expect(items["redirect_uri"] == "com.example.app:/oauth/callback")
        #expect(items["state"] == req.state)
        #expect(items["client_id"] == "abc")
    }

    @Test func callbackWithWrongStateIsRejected() async {
        let req = oauth.authorizationRequest(hive: URL(string: "https://hive.example.dev")!, clientID: "abc")
        await #expect(throws: AuthError.self) {
            try await oauth.exchange(callback: URL(string: "com.example.app:/oauth/callback?code=x&state=forged")!, for: req)
        }
    }

    @Test func memberComesFromTokenPrefix() {
        let c = Credentials(hiveURL: URL(string: "https://h")!, clientID: "c", accessToken: "sam:grant:secret", refreshToken: nil, expiresAt: .now)
        #expect(c.member == "sam")
    }

    @Test func formEncodingEscapesReservedCharacters() {
        #expect(OAuthClient.formEncode(["a": "x y&z=1", "b": "c:/d"]) == "a=x%20y%26z%3D1&b=c%3A%2Fd")
    }
}

@Suite struct ModelTests {
    @Test func decodesQueryRowsWithDynamicFacets() throws {
        let json = #"{"id":11,"title":"Build","status":"open","links":null,"version":2,"created_by":"owner","archived_at":null}"#
        let e = try JSONDecoder().decode(Entry.self, from: Data(json.utf8))
        #expect(e.id == 11)
        #expect(e.version == 2)
        #expect(e.string("title") == "Build")
        #expect(e.string("links") == nil)
        #expect(e.createdBy == "owner")
        #expect(!e.isArchived)
    }

    @Test func decodesIndexFacets() throws {
        let json = #"{"patterns":[{"name":"projects","description":"d","doctrine":null,"facets":[{"name":"status","type":"select","required":true,"default":"incubating","options":["active","incubating"]}],"entry_count":3,"latest_activity":null}]}"#
        let index = try JSONDecoder().decode(HiveIndex.self, from: Data(json.utf8))
        let status = try #require(index.pattern("projects")?.facet("status"))
        #expect(status.required)
        #expect(status.options == ["active", "incubating"])
        #expect(status.defaultValue == "incubating")
    }

    @Test func linkRowMapsBothEnds() throws {
        let json = #"{"id":4,"source_pattern":"tasks","source_id":11,"target_pattern":"projects","target_id":1,"label":"belongs-to"}"#
        let link = try #require(Link(try JSONDecoder().decode(Entry.self, from: Data(json.utf8))))
        #expect(link.source == EntryRef(pattern: "tasks", id: 11))
        #expect(link.target.description == "projects/1")
    }

    @Test func decodesLiveDelta() throws {
        let json = #"{"type":"changed","patterns":["tasks"],"delta":{"pattern":"tasks","op":"update","id":11,"entry":{"id":11,"status":"done"}}}"#
        let change = try JSONDecoder().decode(HiveChange.self, from: Data(json.utf8))
        #expect(change.touches("tasks"))
        #expect(change.delta?.entry?.string("status") == "done")
    }

    @Test func integralNumbersEncodeAsIntegers() throws {
        let data = try JSONEncoder().encode(["id": JSONValue(integerLiteral: 7)])
        #expect(String(decoding: data, as: UTF8.self) == #"{"id":7}"#)
    }
}

@Suite struct RelationTests {
    static func index(belongsToSource: String, patterns: [String]) throws -> HiveIndex {
        let pats = patterns.map { #"{"name":"\#($0)","facets":[{"name":"title","type":"text"}]}"# }.joined(separator: ",")
        let json = #"{"patterns":[\#(pats)],"relations":[{"name":"references","inverse":"referenced-by","source":["*"],"target":["*"],"cardinality":"many","required":false,"derived":false},{"name":"belongs-to","inverse":"has-member","source":\#(belongsToSource),"target":["projects"],"cardinality":"one","required":true,"derived":false}]}"#
        return try JSONDecoder().decode(HiveIndex.self, from: Data(json.utf8))
    }

    @Test func decodesTheRegistry() throws {
        let index = try Self.index(belongsToSource: #"["tasks"]"#, patterns: ["projects", "tasks"])
        let rel = try #require(index.relation("belongs-to"))
        #expect(rel.required)
        #expect(rel.cardinality == "one")
        #expect(rel.admitsTarget("projects"))
        #expect(!rel.admitsTarget("goals"))
        #expect(index.relation("has-member")?.name == "belongs-to") // inverse names resolve too
    }

    @Test func indexWithoutRelationsStillDecodes() throws {
        let index = try JSONDecoder().decode(HiveIndex.self, from: Data(#"{"patterns":[]}"#.utf8))
        #expect(index.relations.isEmpty)
        #expect(Portfolio.taskPattern(in: index) == nil)
    }

    @Test func taskPatternComesFromBelongsToSources() throws {
        // tasks is the one source.
        let merged = try Self.index(belongsToSource: #"["tasks"]"#, patterns: ["projects", "tasks"])
        #expect(Portfolio.taskPattern(in: merged)?.name == "tasks")
        // Several sources: tasks wins wherever it is listed; otherwise the first the hive has.
        let several = try Self.index(belongsToSource: #"["chores","tasks"]"#, patterns: ["projects", "chores", "tasks"])
        #expect(Portfolio.taskPattern(in: several)?.name == "tasks")
        let other = try Self.index(belongsToSource: #"["errands","chores"]"#, patterns: ["projects", "chores"])
        #expect(Portfolio.taskPattern(in: other)?.name == "chores")
        // A listed source the hive doesn't have is skipped.
        let stale = try Self.index(belongsToSource: #"["errands","tasks"]"#, patterns: ["projects", "tasks"])
        #expect(Portfolio.taskPattern(in: stale)?.name == "tasks")
        // Wildcard source: tasks, when the hive has it.
        let wild = try Self.index(belongsToSource: #"["*"]"#, patterns: ["projects", "notes", "tasks"])
        #expect(Portfolio.taskPattern(in: wild)?.name == "tasks")
    }

    static func link(_ id: Int, _ s: Int, _ t: Int, _ label: String = "serves") -> Link {
        Link(Entry(["id": .number(Double(id)), "source_pattern": "projects", "source_id": .number(Double(s)),
                    "target_pattern": "goals", "target_id": .number(Double(t)), "label": .string(label)]))!
    }

    @Test func alignmentRelationNeedsStoredServesWithExplicitEnds() throws {
        func index(_ serves: String) throws -> HiveIndex {
            try JSONDecoder().decode(HiveIndex.self, from: Data(#"{"patterns":[],"relations":[\#(serves)]}"#.utf8))
        }
        let ok = try index(#"{"name":"serves","inverse":"served-by","source":["projects"],"target":["goals"]}"#)
        #expect(Portfolio.alignmentRelation(in: ok)?.name == "serves")
        #expect(Portfolio.alignmentRelation(in: try index(#"{"name":"serves","inverse":"served-by","source":["*"],"target":["goals"]}"#)) == nil)
        #expect(Portfolio.alignmentRelation(in: try index(#"{"name":"serves","inverse":"served-by","source":["projects"],"target":["goals"],"derived":true}"#)) == nil)
        #expect(Portfolio.alignmentRelation(in: try index(#"{"name":"references","inverse":"referenced-by","source":["projects"],"target":["goals"]}"#)) == nil)
        #expect(Portfolio.alignmentRelation(in: HiveIndex(patterns: [])) == nil)
    }

    @Test func alignmentFindsUnalignedProjectsAndUnservedGoals() {
        let p = { EntryRef(pattern: "projects", id: $0) }, g = { EntryRef(pattern: "goals", id: $0) }
        let view = Portfolio.alignment(relation: "serves", sources: [p(1), p(2), p(3)], targets: [g(10), g(11), g(12)], links: [
            Self.link(1, 1, 10),
            Self.link(2, 1, 11),
            Self.link(3, 2, 12, "references"), // another relation aligns nothing
            Self.link(4, 9, 12),               // archived project: goal 12 stays unserved
            Self.link(5, 3, 99),               // archived goal: project 3 stays unaligned
        ])
        #expect(view == Alignment(unaligned: [p(2), p(3)], unserved: [g(12)]))
        #expect(Portfolio.alignment(relation: "serves", sources: [], targets: [], links: []) == Alignment())
    }
}

/// Captures requests and answers each with a canned body.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    struct Captured: Sendable { let url: URL?; let body: Data? }
    static let requests = Mutex<[Captured]>([])
    static let response = Mutex<String>("")

    static func client(responding body: String) -> HiveClient {
        requests.withLock { $0 = [] }
        response.withLock { $0 = body }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        let creds = Credentials(hiveURL: URL(string: "https://hive.example.dev")!, clientID: "c", accessToken: "owner:g:s", refreshToken: nil, expiresAt: .distantFuture)
        let tokens = TokenStore(
            credentials: creds,
            oauth: OAuthClient(configuration: .init(clientName: "Test", redirectURI: URL(string: "com.example.app:/oauth/callback")!)),
            keychain: KeychainStore(service: "test.mnemion.stub"),
            onSignedOut: {})
        return HiveClient(baseURL: creds.hiveURL, tokens: tokens, session: URLSession(configuration: config))
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buf = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buf, maxLength: buf.count)
                if n <= 0 { break }
                data.append(buf, count: n)
            }
            stream.close()
            body = data
        }
        Self.requests.withLock { $0.append(Captured(url: request.url, body: body)) }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.response.withLock { $0 }.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Every test here drives StubProtocol, whose captured requests are one shared
/// static; serialized so a parallel test can't reset another's capture.
@Suite(.serialized) struct StubClientTests {
    @Test func newTasksStartInTheFirstOpenOption() async throws {
        let schema = try DeclarationTests.schema(#"{"name":"status","type":"select","options":["done","queued","open"],"closed":["done"]}"#)
        let client = StubProtocol.client(responding: #"{"operation":"create","pattern":"tasks","entry":{"id":1},"uri":"mnemion://entry/tasks/1"}"#)
        _ = try await client.createTask(in: PatternEntry(pattern: "projects", entry: Entry(["id": 3])), title: "t", context: nil, schema: schema)
        let req = try #require(StubProtocol.requests.withLock { $0 }.first)
        let body = try JSONDecoder().decode([String: JSONValue].self, from: try #require(req.body))
        guard case .object(let data)? = body["data"] else { Issue.record("no data"); return }
        #expect(data["status"] == "queued")
    }

    @Test func exemptionsParseFromTheCharterValue() async throws {
        let client = StubProtocol.client(responding: #"{"entries":[{"id":9,"key":"review_exempt","value":"projects/8, goals/2 ,bad, x/y"}]}"#)
        let refs = try await client.reviewExemptions()
        #expect(refs == [EntryRef(pattern: "projects", id: 8), EntryRef(pattern: "goals", id: 2)])
    }

    @Test func createTaskIsOneWriteWithRelate() async throws {
        let index = try RelationTests.index(belongsToSource: #"["tasks"]"#, patterns: ["projects", "tasks"])
        let schema = try #require(Portfolio.taskPattern(in: index))
        let client = StubProtocol.client(responding: #"{"operation":"create","pattern":"tasks","entry":{"id":42,"title":"Ship"},"uri":"mnemion://entry/tasks/42","links":[{"id":9,"source":"tasks/42","target":"projects/3","label":"belongs-to"}]}"#)
        let project = PatternEntry(pattern: "projects", entry: Entry(["id": 3, "slug": "mnemion"]))

        let task = try await client.createTask(in: project, title: "Ship", context: "ignored: no context facet", schema: schema)

        #expect(task.ref == EntryRef(pattern: "tasks", id: 42))
        let requests = StubProtocol.requests.withLock { $0 }
        #expect(requests.count == 1) // the entry and its link together, never two writes
        let req = try #require(requests.first)
        #expect(req.url?.path == "/api/mutate/tasks")
        let body = try JSONDecoder().decode([String: JSONValue].self, from: try #require(req.body))
        guard case .object(let data)? = body["data"] else { Issue.record("no data"); return }
        #expect(data["_relate"] == .object(["belongs-to": "projects/3"]))
        #expect(data["title"] == "Ship")
        #expect(data["project"] == nil) // only facets the pattern declares
        #expect(data["context"] == nil)
    }

    static let reviewJSON = #"""
    {"as_of":"2026-10-28","timezone":"UTC",
     "hooks":{"pattern":"reviews","due":["day-start","week-start"],
              "status":[{"kind":"day-start","period":"2026-10-28","due":true,"last":null},
                        {"kind":"day-end","period":"2026-10-28","due":false,"last":{"id":3,"period":"2026-10-27"}}]},
     "work":[{"pattern":"tasks","open":5,"undated":1,"stall_days":45,
              "overdue":[{"pattern":"tasks","id":3,"label":"Email Christy","uri":"mnemion://entry/tasks/3","status":"open","deadline":"2026-03-15","updated_at":"2026-10-26 04:07:27"}],
              "due_today":[],"due_this_week":[],"stalled":[]}],
     "alignment":[{"chain":"addresses","relation":"serves","end":"target","pattern":"goals",
                   "entries":[{"pattern":"goals","id":12,"label":"Metabolize success","uri":"mnemion://entry/goals/12"}]}],
     "message":"Review: day-start and week-start reviews due; 1 overdue; 1 goals without inbound serves."}
    """#

    @Test func decodesTheDerivedReview() throws {
        let review = try JSONDecoder().decode(Review.self, from: Data(Self.reviewJSON.utf8))
        #expect(review.asOf == "2026-10-28")
        #expect(review.dueHooks == [.dayStart, .weekStart])
        #expect(review.status(of: .dayEnd)?.last?.id == 3)
        #expect(review.work[0].stallDays == 45)
        #expect(review.allOverdue.map(\.ref) == [EntryRef(pattern: "tasks", id: 3)])
        #expect(review.allOverdue[0].deadline == "2026-03-15")
        #expect(review.alignment[0].id == "addresses:serves:target:goals")
        #expect(review.alignment[0].entries[0].label == "Metabolize success")
        #expect(review.message?.hasPrefix("Review:") == true)
    }

    @Test func hooksPairUpAndCommitToTheRightPattern() {
        for hook in ReviewHook.allCases {
            #expect(hook.counterpart.counterpart == hook)
            #expect(hook.isStart != hook.counterpart.isStart)
        }
        #expect(ReviewHook.dayStart.commitsTo == "tasks")
        #expect(ReviewHook.weekStart.commitsTo == "projects")
        #expect(ReviewHook(rawValue: "month-end")?.counterpart == .monthStart)
    }

    @Test func recordReviewWritesOneEntryWithItsLinks() async throws {
        let client = StubProtocol.client(responding: #"{"operation":"create","pattern":"reviews","entry":{"id":7,"kind":"day-start"},"uri":"mnemion://entry/reviews/7"}"#)
        let review = try await client.recordReview(
            in: "reviews", hook: .dayStart, period: "2026-10-28", text: "Ship the review", energy: "high",
            commits: [EntryRef(pattern: "tasks", id: 41), EntryRef(pattern: "tasks", id: 42)], reflectsOn: nil)
        #expect(review.ref == EntryRef(pattern: "reviews", id: 7))
        let req = try #require(StubProtocol.requests.withLock { $0 }.first)
        #expect(req.url?.path == "/api/mutate/reviews")
        let body = try JSONDecoder().decode([String: JSONValue].self, from: try #require(req.body))
        guard case .object(let data)? = body["data"] else { Issue.record("no data"); return }
        #expect(data["kind"] == "day-start")
        #expect(data["period"] == "2026-10-28")
        #expect(data["intention"] == "Ship the review")
        #expect(data["reflection"] == nil)
        #expect(data["energy"] == "high")
        #expect(data["_relate"] == .object(["commits-to": .array(["tasks/41", "tasks/42"])]))
    }

    @Test func endReviewReflectsOnItsStart() async throws {
        let client = StubProtocol.client(responding: #"{"operation":"create","pattern":"reviews","entry":{"id":8},"uri":"mnemion://entry/reviews/8"}"#)
        _ = try await client.recordReview(in: "reviews", hook: .dayEnd, period: "2026-10-28", text: "It shipped", energy: nil, commits: [], reflectsOn: EntryRef(pattern: "reviews", id: 7))
        let req = try #require(StubProtocol.requests.withLock { $0 }.first)
        let body = try JSONDecoder().decode([String: JSONValue].self, from: try #require(req.body))
        guard case .object(let data)? = body["data"] else { Issue.record("no data"); return }
        #expect(data["reflection"] == "It shipped")
        #expect(data["intention"] == nil)
        #expect(data["_relate"] == .object(["reflects-on": "reviews/7"]))
    }

    @Test func captureNeedsOnlyABody() async throws {
        let client = StubProtocol.client(responding: #"{"operation":"create","pattern":"inbox","entry":{"id":1,"body":"an idea","status":"open"},"uri":"mnemion://entry/inbox/1"}"#)
        let note = try await client.capture("an idea", source: .mac, url: "https://example.com")
        #expect(note.ref == EntryRef(pattern: "inbox", id: 1))
        let req = try #require(StubProtocol.requests.withLock { $0 }.first)
        #expect(req.url?.path == "/api/mutate/inbox")
        let body = try JSONDecoder().decode([String: JSONValue].self, from: try #require(req.body))
        guard case .object(let data)? = body["data"] else { Issue.record("no data"); return }
        #expect(data["body"] == "an idea")
        #expect(data["source"] == "mac")
        #expect(data["url"] == "https://example.com")
        #expect(data["status"] == "open")
        #expect(data["_relate"] == nil) // no project at capture, by doctrine
    }

    @Test func makeTaskIsBornDerivedFromTheNote() async throws {
        let index = try RelationTests.index(belongsToSource: #"["tasks"]"#, patterns: ["projects", "tasks"])
        let schema = try #require(Portfolio.taskPattern(in: index))
        let client = StubProtocol.client(responding: #"{"operation":"create","pattern":"tasks","entry":{"id":50,"title":"Do it","version":0},"uri":"mnemion://entry/tasks/50"}"#)
        let note = PatternEntry(pattern: "inbox", entry: Entry(["id": 9, "body": "Do it", "version": 1]))
        let project = PatternEntry(pattern: "projects", entry: Entry(["id": 3]))
        _ = try await client.makeTask(from: note, in: project, title: "Do it", context: nil, schema: schema)
        let requests = StubProtocol.requests.withLock { $0 }
        #expect(requests.count == 2) // the task with its links, then the note's triage
        let body = try JSONDecoder().decode([String: JSONValue].self, from: try #require(requests[0].body))
        guard case .object(let data)? = body["data"] else { Issue.record("no data"); return }
        #expect(data["_relate"] == .object(["belongs-to": "projects/3", "derived-from": "inbox/9"]))
        #expect(requests[1].url?.path == "/api/mutate/inbox")
    }

    @Test func primeAndSearchDecodeLeniently() async throws {
        let prime = StubProtocol.client(responding: #"{"charter":{},"results":[{"pattern":"axioms","id":7,"relevance":0.81,"entry":{"id":7,"axiom":"The goal is cognitive everpresence."},"uri":"mnemion://entry/axioms/7","linked":[]}],"count":1}"#)
        let hits = try await prime.prime("everpresence", limit: 3)
        #expect(hits.map(\.label) == ["The goal is cognitive everpresence."])
        #expect(try #require(hits.first).ref == EntryRef(pattern: "axioms", id: 7))
        let req = try #require(StubProtocol.requests.withLock { $0 }.first)
        #expect(req.url?.path == "/api/prime")

        let search = StubProtocol.client(responding: #"{"term":"x","results":[{"pattern":"notes","entry":{"id":2,"body":"x marks"},"matched_facets":["body"]}],"count":1}"#)
        let found = try await search.search("x", patterns: ["notes"])
        let hit = try #require(found.first)
        #expect(hit.ref == EntryRef(pattern: "notes", id: 2))
        #expect(hit.matchedFacets == ["body"])
        let sreq = try #require(StubProtocol.requests.withLock { $0 }.first)
        #expect(sreq.url?.query?.contains("patterns=notes") == true)
    }

    @Test func entryLabelFollowsTheWorkerOrder() {
        #expect(Entry(["id": 1, "title": "T", "body": "B"]).label == "T")
        #expect(Entry(["id": 1, "axiom": "A", "meaning": "M"]).label == "A")
        #expect(Entry(["id": 1, "observation": "a long observation", "updated_at": "2026"]).label == "a long observation")
        #expect(Entry(["id": 4]).label == "#4")
    }

    @Test func moveIsOneBatchOfUnlinkAndLink() async throws {
        let client = StubProtocol.client(responding: #"{"ok":true}"#)
        let task = PatternEntry(pattern: "tasks", entry: Entry(["id": 1]))
        let old = PatternEntry(pattern: "projects", entry: Entry(["id": 8]))
        let new = PatternEntry(pattern: "projects", entry: Entry(["id": 2]))
        try await client.move(task, from: old, to: new)
        let req = try #require(StubProtocol.requests.withLock { $0 }.first)
        #expect(req.url?.path == "/api/batch")
        let body = try JSONDecoder().decode([String: JSONValue].self, from: try #require(req.body))
        guard case .array(let ops)? = body["operations"], ops.count == 2,
              case .object(let unlink) = ops[0], case .object(let link) = ops[1] else { Issue.record("bad batch"); return }
        #expect(unlink["pattern"] == "unlink")
        #expect(link["pattern"] == "link")
        #expect(link["data"] == .object(["source": "tasks/1", "target": "projects/2", "label": "belongs-to"]))
    }
}

@Suite struct DeclarationTests {
    static func schema(_ statusJSON: String) throws -> PatternSummary {
        let json = #"{"patterns":[{"name":"tasks","facets":[{"name":"title","type":"text"},\#(statusJSON)]}]}"#
        return try #require(try JSONDecoder().decode(HiveIndex.self, from: Data(json.utf8)).pattern("tasks"))
    }

    @Test func facetsDecodeResolutionAndClosed() throws {
        let json = #"{"patterns":[{"name":"t","facets":[{"name":"deadline","type":"datetime","resolution":"day"},{"name":"status","type":"select","options":["open","done"],"closed":["done"]}]}]}"#
        let p = try #require(try JSONDecoder().decode(HiveIndex.self, from: Data(json.utf8)).pattern("t"))
        #expect(p.facet("deadline")?.resolution == "day")
        #expect(p.facet("status")?.closed == ["done"])
        #expect(p.facet("deadline")?.closed == nil)
    }

    @Test func closedComesOnlyFromTheDeclaration() throws {
        let declared = try Self.schema(#"{"name":"status","type":"select","options":["open","done","parked"],"closed":["parked"]}"#)
        let parked = PatternEntry(pattern: "tasks", entry: Entry(["id": 1, "status": "parked"]))
        let done = PatternEntry(pattern: "tasks", entry: Entry(["id": 2, "status": "done"]))
        #expect(Portfolio.isClosed(parked, schema: declared))
        #expect(!Portfolio.isClosed(done, schema: declared)) // "done" is open where the hive says so
        #expect(Portfolio.toggledStatus(for: parked, schema: declared) == "open")
        #expect(Portfolio.toggledStatus(for: done, schema: declared) == "parked")

        // No declaration: nothing is closed and the checkmark has nothing to write.
        let undeclared = try Self.schema(#"{"name":"status","type":"select","options":["todo","finished"]}"#)
        #expect(!Portfolio.isClosed(done, schema: undeclared))
        #expect(Portfolio.toggledStatus(for: done, schema: undeclared) == nil)
        #expect(!Portfolio.isClosed(done, schema: nil))
        #expect(Portfolio.toggledStatus(for: done, schema: nil) == nil)
    }
}
