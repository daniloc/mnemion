import MnemionKit
import SwiftUI

struct ProjectDetailView: View {
    let project: PatternEntry
    @Environment(PortfolioStore.self) private var store
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif
    @State private var composing = false
    @State private var editing: PatternEntry?
    @State private var showingDone = false
    @State private var showingFacts = false
    /// The facts in an inspector beside the work. Off by default on iOS: an
    /// iPad in portrait (or an unfolded phone) is regular width without room
    /// for a third column, so the inspector would cover the work.
    #if os(macOS)
    @AppStorage("projectFactsShown") private var factsShown = true
    #else
    @AppStorage("projectFactsShown") private var factsShown = false
    #endif

    private var title: String { project.entry.string("title") ?? "Project" }
    private var tasks: [PatternEntry] { store.tasks[project.ref] ?? [] }
    private var open: [PatternEntry] { tasks.filter { !store.isClosed($0) }.sorted(by: byDeadline) }
    private var done: [PatternEntry] { tasks.filter { store.isClosed($0) } }

    /// The size class, not a measured width, picks the layout: it changes with
    /// a rotation, a fold or a resized window, and never goes stale.
    private var regular: Bool {
        #if os(iOS)
        sizeClass == .regular
        #else
        true
        #endif
    }

    private var inspecting: Bool { regular && factsShown }

    var body: some View {
        List {
            Section {
                PageHeader(title: title, summary: summary)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            if !inspecting {
                // The page opens on the work: the facts wait behind a tap.
                Section {
                    DisclosureGroup(isExpanded: $showingFacts) {
                        ProjectFacts(project: project)
                    } label: {
                        ProjectSummary(project: project)
                    }
                }
            }
            Section {
                if open.isEmpty {
                    Button("Add a Task", systemImage: "plus") { composing = true }
                } else {
                    ForEach(open) { row($0) }
                }
            } header: {
                SectionHeader(title: "Open", count: open.count)
            }
            if !done.isEmpty {
                Section {
                    if showingDone { ForEach(done) { row($0) } }
                } header: {
                    Button {
                        withAnimation(.snappy(duration: 0.2)) { showingDone.toggle() }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .rotationEffect(.degrees(showingDone ? 90 : 0))
                            SectionHeader(title: "Done", count: done.count)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        #else
        .listStyle(.inset)
        #endif
        .headerProminence(.increased)
        .environment(\.pageIsCompact, !regular)
        .pageTitle(title)
        .inspector(isPresented: Binding(get: { inspecting }, set: { factsShown = $0 })) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    ProjectSummary(project: project)
                    ProjectFacts(project: project)
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .inspectorColumnWidth(min: 240, ideal: 300, max: 380)
        }
        .toolbar {
            #if !os(macOS)
            // The page's headline already names it.
            ToolbarItem(placement: .principal) { Text("") }
            #endif
            ToolbarItem(placement: .primaryAction) {
                Button("New Task", systemImage: "plus") { composing = true }
            }
            if regular {
                ToolbarItem(placement: .primaryAction) {
                    Button("About", systemImage: "info.circle") { factsShown.toggle() }
                }
            }
        }
        .refreshable { await store.loadTasks(for: project) }
        .task { await store.loadTasks(for: project) }
        .sheet(isPresented: $composing) {
            NewTaskSheet(project: project)
        }
        .sheet(item: $editing) { task in
            TaskEditor(task: task, project: project)
        }
    }

    private var summary: String {
        switch (open.count, done.count) {
        case (0, 0): return "No tasks yet."
        case (0, _): return "Nothing open."
        case (let o, 0): return "\(o) open."
        case (let o, let d): return "\(o) open, \(d) done."
        }
    }

    private func row(_ task: PatternEntry) -> some View {
        let schema = store.schema(for: task.pattern)
        let isDone = store.isClosed(task)
        // The pattern's declared statuses decide what a tap writes; with no
        // closed declaration there is nothing a tap could write, so no toggle.
        let next = Portfolio.toggledStatus(for: task, schema: schema)
        let status = task.entry.string("status")
        // Closings other than the one a tap writes, such as dropped.
        let otherClosings = (schema?.facet("status")?.closed ?? []).filter { $0 != next && $0 != status }
        return TaskRow(task: task, done: isDone, toggle: next.map { next in
            { Task { await store.setStatus(task, to: next) } }
        })
        .contentShape(Rectangle())
        .onTapGesture { editing = task }
        .swipeActions(edge: .leading) {
            if let next {
                Button(isDone ? "Reopen" : "Finish", systemImage: isDone ? "arrow.uturn.backward" : "checkmark") {
                    Task { await store.setStatus(task, to: next) }
                }
                .tint(isDone ? .blue : .green)
            }
        }
        .swipeActions(edge: .trailing) {
            ForEach(otherClosings, id: \.self) { closing in
                Button(closing.capitalized, systemImage: "xmark") {
                    Task { await store.setStatus(task, to: closing) }
                }
                .tint(.gray)
            }
        }
        .contextMenu {
            // Only statuses this entry's pattern declares; the worker refuses any other.
            ForEach(store.statuses(for: task.pattern).filter { $0 != status }, id: \.self) { option in
                Button(option.capitalized) { Task { await store.setStatus(task, to: option) } }
            }
            Divider()
            Button("Edit…", systemImage: "pencil") { editing = task }
        }
    }

    /// Dated first, soonest first; undated after, newest first.
    private func byDeadline(_ a: PatternEntry, _ b: PatternEntry) -> Bool {
        switch (a.entry.string("deadline"), b.entry.string("deadline")) {
        case let (x?, y?): return x < y
        case (_?, nil): return true
        case (nil, _?): return false
        default: return (a.entry.updatedAt ?? "") > (b.entry.updatedAt ?? "")
        }
    }
}

/// The project's state and horizon in a line: the label the facts fold under.
private struct ProjectSummary: View {
    let project: PatternEntry

    var body: some View {
        HStack(spacing: 8) {
            if let status = project.entry.string("status") { StatusBadge(status: status) }
            if let horizon = project.entry.string("horizon") {
                Text(horizon).font(.callout).foregroundStyle(.secondary)
            }
        }
    }
}

/// What the project intends and what it serves. These change rarely, so they
/// sit beside the work (an inspector) or fold above it (a phone).
private struct ProjectFacts: View {
    let project: PatternEntry
    @Environment(PortfolioStore.self) private var store

    private var served: [PatternEntry] {
        (store.projectGoals[project.ref] ?? []).compactMap(store.goal(ref:))
    }

    private var unserved: [PatternEntry] {
        let served = Set(served.map(\.ref))
        return store.goals.filter { !served.contains($0.ref) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) { details }
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var details: some View {
            if let intent = project.entry.string("intent") {
                LabeledText(label: "Intent", text: intent)
            }
            if let outcome = project.entry.string("outcome") {
                LabeledText(label: "Outcome", text: outcome)
            }
            VStack(alignment: .leading, spacing: 6) {
                GroupLabel("Serves")
                if store.isExempt(project) {
                    Text("Exempt from alignment by the charter: this project serves no goal by design.")
                        .font(.callout).foregroundStyle(.secondary)
                } else {
                    if served.isEmpty {
                        Label("No goal", systemImage: "exclamationmark.circle.fill")
                            .font(.callout)
                            .foregroundStyle(.orange)
                    }
                    ForEach(served) { goal in
                        Label(goal.entry.string("title") ?? "Goal", systemImage: "scope")
                            .font(.callout)
                    }
                    if !unserved.isEmpty {
                        Menu {
                            ForEach(unserved) { goal in
                                Button(goal.entry.string("title") ?? "Goal") {
                                    Task { await store.serve(project, goal: goal) }
                                }
                            }
                        } label: {
                            Label("Serve a goal", systemImage: "plus").font(.callout)
                        }
                        .menuStyle(.borderlessButton)
                        .menuIndicator(.hidden)
                        .fixedSize()
                        .padding(.top, 2)
                    }
                }
            }
    }
}

struct LabeledText: View {
    let label: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            GroupLabel(label)
            Text(text)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct TaskRow: View {
    @Environment(PortfolioStore.self) private var store
    let task: PatternEntry
    let done: Bool
    /// Nil when the pattern declares no closed statuses: nothing to write.
    let toggle: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Button(action: toggle ?? {}) {
                Image(systemName: done ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(done ? Color.green : Color.secondary)
            }
            .buttonStyle(.plain)
            .disabled(toggle == nil)
            .accessibilityLabel(done ? "Reopen" : "Finish")

            VStack(alignment: .leading, spacing: 4) {
                Text(task.entry.string("title") ?? "Untitled")
                    .strikethrough(done)
                    .foregroundStyle(done ? .secondary : .primary)
                if let context = task.entry.string("context") {
                    Text(context)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                HStack(spacing: 6) {
                    DeadlineLabel(deadline: task.entry.string("deadline"), closed: done)
                    if let status = task.entry.string("status"), status != store.taskSchema?.facet("status")?.options?.first { StatusBadge(status: status) }
                    if task.pattern != store.taskSchema?.name {
                        Text(task.pattern).font(.caption2).foregroundStyle(.tertiary)
                    }
                    if store.memberCount > 1, let by = task.entry.updatedBy {
                        Text("by \(by)").font(.caption2).foregroundStyle(.tertiary)
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }
}
