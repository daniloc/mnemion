import MnemionKit
import SwiftUI

/// The signed-in view of the hive's projects and their tasks. A read-through
/// cache, not a replica: the hive stays the single source of truth, every write
/// goes straight to it, and the `/ws` stream keeps what's on screen current with
/// writes from any other surface (web, agents, another device).
@MainActor @Observable
final class PortfolioStore {
    let client: HiveClient
    let credentials: Credentials

    private(set) var projects: [PatternEntry] = []
    private(set) var tasks: [EntryRef: [PatternEntry]] = [:]
    private(set) var taskStatuses: [String] = ["open", "done"]
    /// The pattern new tasks go in, read off the relation registry (`belongs-to`).
    private(set) var taskSchema: PatternSummary?
    /// The weekly review's alignment read (`serves`): nil when the hive declares
    /// no such relation. Derived from the links on every load, never cached across.
    private(set) var alignmentRelation: Relation?
    private(set) var unaligned: Set<EntryRef> = []
    private(set) var unservedGoals: [PatternEntry] = []
    var error: String?

    init(client: HiveClient, credentials: Credentials) {
        self.client = client
        self.credentials = credentials
    }

    var member: String { credentials.member ?? "owner" }
    var host: String { credentials.hiveURL.host() ?? credentials.hiveURL.absoluteString }

    func project(_ id: PatternEntry.ID?) -> PatternEntry? {
        projects.first { $0.id == id }
    }

    // MARK: Loading

    func loadProjects() async {
        await run { self.projects = try await self.client.projects() }
    }

    func loadTasks(for project: PatternEntry) async {
        await run {
            let loaded = try await self.client.tasks(for: project.ref)
            self.tasks[project.ref] = Self.sorted(loaded)
            self.learnStatuses(loaded)
        }
    }

    /// Learn the task pattern from the registry, and its declared status options
    /// (otherwise keep what's observed).
    func loadSchema() async {
        await run {
            let index = try await self.client.index()
            self.alignmentRelation = Portfolio.alignmentRelation(in: index)
            let schema = Portfolio.taskPattern(in: index)
            self.taskSchema = schema
            if let options = schema?.facet("status")?.options, !options.isEmpty {
                self.taskStatuses = options
            }
        }
    }

    /// Projects serving no goal and goals nothing serves.
    func loadAlignment() async {
        guard let relation = alignmentRelation else {
            unaligned = []
            unservedGoals = []
            return
        }
        await run {
            let view = try await self.client.alignment(relation)
            self.unaligned = Set(view.unaligned.map(\.ref))
            self.unservedGoals = view.unserved
        }
    }

    // MARK: Writes

    func setStatus(_ task: PatternEntry, to status: String) async {
        await run { self.replace(try await self.client.update(task, ["status": .string(status)])) }
    }

    /// Saves edits; on a version conflict reloads the latest so the user sees what changed.
    func save(_ task: PatternEntry, changes: [String: JSONValue], in project: PatternEntry) async -> Bool {
        do {
            replace(try await client.update(task, changes))
            return true
        } catch let e as HiveError where e.isVersionConflict {
            error = "Someone else changed this task first. Reloaded the latest version."
            await loadTasks(for: project)
            return false
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    func createTask(in project: PatternEntry, title: String, context: String) async -> Bool {
        if taskSchema == nil { await loadSchema() }
        guard let schema = taskSchema else {
            error = error ?? "This hive declares no \(Portfolio.belongsTo) relation to \(Portfolio.projects), so there's nowhere to create a task."
            return false
        }
        do {
            let task = try await client.createTask(in: project, title: title, context: context, schema: schema)
            tasks[project.ref] = Self.sorted((tasks[project.ref] ?? []).filter { $0.ref != task.ref } + [task])
            return true
        } catch {
            self.error = error.localizedDescription
            await loadTasks(for: project)
            return false
        }
    }

    // MARK: Live

    /// Consume the hive's change stream for the lifetime of the calling task.
    func listen() async {
        for await change in client.changes() {
            await apply(change)
        }
    }

    private func apply(_ change: HiveChange) async {
        if let delta = change.delta {
            switch delta.pattern {
            case Portfolio.projects:
                await loadProjects()
                await loadAlignment()
            case _ where alignmentRelation?.target.contains(delta.pattern) ?? false:
                await loadAlignment()
            case "_links":
                if delta.entry?["label"]?.stringValue == alignmentRelation?.name || delta.entry == nil { await loadAlignment() }
                // A new/removed belongs-to changes a project's task list.
                if let target = delta.entry?["target_id"]?.intValue,
                   let project = projects.first(where: { $0.entry.id == target }) {
                    await loadTasks(for: project)
                } else {
                    await reloadLoadedTasks()
                }
            case _ where delta.op == "create" && change.touches("_links"):
                // Born with its links (`_relate`): which project it joined isn't in
                // the delta, so refetch the lists on screen.
                await reloadLoadedTasks()
            default:
                if let entry = delta.entry, delta.op != "archive" {
                    replace(PatternEntry(pattern: delta.pattern, entry: entry))
                } else if let id = delta.id {
                    remove(EntryRef(pattern: delta.pattern, id: id))
                }
            }
            return
        }
        // Coarse event (batch, schema change, ingress): refetch what it touched.
        if change.touches(Portfolio.projects) { await loadProjects() }
        if change.touches("_schema") || change.touches("_relations") { await loadSchema() }
        if let rel = alignmentRelation, change.patterns.contains(where: { $0 == "_links" || rel.source.contains($0) || rel.target.contains($0) }) {
            await loadAlignment()
        }
        if change.patterns.contains(where: { $0 == "_links" || $0.contains("tasks") }) { await reloadLoadedTasks() }
    }

    private func reloadLoadedTasks() async {
        for project in projects where tasks[project.ref] != nil {
            await loadTasks(for: project)
        }
    }

    // MARK: Helpers

    private func replace(_ item: PatternEntry) {
        for (project, list) in tasks {
            if let i = list.firstIndex(where: { $0.ref == item.ref }) {
                var updated = list
                updated[i] = item
                tasks[project] = Self.sorted(updated)
            }
        }
        learnStatuses([item])
    }

    private func remove(_ ref: EntryRef) {
        for (project, list) in tasks where list.contains(where: { $0.ref == ref }) {
            tasks[project] = list.filter { $0.ref != ref }
        }
    }

    private func learnStatuses(_ items: [PatternEntry]) {
        for s in items.compactMap({ $0.entry.string("status") }) where !taskStatuses.contains(s) {
            taskStatuses.append(s)
        }
    }

    private static func sorted(_ items: [PatternEntry]) -> [PatternEntry] {
        items.sorted { ($0.entry.updatedAt ?? "") > ($1.entry.updatedAt ?? "") }
    }

    private func run(_ work: @escaping () async throws -> Void) async {
        do {
            try await work()
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            self.error = error.localizedDescription
        }
    }
}
