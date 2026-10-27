import MnemionKit
import SwiftUI

struct ProjectDetailView: View {
    let project: PatternEntry
    @Environment(PortfolioStore.self) private var store
    @State private var composing = false
    @State private var editing: PatternEntry?

    private var tasks: [PatternEntry] { store.tasks[project.ref] ?? [] }
    private var open: [PatternEntry] { tasks.filter { !store.isClosed($0) }.sorted(by: byDeadline) }
    private var done: [PatternEntry] { tasks.filter { store.isClosed($0) } }

    var body: some View {
        List {
            Section {
                ProjectHeader(project: project)
            }
            Section("Open · \(open.count)") {
                ForEach(open) { row($0) }
            }
            if !done.isEmpty {
                Section("Done · \(done.count)") {
                    ForEach(done) { row($0) }
                }
            }
        }
        .navigationTitle(project.entry.string("title") ?? "Project")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("New task", systemImage: "plus") { composing = true }
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

    private func row(_ task: PatternEntry) -> some View {
        // The pattern's declared statuses decide what a tap writes; with no
        // closed declaration there is nothing a tap could write, so no toggle.
        TaskRow(task: task, done: store.isClosed(task), toggle: Portfolio.toggledStatus(for: task, schema: store.schema(for: task.pattern)).map { next in
            { Task { await store.setStatus(task, to: next) } }
        })
        .contentShape(Rectangle())
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

private struct ProjectHeader: View {
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
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                if let status = project.entry.string("status") { StatusBadge(status: status) }
                if let horizon = project.entry.string("horizon") {
                    Text(horizon).font(.caption).foregroundStyle(.secondary)
                }
            }
            if let intent = project.entry.string("intent") {
                LabeledText(label: "Intent", text: intent)
            }
            if let outcome = project.entry.string("outcome") {
                LabeledText(label: "Outcome", text: outcome)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Serves").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                if store.isExempt(project) {
                    Text("Exempt from alignment by the charter: this project serves no goal by design.")
                        .font(.callout).foregroundStyle(.secondary)
                } else {
                    HStack(spacing: 6) {
                        ForEach(served) { goal in
                            Text(goal.entry.string("title") ?? "Goal")
                                .font(.caption)
                                .padding(.horizontal, 8).padding(.vertical, 3)
                                .background(.quaternary, in: Capsule())
                        }
                        if served.isEmpty {
                            Label("No goal", systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.orange)
                        }
                        if !unserved.isEmpty {
                            Menu {
                                ForEach(unserved) { goal in
                                    Button(goal.entry.string("title") ?? "Goal") {
                                        Task { await store.serve(project, goal: goal) }
                                    }
                                }
                            } label: {
                                Label("Add", systemImage: "plus.circle").font(.caption)
                            }
                            .menuStyle(.borderlessButton)
                            .fixedSize()
                        }
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

struct LabeledText: View {
    let label: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption.weight(.medium)).foregroundStyle(.secondary)
            Text(text).font(.callout)
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
        HStack(alignment: .top, spacing: 12) {
            Button(action: toggle ?? {}) {
                Image(systemName: done ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(done ? Color.green : Color.secondary)
            }
            .buttonStyle(.borderless)
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
        }
        .padding(.vertical, 2)
    }
}
