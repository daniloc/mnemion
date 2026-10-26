import Foundation

/// The hive's project vocabulary, as the `projects` doctrine defines it: tasks
/// connect to a project through a `belongs-to` link, projects to goals through
/// `serves`. The link graph is the source of truth. Which pattern holds tasks is
/// read off the relation registry (the sources of `belongs-to`), not assumed.
public enum Portfolio {
    public static let projects = "projects"
    public static let tasks = "tasks"
    public static let belongsTo = "belongs-to"
    public static let serves = "serves"

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
    public func alignment(_ relation: Relation) async throws -> (unaligned: [PatternEntry], unserved: [PatternEntry]) {
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
        return (sources.filter { unaligned.contains($0.ref) }, targets.filter { unserved.contains($0.ref) })
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
    public func createTask(in project: PatternEntry, title: String, context: String?, schema: PatternSummary) async throws -> PatternEntry {
        var data: [String: JSONValue] = ["title": .string(title)]
        if schema.facet("project") != nil {
            data["project"] = .string(project.entry.string("slug") ?? project.entry.string("title") ?? "")
        }
        if let status = schema.facet("status"), status.options?.contains("open") ?? true {
            data["status"] = "open"
        }
        if let context, !context.isEmpty, schema.facet("context") != nil { data["context"] = .string(context) }
        let created = try await mutate(schema.name, .create, data, relate: [Portfolio.belongsTo: [project.ref]])
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
