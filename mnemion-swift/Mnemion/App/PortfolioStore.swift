import MnemionKit
import SwiftUI

/// The signed-in view of the hive: the derived review, the inbox, goals, projects
/// and their tasks. A read-through cache, not a replica: the hive stays the
/// single source of truth, every write goes straight to it, and the `/ws`
/// stream keeps what's on screen current with writes from any other surface
/// (web, agents, another device).
@MainActor @Observable
final class PortfolioStore {
    let client: HiveClient
    let credentials: Credentials

    private(set) var projects: [PatternEntry] = []
    private(set) var tasks: [EntryRef: [PatternEntry]] = [:]
    /// The task pattern's declared statuses; empty until the schema loads, and
    /// never a value this client spelled.
    private(set) var taskStatuses: [String] = []
    /// The pattern new tasks go in, read off the relation registry (`belongs-to`).
    private(set) var taskSchema: PatternSummary?
    /// The hive's index, for any pattern's declared facets (statuses, closed, energy).
    private(set) var index: HiveIndex?

    /// A pattern's declared status options, from the index.
    func statuses(for pattern: String) -> [String] {
        index?.pattern(pattern)?.facet("status")?.options ?? []
    }

    func schema(for pattern: String) -> PatternSummary? { index?.pattern(pattern) }
    /// The weekly review's alignment read (`serves`): nil when the hive declares
    /// no such relation. Derived from the links on every load, never cached across.
    private(set) var alignmentRelation: Relation?
    private(set) var unaligned: Set<EntryRef> = []
    private(set) var unservedGoals: [PatternEntry] = []

    /// What needs attention now, as the worker derives it (`/api/review`).
    private(set) var review: Review?
    /// Open inbox notes, newest first.
    private(set) var notes: [PatternEntry] = []
    private(set) var goals: [PatternEntry] = []
    /// `serves` links, read both ways.
    private(set) var goalProjects: [EntryRef: [EntryRef]] = [:]
    private(set) var projectGoals: [EntryRef: [EntryRef]] = [:]
    /// How many people share the hive; attribution chips only matter past one.
    private(set) var memberCount = 1
    /// Entries the owner exempts from alignment (charter `review_exempt`).
    private(set) var exempt: Set<EntryRef> = []
    var error: String?

    func isExempt(_ item: PatternEntry) -> Bool { exempt.contains(item.ref) }

    /// Closed by the task pattern's declared terminal statuses.
    func isClosed(_ task: PatternEntry) -> Bool { Portfolio.isClosed(task, schema: taskSchema) }

    init(client: HiveClient, credentials: Credentials) {
        self.client = client
        self.credentials = credentials
    }

    var member: String { credentials.member ?? "owner" }
    var host: String { credentials.hiveURL.host() ?? credentials.hiveURL.absoluteString }

    func project(_ id: PatternEntry.ID?) -> PatternEntry? {
        projects.first { $0.id == id }
    }

    func project(ref: EntryRef) -> PatternEntry? {
        projects.first { $0.ref == ref }
    }

    func goal(ref: EntryRef) -> PatternEntry? {
        goals.first { $0.ref == ref }
    }

    /// Everything the first screen needs, in parallel.
    func loadAll() async {
        async let a: () = loadProjects()
        async let b: () = loadSchema()
        async let c: () = loadReview()
        async let d: () = loadInbox()
        async let e: () = loadGoals()
        async let f: () = loadMembers()
        async let g: () = loadExemptions()
        _ = await (a, b, c, d, e, f, g)
        await loadAlignment()
    }

    func loadExemptions() async {
        if let refs = try? await client.reviewExemptions() { exempt = refs }
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
            self.index = index
            self.alignmentRelation = Portfolio.alignmentRelation(in: index)
            let schema = Portfolio.taskPattern(in: index)
            self.taskSchema = schema
            self.taskStatuses = schema?.facet("status")?.options ?? []
        }
    }

    /// Projects serving no goal and goals nothing serves. The worker's review is
    /// the home of this judgement (closed and exempt entries already skipped);
    /// the client-side read is the fallback for a worker without it.
    func loadAlignment() async {
        if let review, !reviewUnavailable {
            let source = review.alignment.first { $0.relation == Portfolio.serves && $0.end == "source" }
            let target = review.alignment.first { $0.relation == Portfolio.serves && $0.end == "target" }
            unaligned = Set((source?.entries ?? []).map(\.ref))
            unservedGoals = (target?.entries ?? []).compactMap { goal(ref: $0.ref) }
            return
        }
        guard let relation = alignmentRelation else {
            unaligned = []
            unservedGoals = []
            return
        }
        await run {
            let view = try await self.client.alignment(relation, exempt: self.exempt)
            self.unaligned = Set(view.unaligned.map(\.ref))
            self.unservedGoals = view.unserved
        }
    }

    /// Nil review with `reviewUnavailable` set: the hive's worker predates
    /// `/api/review` (older deploy), which is not an error worth an alert.
    private(set) var reviewUnavailable = false

    private var reviewFetch: Task<Void, Never>?
    private var reviewAgain = false

    /// One fetch in flight at a time: a burst of changes (an agent writing a
    /// batch) coalesces into at most one more fetch after the current one, and
    /// a slow older response can never overwrite a newer review.
    func loadReview() async {
        if let running = reviewFetch {
            reviewAgain = true
            await running.value
            return
        }
        let task = Task { await self.fetchReview() }
        reviewFetch = task
        await task.value
        reviewFetch = nil
        if reviewAgain {
            reviewAgain = false
            await loadReview()
        }
    }

    private func fetchReview() async {
        do {
            review = try await client.review()
            reviewUnavailable = false
            await loadAlignment()
        } catch let e as HiveError {
            if case .http(let status, _) = e, status == 404 { reviewUnavailable = true } else { error = e.localizedDescription }
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            self.error = error.localizedDescription
        }
    }

    func loadInbox() async {
        await run { self.notes = try await self.client.notes() }
    }

    func loadGoals() async {
        await run {
            async let goals = self.client.goals()
            async let links = self.client.links(label: Portfolio.serves)
            self.goals = try await goals
            var byGoal: [EntryRef: [EntryRef]] = [:], byProject: [EntryRef: [EntryRef]] = [:]
            for link in try await links {
                byGoal[link.target, default: []].append(link.source)
                byProject[link.source, default: []].append(link.target)
            }
            self.goalProjects = byGoal
            self.projectGoals = byProject
        }
    }

    func loadMembers() async {
        // A kernel read; an older hive without the roster keeps the default.
        if let rows = try? await client.query("_members", filters: ["status=active"], limit: 50) {
            memberCount = max(rows.count, 1)
        }
    }

    /// Open tasks across every project (for a day's commitments).
    func openTasks() async -> [PatternEntry] {
        if taskSchema == nil { await loadSchema() }
        guard let schema = taskSchema else { return [] }
        return (try? await client.openTasks(in: schema)) ?? []
    }

    // MARK: Writes

    func setStatus(_ task: PatternEntry, to status: String) async {
        await run { self.replace(try await self.client.update(task, ["status": .string(status)])) }
        await loadReview()
    }

    /// Saves edits; on a version conflict reloads the latest so the user sees what changed.
    func save(_ task: PatternEntry, changes: [String: JSONValue], in project: PatternEntry) async -> Bool {
        do {
            replace(try await client.update(task, changes))
            await loadReview()
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

    /// Update an entry the review named (fetched fresh for its version).
    func update(_ ref: EntryRef, _ changes: [String: JSONValue]) async -> Bool {
        do {
            guard let current = try await client.entry(ref) else {
                error = "\(ref) is gone."
                return false
            }
            replace(try await client.update(current, changes))
            await loadReview()
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    func createTask(in project: PatternEntry, title: String, context: String, deadline: String? = nil) async -> Bool {
        if taskSchema == nil { await loadSchema() }
        guard let schema = taskSchema else {
            error = error ?? "This hive declares no \(Portfolio.belongsTo) relation to \(Portfolio.projects), so there's nowhere to create a task."
            return false
        }
        do {
            let task = try await client.createTask(in: project, title: title, context: context, deadline: deadline, schema: schema)
            tasks[project.ref] = Self.sorted((tasks[project.ref] ?? []).filter { $0.ref != task.ref } + [task])
            await loadReview()
            return true
        } catch {
            self.error = error.localizedDescription
            await loadTasks(for: project)
            return false
        }
    }

    func move(_ task: PatternEntry, from old: PatternEntry, to new: PatternEntry) async -> Bool {
        do {
            try await client.move(task, from: old, to: new)
            await loadTasks(for: old)
            await loadTasks(for: new)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    /// Link a project to a goal it serves.
    func serve(_ project: PatternEntry, goal: PatternEntry) async {
        await run { try await self.client.link(project.ref, to: goal.ref, label: Portfolio.serves) }
        await loadGoals()
        await loadAlignment()
        await loadReview()
    }

    // MARK: Inbox

    @discardableResult
    func capture(_ body: String, url: String? = nil) async -> PatternEntry? {
        do {
            let note = try await client.capture(body, url: url)
            notes.insert(note, at: 0)
            return note
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }

    /// The nearest entries to some text, by meaning, excluding the entry itself.
    func related(to text: String, excluding: EntryRef? = nil, limit: Int = 6) async -> [PrimeHit] {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        let hits = (try? await client.prime(text, limit: limit + 1)) ?? []
        return Array(hits.filter { $0.ref != excluding }.prefix(limit))
    }

    func connect(_ source: EntryRef, to target: EntryRef, as relation: String = Inbox.references) async -> Bool {
        do {
            try await client.connect(source, to: target, as: relation)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    func triage(_ note: PatternEntry, _ status: Inbox.Status) async {
        await run {
            _ = try await self.client.triage(note, status)
            self.notes.removeAll { $0.ref == note.ref }
        }
        await loadReview()
    }

    /// Attach a note to a project and mark it triaged.
    func attach(_ note: PatternEntry, to target: EntryRef) async {
        guard await connect(note.ref, to: target) else { return }
        await triage(note, .triaged)
    }

    func makeTask(from note: PatternEntry, in project: PatternEntry, title: String, context: String) async -> Bool {
        if taskSchema == nil { await loadSchema() }
        guard let schema = taskSchema else {
            error = "This hive declares no task pattern."
            return false
        }
        do {
            let task = try await client.makeTask(from: note, in: project, title: title, context: context, schema: schema)
            tasks[project.ref] = Self.sorted((tasks[project.ref] ?? []).filter { $0.ref != task.ref } + [task])
            notes.removeAll { $0.ref == note.ref }
            await loadReview()
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    // MARK: Reviews

    func recordReview(hook: ReviewHook, period: String, text: String, energy: String?, commits: [EntryRef], reflectsOn: EntryRef?) async -> Bool {
        guard let pattern = review?.hooks.pattern else {
            error = "This hive has no reviews pattern yet. Ask an agent to declare it (mnemion://review carries the spec)."
            return false
        }
        // Only facets the reviews pattern declares are written.
        let supportsEnergy = schema(for: pattern)?.facet("energy") != nil
        do {
            _ = try await client.recordReview(in: pattern, hook: hook, period: period, text: text, energy: supportsEnergy ? energy : nil, commits: commits, reflectsOn: reflectsOn)
            await loadReview()
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    /// The start review an end hook answers, when one covers the same period.
    func startReview(for hook: ReviewHook) async -> PatternEntry? {
        guard !hook.isStart, let review, let pattern = review.hooks.pattern,
              let status = review.status(of: hook.counterpart), let last = status.last,
              last.period == status.period else { return nil }
        return try? await client.entry(EntryRef(pattern: pattern, id: last.id))
    }

    // MARK: Live

    /// Consume the hive's change stream for the lifetime of the calling task.
    func listen() async {
        for await change in client.changes() {
            await apply(change)
        }
    }

    private func apply(_ change: HiveChange) async {
        defer { Task { await self.loadReview() } }
        if let delta = change.delta {
            switch delta.pattern {
            case Portfolio.projects:
                await loadProjects()
                await loadAlignment()
            case Inbox.pattern:
                await loadInbox()
            case Portfolio.goals:
                await loadGoals()
                await loadAlignment()
            case _ where alignmentRelation?.target.contains(delta.pattern) ?? false:
                await loadAlignment()
            case "_links":
                let label = delta.entry?["label"]?.stringValue
                if label == alignmentRelation?.name || delta.entry == nil { await loadAlignment() }
                if label == Portfolio.serves || delta.entry == nil { await loadGoals() }
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
        if change.touches(Inbox.pattern) { await loadInbox() }
        if change.touches(Portfolio.goals) || change.touches("_links") { await loadGoals() }
        if change.touches("_schema") || change.touches("_relations") { await loadSchema() }
        if change.touches("_charter") { await loadExemptions() }
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
        if item.pattern == Inbox.pattern, let i = notes.firstIndex(where: { $0.ref == item.ref }) {
            if item.entry.string("status") == Inbox.Status.open.rawValue { notes[i] = item } else { notes.remove(at: i) }
        }
        learnStatuses([item])
    }

    private func remove(_ ref: EntryRef) {
        for (project, list) in tasks where list.contains(where: { $0.ref == ref }) {
            tasks[project] = list.filter { $0.ref != ref }
        }
        notes.removeAll { $0.ref == ref }
    }

    /// Statuses are the schema's; a stored value outside it stays visible in the
    /// editor (TaskEditor appends it) but is never offered as a choice.
    private func learnStatuses(_ items: [PatternEntry]) {}

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
