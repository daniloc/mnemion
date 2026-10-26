import MnemionKit
import SwiftUI

/// Edit an existing task. Saves only changed facets, with the entry's version
/// for optimistic locking — an agent or another device may have written since.
struct TaskEditor: View {
    let task: PatternEntry
    let project: PatternEntry
    @Environment(PortfolioStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var status: String
    @State private var context: String
    @State private var saving = false

    init(task: PatternEntry, project: PatternEntry) {
        self.task = task
        self.project = project
        _title = State(initialValue: task.entry.string("title") ?? "")
        _status = State(initialValue: task.entry.string("status") ?? "open")
        _context = State(initialValue: task.entry.string("context") ?? "")
    }

    private var changes: [String: JSONValue] {
        var c: [String: JSONValue] = [:]
        if title != (task.entry.string("title") ?? "") { c["title"] = .string(title) }
        if status != (task.entry.string("status") ?? "") { c["status"] = .string(status) }
        if context != (task.entry.string("context") ?? "") { c["context"] = .string(context) }
        return c
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Title") {
                    TextField("Title", text: $title, axis: .vertical)
                }
                Section("Status") {
                    Picker("Status", selection: $status) {
                        ForEach(statusOptions, id: \.self) { Text($0).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
                Section("Context") {
                    TextField("Enough for any agent to pick it up cold", text: $context, axis: .vertical)
                        .lineLimit(6...)
                }
                Section {
                    LabeledContent("Entry", value: task.ref.description)
                    if let by = task.entry.createdBy { LabeledContent("Created by", value: by) }
                    if let by = task.entry.updatedBy { LabeledContent("Last written by", value: by) }
                    if let at = task.entry.updatedAt { LabeledContent("Updated", value: at) }
                    if let v = task.entry.version { LabeledContent("Version", value: String(v)) }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            .formStyle(.grouped)
            .navigationTitle("Task")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saving = true
                        Task {
                            if await store.save(task, changes: changes, in: project) { dismiss() }
                            saving = false
                        }
                    }
                    .disabled(changes.isEmpty || title.isEmpty || saving)
                }
            }
        }
    }

    private var statusOptions: [String] {
        store.taskStatuses.contains(status) ? store.taskStatuses : store.taskStatuses + [status]
    }
}

struct NewTaskSheet: View {
    let project: PatternEntry
    @Environment(PortfolioStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var context = ""
    @State private var saving = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Title") {
                    TextField("What needs doing", text: $title, axis: .vertical)
                }
                Section("Context") {
                    TextField("Enough for any agent to pick it up cold", text: $context, axis: .vertical)
                        .lineLimit(6...)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("New task")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        saving = true
                        Task {
                            if await store.createTask(in: project, title: title, context: context) { dismiss() }
                            saving = false
                        }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
        }
    }
}
