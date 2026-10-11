import Foundation

/// The hive's project vocabulary, as the `projects` doctrine defines it: tasks
/// (from either task pattern) connect to a project through a `belongs-to` link,
/// projects to goals through `serves`. The link graph is the source of truth;
/// the `project` text facet on project-tasks is a human-readable echo.
public enum Portfolio {
    public static let projects = "projects"
    public static let projectTasks = "project-tasks"
    public static let belongsTo = "belongs-to"
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

    /// Create a project-task and link it to its project.
    ///
    /// Two writes, not one: `/api/mutate` takes a single op and a batch can't
    /// reference an id it creates. If the link fails the task still exists,
    /// carrying the project slug, and the error says so.
    public func createTask(in project: PatternEntry, title: String, context: String?) async throws -> PatternEntry {
        var data: [String: JSONValue] = [
            "title": .string(title),
            "project": .string(project.entry.string("slug") ?? project.entry.string("title") ?? ""),
            "status": "open",
        ]
        if let context, !context.isEmpty { data["context"] = .string(context) }
        let created = try await mutate(Portfolio.projectTasks, .create, data)
        guard let entry = created.entry else { throw HiveError.decoding("create returned no entry") }
        let task = PatternEntry(pattern: Portfolio.projectTasks, entry: entry)
        do {
            try await link(task.ref, to: project.ref, label: Portfolio.belongsTo)
        } catch {
            throw HiveError.hive("Created \(task.ref) but couldn't link it to \(project.ref): \(error.localizedDescription)")
        }
        return task
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
