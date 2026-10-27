import MnemionKit
import SwiftUI

/// Open notes, newest first, with the three triage moves: make a task (the
/// task is born `derived-from` the note), attach to a project, or drop. The
/// note itself stays as the record whichever way it goes.
struct InboxView: View {
    @Environment(PortfolioStore.self) private var store
    @Environment(AppState.self) private var app
    @State private var makingTask: PatternEntry?

    var body: some View {
        List {
            if store.notes.isEmpty {
                ContentUnavailableView("Inbox is empty", systemImage: "tray",
                    description: Text("Capture a note with ⌘N, or from the menu bar."))
            }
            ForEach(store.notes) { note in
                NoteRow(note: note) { makingTask = note }
            }
        }
        .navigationTitle("Inbox")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("New note", systemImage: "square.and.pencil") { app.showCapture = true }
            }
        }
        .refreshable { await store.loadInbox() }
        .sheet(item: $makingTask) { note in
            MakeTaskSheet(note: note)
        }
    }
}

private struct NoteRow: View {
    let note: PatternEntry
    let makeTask: () -> Void
    @Environment(PortfolioStore.self) private var store
    @State private var showRelated = false
    @State private var related: [PrimeHit] = []
    @State private var linked: Set<EntryRef> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(note.entry.string("body") ?? "")
                        .lineLimit(showRelated ? nil : 4)
                    if let url = note.entry.string("url"), let link = URL(string: url) {
                        Link(destination: link) {
                            Label(link.host() ?? url, systemImage: "link").font(.caption)
                        }
                    }
                    HStack(spacing: 6) {
                        if let source = note.entry.string("source") {
                            Text(source).font(.caption2).foregroundStyle(.tertiary)
                        }
                        if let at = note.entry.createdAt {
                            Text(at.prefix(10)).font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                }
                Spacer()
                Menu {
                    Button("Make a task…", systemImage: "checkmark.circle", action: makeTask)
                    Menu("Attach to project", systemImage: "folder") {
                        ForEach(store.projects) { project in
                            Button(project.entry.string("title") ?? "Untitled") {
                                Task { await store.attach(note, to: project.ref) }
                            }
                        }
                    }
                    Button(showRelated ? "Hide related" : "Show related", systemImage: "sparkles") {
                        showRelated.toggle()
                        if showRelated && related.isEmpty {
                            Task { related = await store.related(to: note.entry.string("body") ?? "", excluding: note.ref) }
                        }
                    }
                    Divider()
                    Button("Drop", systemImage: "xmark.circle", role: .destructive) {
                        Task { await store.triage(note, .dropped) }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }
            if showRelated {
                if related.isEmpty {
                    Text("Nothing nearby in the hive.").font(.caption).foregroundStyle(.secondary)
                } else {
                    RelatedList(hits: related, linked: linked) { hit in
                        Task { if await store.connect(note.ref, to: hit.ref) { linked.insert(hit.ref) } }
                    }
                    .padding(.leading, 4)
                }
            }
        }
        .padding(.vertical, 3)
    }
}

/// Triage a note into a task: pick the project, keep the note's words as the
/// title and context, optionally set a deadline.
private struct MakeTaskSheet: View {
    let note: PatternEntry
    @Environment(PortfolioStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var context: String
    @State private var project: PatternEntry.ID?
    @State private var saving = false

    init(note: PatternEntry) {
        self.note = note
        let body = note.entry.string("body") ?? ""
        let firstLine = body.split(whereSeparator: \.isNewline).first.map(String.init) ?? body
        _title = State(initialValue: String(firstLine.prefix(120)))
        _context = State(initialValue: body)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Project") {
                    Picker("Project", selection: $project) {
                        Text("Choose…").tag(PatternEntry.ID?.none)
                        ForEach(store.projects) { p in
                            Text(p.entry.string("title") ?? "Untitled").tag(PatternEntry.ID?.some(p.id))
                        }
                    }
                }
                Section("Title") {
                    TextField("Title", text: $title, axis: .vertical)
                }
                Section("Context") {
                    TextField("Enough for any agent to pick it up cold", text: $context, axis: .vertical)
                        .lineLimit(4...)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Make a task")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        guard let p = store.project(project) else { return }
                        saving = true
                        Task {
                            if await store.makeTask(from: note, in: p, title: title, context: context) { dismiss() }
                            saving = false
                        }
                    }
                    .disabled(saving || project == nil || title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .sheetSize(minWidth: 440, minHeight: 380)
    }
}
