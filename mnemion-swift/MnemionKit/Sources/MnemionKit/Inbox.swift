import Foundation

/// The hive's `inbox` pattern, as its doctrine defines it: capture first,
/// classify later. A note needs only a body; triage later turns it into a task
/// (`derived-from` the note) or attaches it to a project or concept with a
/// `references` link, and sets `status` so the original stays as the record.
public enum Inbox {
    public static let pattern = "inbox"
    public static let derivedFrom = "derived-from"
    public static let references = "references"

    public enum Status: String, Sendable { case open, triaged, dropped }
}

/// Where a note was captured, as the `source` facet names it.
public enum CaptureSource: String, Sendable, CaseIterable {
    case mac, iphone, watch, share, agent

    /// The source for this device.
    public static var current: CaptureSource {
        #if os(macOS)
        return .mac
        #elseif os(watchOS)
        return .watch
        #else
        return .iphone
        #endif
    }
}

extension HiveClient {
    /// Notes in `status`, newest first.
    public func notes(status: Inbox.Status = .open, limit: Int = 200) async throws -> [PatternEntry] {
        try await query(Inbox.pattern, filters: ["status=\(status.rawValue)"], sort: "-created_at", limit: limit)
            .map { PatternEntry(pattern: Inbox.pattern, entry: $0) }
    }

    /// Capture a note. No project, no classification; `url` when a link was shared.
    public func capture(_ body: String, source: CaptureSource = .current, url: String? = nil) async throws -> PatternEntry {
        var data: [String: JSONValue] = ["body": .string(body), "source": .string(source.rawValue), "status": .string(Inbox.Status.open.rawValue)]
        if let url, !url.isEmpty { data["url"] = .string(url) }
        let created = try await mutate(Inbox.pattern, .create, data)
        guard let entry = created.entry else { throw HiveError.decoding("create returned no entry") }
        return PatternEntry(pattern: Inbox.pattern, entry: entry)
    }

    /// Set a note's triage status, keeping the note.
    public func triage(_ note: PatternEntry, _ status: Inbox.Status) async throws -> PatternEntry {
        try await update(note, ["status": .string(status.rawValue)])
    }

    /// Connect an entry to another under a declared relation (the note references
    /// a concept it touches, a task references a note it came from).
    public func connect(_ source: EntryRef, to target: EntryRef, as relation: String = Inbox.references) async throws {
        try await link(source, to: target, label: relation)
    }

    /// Triage a note into a task: the task is born in its project with
    /// `derived-from` the note, and the note is marked triaged.
    public func makeTask(from note: PatternEntry, in project: PatternEntry, title: String, context: String?, schema: PatternSummary) async throws -> PatternEntry {
        let task = try await createTask(in: project, title: title, context: context, schema: schema, also: [Inbox.derivedFrom: [note.ref]])
        _ = try await triage(note, .triaged)
        return task
    }
}
