import MnemionKit
import SwiftUI

struct ProjectDetailView: View {
    let project: PatternEntry
    @Environment(PortfolioStore.self) private var store
    @State private var composing = false
    @State private var editing: PatternEntry?

    private var tasks: [PatternEntry] { store.tasks[project.ref] ?? [] }
    private var open: [PatternEntry] { tasks.filter { !isDone($0) } }
    private var done: [PatternEntry] { tasks.filter(isDone) }

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
        TaskRow(task: task, done: isDone(task)) {
            Task { await store.setStatus(task, to: isDone(task) ? "open" : "done") }
        }
        .contentShape(Rectangle())
        .onTapGesture { editing = task }
    }

    private func isDone(_ task: PatternEntry) -> Bool {
        ["done", "complete", "completed"].contains(task.entry.string("status")?.lowercased() ?? "")
    }
}

private struct ProjectHeader: View {
    let project: PatternEntry

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
    let toggle: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button(action: toggle) {
                Image(systemName: done ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(done ? Color.green : Color.secondary)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(done ? "Mark open" : "Mark done")

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
                    if let status = task.entry.string("status"), !done { StatusBadge(status: status) }
                    if task.pattern != store.taskSchema?.name {
                        Text(task.pattern).font(.caption2).foregroundStyle(.tertiary)
                    }
                    if let by = task.entry.updatedBy {
                        Text("by \(by)").font(.caption2).foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }
}
