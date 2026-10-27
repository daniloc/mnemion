import Foundation
import Testing

/// Structural rules over the app's sources: the places where a reader once
/// re-decided something the hive declares. Each rule names a home; a hit is a
/// convention creeping back. Mirrors the worker's label-literal test.
@Suite struct ConventionTests {
    static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    static func sources(_ relative: String) throws -> [(path: String, text: String)] {
        let dir = root.appending(path: relative)
        let files = try FileManager.default.subpathsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".swift") }
        return try files.sorted().map { (path: "\(relative)/\($0)", text: try String(contentsOf: dir.appending(path: $0), encoding: .utf8)) }
    }

    /// Lines matching `pattern`, as "path:line: text", comments skipped.
    static func hits(in files: [(path: String, text: String)], _ pattern: String) throws -> [String] {
        let re = try Regex(pattern)
        var out: [String] = []
        for file in files {
            for (i, line) in file.text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                let code = line.split(separator: "//", maxSplits: 1).first.map(String.init) ?? ""
                if code.contains(re) { out.append("\(file.path):\(i + 1): \(line.trimmingCharacters(in: .whitespaces))") }
            }
        }
        return out
    }

    @Test func appNeverSpellsAStatusOrEnergyValue() throws {
        // Home: the pattern's facets (options, closed) via the index in PortfolioStore.
        // Every write form the app uses: ["status": "x"], ["status": .string("x")],
        // a default "?? "x"", an initial State("x"), or a literal list of values.
        let app = try Self.sources("Mnemion") + Self.sources("MnemionShare")
        #expect(try Self.hits(in: app, #""(status|energy)":\s*(\.string\()?"[a-z-]+""#).isEmpty)
        // A query filter on a status is a spelled value too; a kernel pattern's (_members)
        // vocabulary is the worker's own, published in its system docs, so it is let through.
        #expect(try Self.hits(in: app, #"^(?!.*_members).*"status=[a-z-]"#).isEmpty)
        #expect(try Self.hits(in: app, #"\?\?\s*"(open|done|dropped|in-progress|doing|medium|low|high)""#).isEmpty)
        #expect(try Self.hits(in: app, #"(status|energy|Statuses)\s*(:\s*\[String\])?\s*=\s*"[a-z-]+""#).isEmpty)
        #expect(try Self.hits(in: app, #"\[\s*"open"\s*,\s*"done"\s*\]"#).isEmpty)
    }

    @Test func kitKeepsNoStatusVocabulary() throws {
        // Home: the hive's declaration (Facet.closed); the Kit has no fallback set.
        // The one declared exception: Inbox.swift carries the inbox doctrine's own words
        // (status open/triaged/dropped, source), declared by this client when it
        // declared the pattern; triage must tell triaged from dropped, which no
        // `closed` list can say. No other Kit file spells a status.
        let kit = try Self.sources("MnemionKit/Sources").filter { !$0.path.hasSuffix("Inbox.swift") }
        #expect(try Self.hits(in: kit, #"\[\s*"done"\s*,"#).isEmpty)
        #expect(try Self.hits(in: kit, #""status=[a-z-]"#).isEmpty)
        #expect(try Self.hits(in: kit, #""status":\s*\.string\("[a-z-]+"\)"#).isEmpty)
        #expect(try Self.hits(in: kit, #"fallbackClosed|closedStatuses"#).isEmpty)
    }

    @Test func noEntryIsNamedByIdOrSlugInCode() throws {
        // Home: the charter (review_exempt) and the entries themselves.
        let all = try Self.sources("Mnemion") + Self.sources("MnemionKit/Sources")
        #expect(try Self.hits(in: all, #""catch-all""#).isEmpty)
        #expect(try Self.hits(in: all, #""(projects|goals|tasks)/\d+""#).isEmpty)
    }

    @Test func sheetsSizeThroughOneModifier() throws {
        // Home: View.sheetSize in Dates.swift, which knows the platform.
        let views = try Self.sources("Mnemion/Views").filter { !$0.path.hasSuffix("Dates.swift") }
        #expect(try Self.hits(in: views, #"\.frame\(minWidth"#).isEmpty)
    }

    @Test func viewsNeverReloadOutsideTheStore() throws {
        // Home: PortfolioStore's coalesced loaders; views use .task / .refreshable.
        let views = try Self.sources("Mnemion/Views")
        #expect(try Self.hits(in: views, #"Task\s*\{\s*(\[.*\]\s*in\s*)?await\s+(self\.)?store\.load"#).isEmpty)
    }
}
