import Foundation

/// The hive's project vocabulary, as the `projects` doctrine defines it: tasks
/// connect to a project through a `belongs-to` link, projects to goals through
/// `serves`. The link graph is the source of truth. Which pattern holds tasks is
/// read off the relation registry (the sources of `belongs-to`), not assumed:
/// `project-tasks` today, `tasks` once the two merge.
public enum Portfolio {
    public static let projects = "projects"
    public static let projectTasks = "project-tasks"
    public static let tasks = "tasks"
    public static let belongsTo = "belongs-to"

    /// Preferred task patterns when `belongs-to` admits several: the dedicated
    /// project-task pattern while it exists, then the merged `tasks`.
    static let taskPatternPreference = [projectTasks, tasks]

    /// The pattern new tasks are created in: an existing source pattern of
    /// `belongs-to` (to projects), by preference. Nil when the hive has no such
    /// relation or none of its sources exist.
    public static func taskPattern(in index: HiveIndex) -> PatternSummary? {
        guard let rel = index.relation(belongsTo), !rel.derived, rel.admitsTarget(projects) else { return nil }
        let candidates = rel.source.contains("*")
            ? index.patterns.filter { taskPatternPreference.contains($0.name) }
            : rel.source.compactMap(index.pattern)
        return candidates.min { rank($0.name) < rank($1.name) }
    }

    private static func rank(_ pattern: String) -> Int {
        taskPatternPreference.firstIndex(of: pattern) ?? taskPatternPreference.count
    }
}

extension HiveClient {
    /// Active projects, most recently touched first.
    public func projects() async throws -> [PatternEntry] {
        try await query(Portfolio.projects, sort: "-updated_at", limit: 500)
            .map { PatternEntry(pattern: Portfolio.projects, entry: $0) }
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
