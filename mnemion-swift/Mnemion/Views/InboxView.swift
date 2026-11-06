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
        Group {
            if store.notes.isEmpty {
                ContentUnavailableView {
                    Label("Inbox Zero", systemImage: "tray")
                } description: {
                    Text(emptyHint)
                } actions: {
                    Button("New Note") { app.showCapture = true }
                }
            } else {
                List {
                    Section {
                        PageHeader(title: store.notes.count == 1 ? "1 note" : "\(store.notes.count) notes",
                                   summary: "Waiting for triage, newest first.")
                            .listRowBackground(Color.clear)
                    }
                    // A section per note: the note, what it relates to, and its moves.
                    ForEach(store.notes) { note in
                        NoteSection(note: note) { makingTask = note }
                    }
                }
                #if os(iOS)
                .listStyle(.insetGrouped)
                #else
                .listStyle(.inset)
                #endif
                .listSectionSpacing(.compact)
            }
        }
        .pageTitle("Inbox")
        #if !os(macOS)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("New Note", systemImage: "square.and.pencil") { app.showCapture = true }
            }
        }
        #endif
        .refreshable { await store.loadInbox() }
        .sheet(item: $makingTask) { note in
            MakeTaskSheet(note: note)
        }
    }
}

#if os(macOS)
private let emptyHint = "Capture with ⌘N here, \(QuickCapture.shortcut) from any app, or from the menu bar."
#else
private let emptyHint = "Capture a note here, or share a link from any app."
#endif

/// A note and its moves. Triage is what this screen is for, so they stay in
/// view, and the two main ones are a swipe away as well.
private struct NoteSection: View {
    let note: PatternEntry
    let makeTask: () -> Void
    @Environment(PortfolioStore.self) private var store
    @State private var showRelated = false
    @State private var related: [PrimeHit] = []
    @State private var linked: Set<EntryRef> = []
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text(note.entry.string("body") ?? "")
                    .font(.system(size: 15))
                    .lineLimit(showRelated ? nil : 6)
                    .textSelection(.enabled)
                if let url = note.entry.string("url"), let link = URL(string: url) {
                    Link(destination: link) {
                        Label(link.host() ?? url, systemImage: "link").font(.callout)
                    }
                }
                HStack(spacing: 6) {
                    if let at = Dates.instant(note.entry.createdAt) {
                        Text(at, format: .relative(presentation: .named))
                    }
                    if let source = note.entry.string("source") {
                        Text("·")
                        Text(source)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
            .swipeActions(edge: .leading) {
                Button("Make Task", systemImage: "checkmark.circle", action: makeTask).tint(.accentColor)
            }
            .swipeActions(edge: .trailing) {
                Button("Drop", systemImage: "xmark", role: .destructive) { drop() }
            }

            if showRelated {
                VStack(alignment: .leading, spacing: 6) {
                    GroupLabel("Related")
                    if related.isEmpty {
                        Text("Nothing nearby in the hive.").font(.callout).foregroundStyle(.secondary)
                    } else {
                        RelatedList(hits: related, linked: linked) { hit in
                            Task { if await store.connect(note.ref, to: hit.ref) { linked.insert(hit.ref) } }
                        }
                    }
                }
            }

            moves
        }
    }

    /// A phone keeps the main move in words; the others fit as icons.
    private var iconsOnly: Bool {
        #if os(iOS)
        sizeClass == .compact
        #else
        false
        #endif
    }

    private var attach: some View {
        Menu("Attach", systemImage: "folder") {
            ForEach(store.projects) { project in
                Button(project.entry.string("title") ?? "Untitled") {
                    Task { await store.attach(note, to: project.ref) }
                }
            }
        }
        .menuIndicator(.hidden)
    }

    private var moves: some View {
        HStack(spacing: 6) {
            Button("Make Task", systemImage: "checkmark.circle", action: makeTask)
                .layoutPriority(1)
            if iconsOnly { attach.labelStyle(.iconOnly) } else { attach }
            Button(showRelated ? "Hide Related" : "Related", systemImage: "sparkles") {
                showRelated.toggle()
                if showRelated && related.isEmpty {
                    Task { related = await store.related(to: note.entry.string("body") ?? "", excluding: note.ref) }
                }
            }
            .labelStyle(TightLabelStyle(iconOnly: iconsOnly))
            Spacer(minLength: 0)
            Button("Drop", systemImage: "xmark", role: .destructive) { drop() }
                .labelStyle(TightLabelStyle(iconOnly: iconsOnly))
        }
        .lineLimit(1)
        // A list row sets labels in its own icon column; these are buttons.
        .labelStyle(.titleAndIcon)
        .controlSize(.small)
        .buttonStyle(.bordered)
    }

    private func drop() {
        Task { await store.triage(note, .dropped) }
    }
}

/// A label as words and icon, or the icon alone where width is short.
private struct TightLabelStyle: LabelStyle {
    let iconOnly: Bool

    func makeBody(configuration: Configuration) -> some View {
        if iconOnly { IconOnlyLabelStyle().makeBody(configuration: configuration) }
        else { TitleAndIconLabelStyle().makeBody(configuration: configuration) }
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
