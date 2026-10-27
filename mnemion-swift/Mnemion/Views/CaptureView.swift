import MnemionKit
import SwiftUI
#if os(macOS)
import AppKit
#endif

/// Capture a note, then connect it: after the note is saved, the hive's nearest
/// entries (by meaning) are offered as one-tap `references` links. No project,
/// no classification; triage happens later in the inbox.
///
/// One view for every way in: the ⌘N sheet, the menu bar popover and the
/// quick capture panel. On the Mac it draws its own chrome (no navigation bar),
/// so all three look and behave the same: Return saves, ⌥Return breaks a line,
/// Escape closes.
struct CaptureView: View {
    enum Style {
        /// A sheet over the main window.
        case sheet
        /// The menu bar popover or the floating quick capture panel.
        case panel
    }

    var style: Style = .sheet
    /// How the surrounding container goes away. Nil uses the environment's dismiss.
    var close: (() -> Void)? = nil
    @Environment(PortfolioStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var url = ""
    @State private var saving = false
    @State private var saved: PatternEntry?
    @State private var related: [PrimeHit] = []
    @State private var findingRelated = false
    @State private var linked: Set<EntryRef> = []
    @State private var clipboardURL: URL?
    @FocusState private var focus: Field?

    private enum Field { case text, url }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        #if os(macOS)
        VStack(spacing: 0) {
            if let note = saved {
                connect(note)
            } else {
                compose
            }
        }
        .frame(width: style == .panel ? 520 : 540)
        .onExitCommand(perform: finish)
        .animation(.snappy(duration: 0.22), value: saved == nil)
        .animation(.snappy(duration: 0.22), value: findingRelated)
        #else
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    if let note = saved { connect(note) } else { compose }
                }
            }
            .navigationTitle(saved == nil ? "New Note" : "Saved")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(saved == nil ? "Cancel" : "Done", action: finish)
                }
                if saved == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save", action: save).disabled(saving || trimmed.isEmpty)
                    }
                }
            }
        }
        #endif
    }

    // MARK: Compose

    private var compose: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 14) {
                TextField("What’s on your mind?", text: $text, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.system(size: 17))
                    .lineLimit(style == .panel ? 3...12 : 6...16)
                    .focused($focus, equals: .text)
                    #if os(macOS)
                    .onSubmit(save)
                    #endif
                linkRow
            }
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .padding(.bottom, 16)

            #if os(macOS)
            Divider()
            HStack(spacing: 14) {
                Label("Inbox", systemImage: "tray")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .help("New notes land in the inbox; triage them into tasks or projects later.")
                Spacer()
                KeyHint(keys: "⌥↩", label: "New line")
                if style == .panel {
                    KeyHint(keys: "esc", label: "Close")
                } else {
                    Button("Cancel", action: finish)
                        .keyboardShortcut(.cancelAction)
                        .controlSize(.large)
                }
                Button(action: save) {
                    if saving {
                        ProgressView().controlSize(.small).padding(.horizontal, 6)
                    } else {
                        Text("Save").padding(.horizontal, 4)
                    }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(saving || trimmed.isEmpty)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            #endif
        }
        .onAppear {
            focus = .text
            clipboardURL = Self.urlOnClipboard()
        }
    }

    /// The optional link, as a quiet row rather than a second form field. A web
    /// address on the clipboard is offered as a one-click fill.
    private var linkRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "link")
                .foregroundStyle(url.isEmpty ? .tertiary : .secondary)
                .frame(width: 16)
            TextField("Add a link", text: $url)
                .textFieldStyle(.plain)
                .font(.callout)
                .focused($focus, equals: .url)
                .autocorrectionDisabled()
                #if os(iOS)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                #endif
                #if os(macOS)
                .onSubmit(save)
                #endif
            if url.isEmpty, let clip = clipboardURL {
                Button {
                    url = clip.absoluteString
                } label: {
                    Label("Paste \(clip.host() ?? "link")", systemImage: "doc.on.clipboard")
                        .font(.caption)
                        .lineLimit(1)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help(clip.absoluteString)
            } else if !url.isEmpty {
                Button {
                    url = ""
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove link")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    // MARK: Connect

    private func connect(_ note: PatternEntry) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title)
                        .foregroundStyle(.green)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Saved to Inbox").font(.headline)
                        Text(note.entry.string("body") ?? "")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }

                if findingRelated {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Looking for related entries…")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.leading, 2)
                } else if !related.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Link it to what it touches")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.secondary)
                        RelatedList(hits: related, linked: linked) { hit in
                            Task {
                                if await store.connect(note.ref, to: hit.ref) { linked.insert(hit.ref) }
                            }
                        }
                    }
                } else {
                    Text("Nothing related in the hive yet.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(20)

            #if os(macOS)
            Divider()
            HStack(spacing: 12) {
                if !linked.isEmpty {
                    Label("\(linked.count) linked", systemImage: "link")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("New Note", action: reset)
                    .keyboardShortcut("n", modifiers: .command)
                    .controlSize(.large)
                Button("Done", action: finish)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            #else
            Button("Another note", action: reset).padding(.horizontal, 20)
            #endif
        }
    }

    // MARK: Actions

    private func save() {
        guard !saving, !trimmed.isEmpty else { return }
        saving = true
        Task {
            let body = trimmed
            let link = url.trimmingCharacters(in: .whitespaces)
            if let note = await store.capture(body, url: link.isEmpty ? nil : link) {
                // Show the note as saved at once; the related entries follow.
                findingRelated = true
                saved = note
                saving = false
                related = await store.related(to: body, excluding: note.ref)
                findingRelated = false
                // Nothing to link: the confirmation has done its job.
                if related.isEmpty, saved?.id == note.id {
                    try? await Task.sleep(for: .seconds(1.2))
                    if saved?.id == note.id { finish() }
                }
            } else {
                saving = false
            }
        }
    }

    /// Close the container. A saved note starts the next capture fresh; an
    /// unsaved draft stays, so a panel dismissed by accident loses nothing.
    private func finish() {
        if saved != nil { reset() }
        if let close { close() } else { dismiss() }
    }

    private func reset() {
        text = ""
        url = ""
        saved = nil
        related = []
        linked = []
        findingRelated = false
        clipboardURL = Self.urlOnClipboard()
        focus = .text
    }

    private static func urlOnClipboard() -> URL? {
        #if os(macOS)
        guard let s = NSPasteboard.general.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !s.contains(where: \.isWhitespace),
              let url = URL(string: s), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", url.host() != nil
        else { return nil }
        return url
        #else
        return nil // reading the iOS pasteboard prompts; the share sheet covers links there
        #endif
    }
}

/// A keyboard shortcut shown as a keycap and what it does.
struct KeyHint: View {
    let keys: String
    let label: String

    var body: some View {
        HStack(spacing: 5) {
            Text(keys)
                .font(.caption.monospaced())
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
            Text(label)
                .font(.caption)
        }
        .foregroundStyle(.secondary)
    }
}

/// Prime hits as rows with a one-click link.
struct RelatedList: View {
    let hits: [PrimeHit]
    let linked: Set<EntryRef>
    let link: (PrimeHit) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(hits, id: \.ref) { hit in
                RelatedRow(hit: hit, isLinked: linked.contains(hit.ref)) { link(hit) }
            }
        }
    }
}

private struct RelatedRow: View {
    let hit: PrimeHit
    let isLinked: Bool
    let link: () -> Void
    @State private var hovering = false

    var body: some View {
        Button {
            if !isLinked { link() }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: Self.symbol(for: hit.pattern))
                    .foregroundStyle(.secondary)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text(hit.label)
                        .lineLimit(1)
                        .foregroundStyle(.primary)
                    Text(hit.pattern.capitalized)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                Spacer(minLength: 8)
                if isLinked {
                    Label("Linked", systemImage: "checkmark")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.green)
                } else {
                    Label("Link", systemImage: "plus")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(hovering ? Color.accentColor : Color.secondary)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
            .background(hovering && !isLinked ? AnyShapeStyle(.quaternary.opacity(0.6)) : AnyShapeStyle(.clear),
                        in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(hit.label)
    }

    static func symbol(for pattern: String) -> String {
        switch pattern {
        case Inbox.pattern: return "tray"
        case Portfolio.tasks: return "checkmark.circle"
        case Portfolio.projects: return "folder"
        case Portfolio.goals: return "scope"
        default: return "doc.text"
        }
    }
}
