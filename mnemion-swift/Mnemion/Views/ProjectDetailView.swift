import MnemionKit
import SwiftUI

struct ProjectDetailView: View {
    let project: PatternEntry
    @Environment(PortfolioStore.self) private var store
    @State private var composing = false
    @State private var editing: PatternEntry?
    @State private var showingDone = false
    @State private var width: CGFloat = 1000

    private var title: String { project.entry.string("title") ?? "Project" }
    private var tasks: [PatternEntry] { store.tasks[project.ref] ?? [] }
    private var open: [PatternEntry] { tasks.filter { !store.isClosed($0) }.sorted(by: byDeadline) }
    private var done: [PatternEntry] { tasks.filter { store.isClosed($0) } }

    var body: some View {
        Page(width: $width) {
            PageHeader(title: title, summary: summary)
            PageColumns(width: width) {
                taskColumn
            } rail: {
                ProjectFacts(project: project)
            }
        }
        .navigationTitle(title)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("New Task", systemImage: "plus") { composing = true }
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

    private var taskColumn: some View {
        VStack(alignment: .leading, spacing: 32) {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "Open", count: open.count)
                if open.isEmpty {
                    Button("Add a Task", systemImage: "plus") { composing = true }
                } else {
                    rows(open)
                }
            }
            if !done.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
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
                    if showingDone { rows(done) }
                }
            }
        }
    }

    private func rows(_ items: [PatternEntry]) -> some View {
        VStack(spacing: 0) {
            DividedRows(items: items, id: \.id) { row($0) }
        }
        .card()
    }

    private func row(_ task: PatternEntry) -> some View {
        // The pattern's declared statuses decide what a tap writes; with no
        // closed declaration there is nothing a tap could write, so no toggle.
        TaskRow(task: task, done: store.isClosed(task), toggle: Portfolio.toggledStatus(for: task, schema: store.schema(for: task.pattern)).map { next in
            { Task { await store.setStatus(task, to: next) } }
        })
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .modifier(RowHover())
        .onTapGesture { editing = task }
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

/// What the project is: its state, what it intends, and what it serves. These
/// change rarely, so they sit beside the work rather than above it.
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
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 8) {
                if let status = project.entry.string("status") { StatusBadge(status: status) }
                if let horizon = project.entry.string("horizon") {
                    Text(horizon).font(.callout).foregroundStyle(.secondary)
                }
            }
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
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
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
