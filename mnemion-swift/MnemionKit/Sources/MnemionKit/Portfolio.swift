import Foundation

/// The hive's project vocabulary, as the `projects` doctrine defines it: tasks
/// connect to a project through a `belongs-to` link, projects to goals through
/// `serves`. The link graph is the source of truth. Which pattern holds tasks is
/// read off the relation registry (the sources of `belongs-to`), not assumed.
public enum Portfolio {
    public static let projects = "projects"
    public static let tasks = "tasks"
    public static let goals = "goals"
    public static let belongsTo = "belongs-to"
    public static let serves = "serves"
    /// The charter key naming entries the review exempts from alignment gaps
    /// (the catch-all project that serves no goal by design). Stored truth the
    /// worker and every client read; never a slug or an id in code.
    public static let exemptKey = "review_exempt"

    /// Whether an entry is closed, by its pattern's declared terminal statuses
    /// (`closed` on the status select). No declaration, nothing closed: the
    /// hive is the only home of this rule, and this client never guesses.
    public static func isClosed(_ item: PatternEntry, schema: PatternSummary?) -> Bool {
        guard let closed = schema?.facet("status")?.closed, !closed.isEmpty else { return false }
        let status = item.entry.string("status")?.lowercased() ?? ""
        return closed.contains { $0.lowercased() == status }
    }

    /// The status a tap on the checkmark writes: the first declared closed
    /// option to finish, the first open option to reopen. Nil when the pattern
    /// declares no closed values, so the checkmark can only offer what the hive
    /// will accept.
    public static func toggledStatus(for item: PatternEntry, schema: PatternSummary?) -> String? {
        guard let facet = schema?.facet("status"), let options = facet.options,
              let closed = facet.closed, !closed.isEmpty else { return nil }
        if isClosed(item, schema: schema) {
            return options.first { !closed.contains($0) }
        }
        return closed.first { options.contains($0) }
    }

    /// The pattern new tasks are created in: `tasks` when `belongs-to` (to
    /// projects) admits it, else the first source pattern the hive has. Nil when
    /// the hive has no such relation or none of its sources exist.
    public static func taskPattern(in index: HiveIndex) -> PatternSummary? {
        guard let rel = index.relation(belongsTo), !rel.derived, rel.admitsTarget(projects) else { return nil }
        if rel.source.contains("*") { return index.pattern(tasks) }
        let candidates = rel.source.compactMap(index.pattern)
        return candidates.first { $0.name == tasks } ?? candidates.first
    }

    // MARK: Alignment

    /// The stored `serves` relation with explicit ends, or nil when the hive
    /// declares none (the alignment view then doesn't apply). A `*` end has no
    /// "every entry of this pattern" to judge, so it doesn't qualify.
    public static func alignmentRelation(in index: HiveIndex) -> Relation? {
        guard let rel = index.relations.first(where: { $0.name == serves }), !rel.derived else { return nil }
        let explicit = { (end: [String]) in !end.isEmpty && !end.contains("*") }
        return explicit(rel.source) && explicit(rel.target) ? rel : nil
    }

    /// The weekly review's "unaligned" read (relations.md, decision 2): active
    /// sources holding no link of `relation` (projects serving no goal) and active
    /// targets nothing active links to (goals no work feeds). A link counts only
    /// when both its ends are in the given active sets, so a goal served only by
    /// an archived project is still unserved. Order follows the inputs. Mirrors
    /// `alignmentView` in `mnemion-js/shared/core/alignment-view.ts`.
    public static func alignment(relation: String, sources: [EntryRef], targets: [EntryRef], links: [Link]) -> Alignment {
        let activeSources = Set(sources), activeTargets = Set(targets)
        var serving = Set<EntryRef>(), served = Set<EntryRef>()
        for link in links where link.label == relation && activeSources.contains(link.source) && activeTargets.contains(link.target) {
            serving.insert(link.source)
            served.insert(link.target)
        }
        return Alignment(unaligned: sources.filter { !serving.contains($0) }, unserved: targets.filter { !served.contains($0) })
    }
}

/// Entries the alignment view surfaces for review.
public struct Alignment: Hashable, Sendable {
    public var unaligned: [EntryRef]
    public var unserved: [EntryRef]

    public init(unaligned: [EntryRef] = [], unserved: [EntryRef] = []) {
        self.unaligned = unaligned
        self.unserved = unserved
    }
}

extension HiveClient {
    /// Active projects, most recently touched first.
    public func projects() async throws -> [PatternEntry] {
        try await query(Portfolio.projects, sort: "-updated_at", limit: 500)
            .map { PatternEntry(pattern: Portfolio.projects, entry: $0) }
    }

    /// The alignment view's entries, fetched in full (for titles): every active
    /// entry of the relation's ends and its links, judged by `Portfolio.alignment`.
    public func alignment(_ relation: Relation, exempt: Set<EntryRef> = []) async throws -> (unaligned: [PatternEntry], unserved: [PatternEntry]) {
        func active(_ patterns: [String]) async throws -> [PatternEntry] {
            var out: [PatternEntry] = []
            for pattern in patterns {
                out += try await query(pattern, sort: "id", limit: 1000).map { PatternEntry(pattern: pattern, entry: $0) }
            }
            return out
        }
        let sources = try await active(relation.source)
        let targets = try await active(relation.target)
        let edges = try await links(label: relation.name)
        let judged = Portfolio.alignment(relation: relation.name, sources: sources.map(\.ref), targets: targets.map(\.ref), links: edges)
        let unaligned = Set(judged.unaligned), unserved = Set(judged.unserved)
        return (sources.filter { unaligned.contains($0.ref) && !exempt.contains($0.ref) }, targets.filter { unserved.contains($0.ref) && !exempt.contains($0.ref) })
    }

    /// The entries the owner exempts from alignment (charter `review_exempt`:
    /// "projects/8, goals/2").
    public func reviewExemptions() async throws -> Set<EntryRef> {
        let rows = try await query("_charter", filters: ["key=\(Portfolio.exemptKey)"], limit: 1)
        guard let raw = rows.first?.string("value") else { return [] }
        return Set(raw.split(separator: ",").compactMap { part in
            let bits = part.trimmingCharacters(in: .whitespaces).split(separator: "/", maxSplits: 1)
            guard bits.count == 2, let id = Int(bits[1]) else { return nil }
            return EntryRef(pattern: String(bits[0]), id: id)
        })
    }

    /// Active goals, in id order.
    public func goals() async throws -> [PatternEntry] {
        try await query(Portfolio.goals, sort: "id", limit: 100)
            .map { PatternEntry(pattern: Portfolio.goals, entry: $0) }
    }

    /// The goals a project `serves`.
    public func goalsServed(by project: EntryRef) async throws -> [EntryRef] {
        try await links(source: project, label: Portfolio.serves).map(\.target)
    }

    /// The projects that `serve` a goal.
    public func projectsServing(_ goal: EntryRef) async throws -> [EntryRef] {
        try await links(targetPattern: goal.pattern, targetID: goal.id, label: Portfolio.serves).map(\.source)
    }

    /// Open tasks across every project (for picking a day's commitments).
    public func openTasks(in schema: PatternSummary) async throws -> [PatternEntry] {
        try await query(schema.name, sort: "-updated_at", limit: 500)
            .map { PatternEntry(pattern: schema.name, entry: $0) }
            .filter { !Portfolio.isClosed($0, schema: schema) }
    }

    /// Move a task to another project: the old `belongs-to` link is archived and
    /// the new one written in one batch, so the required relation never lapses.
    public func move(_ task: PatternEntry, from old: PatternEntry, to new: PatternEntry) async throws {
        try await batch([
            ["pattern": "unlink", "data": .object(["source": .string(task.ref.description), "target": .string(old.ref.description), "label": .string(Portfolio.belongsTo)])],
            ["pattern": "link", "data": .object(["source": .string(task.ref.description), "target": .string(new.ref.description), "label": .string(Portfolio.belongsTo)])],
        ])
    }

    /// Every entry that `belongs-to` the project, whatever pattern it lives in.
    public func tasks(for project: EntryRef) async throws -> [PatternEntry] {
        let links = try await links(targetPattern: project.pattern, targetID: project.id, label: Portfolio.belongsTo)
        let byPattern = Dictionary(grouping: links.map(\.source), by: \.pattern)
        return try await withThrowingTaskGroup(of: [PatternEntry].self) { group in
            for (pattern, refs) in byPattern {
                group.addTask {
                    try await self.entries(pattern, ids: refs.map(\.id)).map { PatternEntry(pattern: pattern, entry: $0) }
                }
            }
            return try await group.reduce(into: []) { $0 += $1 }
        }
    }

    /// Create a task in `schema`'s pattern, born with its `belongs-to` link to the
    /// project in one write (`_relate`): if the link is refused, so is the task.
    /// Only facets the pattern declares are sent, so the retired `project` text
    /// echo is written only while the pattern still has it.
    public func createTask(in project: PatternEntry, title: String, context: String?, deadline: String? = nil, schema: PatternSummary, also: [String: [EntryRef]] = [:]) async throws -> PatternEntry {
        var data: [String: JSONValue] = ["title": .string(title)]
        if schema.facet("project") != nil {
            data["project"] = .string(project.entry.string("slug") ?? project.entry.string("title") ?? "")
        }
        // A new task starts in the pattern's first open status (its default when
        // it declares one), never a value this client spelled.
        if let status = schema.facet("status"), status.defaultValue == nil {
            let closed = Set(status.closed ?? [])
            if let first = status.options?.first(where: { !closed.contains($0) }) { data["status"] = .string(first) }
        }
        if let context, !context.isEmpty, schema.facet("context") != nil { data["context"] = .string(context) }
        if let deadline, !deadline.isEmpty, schema.facet("deadline") != nil { data["deadline"] = .string(deadline) }
        var relate = also
        relate[Portfolio.belongsTo] = [project.ref]
        let created = try await mutate(schema.name, .create, data, relate: relate)
        guard let entry = created.entry else { throw HiveError.decoding("create returned no entry") }
        return PatternEntry(pattern: schema.name, entry: entry)
    }

    /// Update facets of an entry under optimistic locking.
    public func update(_ item: PatternEntry, _ changes: [String: JSONValue]) async throws -> PatternEntry {
        var data = changes
        data["id"] = .number(Double(item.entry.id))
        if let v = item.entry.version { data["version"] = .number(Double(v)) }
        let result = try await mutate(item.pattern, .update, data)
        return PatternEntry(pattern: item.pattern, entry: result.entry ?? item.entry)
    }
}
