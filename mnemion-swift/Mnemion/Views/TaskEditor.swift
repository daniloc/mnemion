import MnemionKit
import SwiftUI

/// Edit an existing task. Saves only changed facets, with the entry's version
/// for optimistic locking — an agent or another device may have written since.
/// A project change is a move: unlink and link in one batch, so the required
/// `belongs-to` never lapses.
struct TaskEditor: View {
    let task: PatternEntry
    let project: PatternEntry
    @Environment(PortfolioStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var status: String
    @State private var context: String
    @State private var hasDeadline: Bool
    @State private var deadline: Date
    @State private var projectID: PatternEntry.ID
    @State private var saving = false

    init(task: PatternEntry, project: PatternEntry) {
        self.task = task
        self.project = project
        _title = State(initialValue: task.entry.string("title") ?? "")
        _status = State(initialValue: task.entry.string("status") ?? "")
        _context = State(initialValue: task.entry.string("context") ?? "")
        let d = Dates.date(task.entry.string("deadline"))
        _hasDeadline = State(initialValue: d != nil)
        _deadline = State(initialValue: d ?? .now)
        _projectID = State(initialValue: project.id)
    }

    private var deadlineString: String? { hasDeadline ? Dates.string(deadline) : nil }

    private var changes: [String: JSONValue] {
        var c: [String: JSONValue] = [:]
        if title != (task.entry.string("title") ?? "") { c["title"] = .string(title) }
        if status != (task.entry.string("status") ?? "") { c["status"] = .string(status) }
        if context != (task.entry.string("context") ?? "") { c["context"] = .string(context) }
        let stored = task.entry.string("deadline").map { String($0.prefix(10)) }
        if deadlineString != stored { c["deadline"] = deadlineString.map { .string($0) } ?? .null }
        return c
    }

    private var moved: Bool { projectID != project.id }

    var body: some View {
        NavigationStack {
            Form {
                Section("Title") {
                    TextField("Title", text: $title, axis: .vertical)
                }
                Section("Status") {
                    if statusOptions.count <= 4 {
                        Picker("Status", selection: $status) {
                            ForEach(statusOptions, id: \.self) { Text($0).tag($0) }
                        }
                        .pickerStyle(.segmented)
                    } else {
                        Picker("Status", selection: $status) {
                            ForEach(statusOptions, id: \.self) { Text($0).tag($0) }
                        }
                        .pickerStyle(.menu)
                    }
                }
                Section("Deadline") {
                    Toggle("Has a deadline", isOn: $hasDeadline)
                    if hasDeadline {
                        DatePicker("Due", selection: $deadline, displayedComponents: .date)
                    }
                }
                Section("Project") {
                    Picker("Project", selection: $projectID) {
                        ForEach(store.projects) { p in
                            Text(p.entry.string("title") ?? "Untitled").tag(p.id)
                        }
                    }
                }
                Section("Context") {
                    TextField("Enough for any agent to pick it up cold", text: $context, axis: .vertical)
                        .lineLimit(6...)
                }
                RelatedSection(item: task, text: [title, context].filter { !$0.isEmpty }.joined(separator: "\n"))
                Section {
                    LabeledContent("Entry", value: task.ref.description)
                    if store.memberCount > 1 {
                        if let by = task.entry.createdBy { LabeledContent("Created by", value: by) }
                        if let by = task.entry.updatedBy { LabeledContent("Last written by", value: by) }
                    }
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
                            var ok = true
                            if !changes.isEmpty { ok = await store.save(task, changes: changes, in: project) }
                            if ok, moved, let destination = store.project(projectID) {
                                ok = await store.move(task, from: project, to: destination)
                            }
                            saving = false
                            if ok { dismiss() }
                        }
                    }
                    .disabled((changes.isEmpty && !moved) || title.isEmpty || saving)
                }
            }
        }
        .sheetSize(minWidth: 480, minHeight: 560)
    }

    /// The pattern's statuses; an unknown stored value stays selectable, and an
    /// unset one reads as the first declared option.
    private var statusOptions: [String] {
        if status.isEmpty { return store.taskStatuses }
        return store.taskStatuses.contains(status) ? store.taskStatuses : store.taskStatuses + [status]
    }
}

struct NewTaskSheet: View {
    let project: PatternEntry
    @Environment(PortfolioStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var context = ""
    @State private var hasDeadline = false
    @State private var deadline = Date.now
    @State private var saving = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Title") {
                    TextField("What needs doing", text: $title, axis: .vertical)
                }
                Section("Deadline") {
                    Toggle("Has a deadline", isOn: $hasDeadline)
                    if hasDeadline {
                        DatePicker("Due", selection: $deadline, displayedComponents: .date)
                    }
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
                            if await store.createTask(in: project, title: title, context: context, deadline: hasDeadline ? Dates.string(deadline) : nil) { dismiss() }
                            saving = false
                        }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
        }
        .sheetSize(minWidth: 440, minHeight: 360)
    }
}
