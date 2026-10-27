import MnemionKit
import SwiftUI

/// Capture a note, then connect it: after the note is saved, the hive's nearest
/// entries (by meaning) are offered as one-tap `references` links. No project,
/// no classification; triage happens later in the inbox.
struct CaptureView: View {
    var compact = false
    @Environment(PortfolioStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var body_ = ""
    @State private var url = ""
    @State private var saving = false
    @State private var saved: PatternEntry?
    @State private var related: [PrimeHit] = []
    @State private var linked: Set<EntryRef> = []
    @FocusState private var focused: Bool

    var body: some View {
        if compact {
            content.padding()
        } else {
            NavigationStack {
                content
                    .padding()
                    .navigationTitle(saved == nil ? "New note" : "Connect")
                    #if os(iOS)
                    .navigationBarTitleDisplayMode(.inline)
                    #endif
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button(saved == nil ? "Cancel" : "Done") { dismiss() }
                        }
                    }
            }
            .sheetSize(minWidth: 420, minHeight: 360)
        }
    }

    @ViewBuilder
    private var content: some View {
        if let note = saved {
            connect(note)
        } else {
            compose
        }
    }

    private var compose: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextEditor(text: $body_)
                .font(.body)
                .frame(minHeight: compact ? 90 : 160)
                .focused($focused)
                .onAppear { focused = true }
                .overlay(alignment: .topLeading) {
                    if body_.isEmpty {
                        Text("Jot it down. Classify later.")
                            .foregroundStyle(.tertiary)
                            .padding(.top, 8).padding(.leading, 5)
                            .allowsHitTesting(false)
                    }
                }
            TextField("Link (optional)", text: $url)
                .textFieldStyle(.roundedBorder)
                #if os(iOS)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                #endif
                .autocorrectionDisabled()
            HStack {
                if compact {
                    Text("⌘↩ to save").font(.caption).foregroundStyle(.tertiary)
                }
                Spacer()
                Button(action: save) {
                    if saving { ProgressView().controlSize(.small) } else { Text("Save") }
                }
                .keyboardShortcut(.return, modifiers: .command)
                .buttonStyle(.borderedProminent)
                .disabled(saving || body_.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private func connect(_ note: PatternEntry) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Saved to the inbox", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
            if related.isEmpty {
                Text("Nothing nearby in the hive yet.")
                    .foregroundStyle(.secondary)
            } else {
                Text("Connect it to what it touches:")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                RelatedList(hits: related, linked: linked) { hit in
                    Task {
                        if await store.connect(note.ref, to: hit.ref) { linked.insert(hit.ref) }
                    }
                }
            }
            HStack {
                Spacer()
                Button("Another note") { reset() }
                Button("Done") { if compact { reset() } else { dismiss() } }
                    .keyboardShortcut(.return, modifiers: .command)
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    private func save() {
        saving = true
        Task {
            let text = body_.trimmingCharacters(in: .whitespacesAndNewlines)
            let link = url.trimmingCharacters(in: .whitespaces)
            if let note = await store.capture(text, url: link.isEmpty ? nil : link) {
                related = await store.related(to: text, excluding: note.ref)
                saved = note
            }
            saving = false
        }
    }

    private func reset() {
        body_ = ""
        url = ""
        saved = nil
        related = []
        linked = []
        focused = true
    }
}

/// Prime hits as rows with a one-tap link.
struct RelatedList: View {
    let hits: [PrimeHit]
    let linked: Set<EntryRef>
    let link: (PrimeHit) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(hits, id: \.ref) { hit in
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(hit.label).lineLimit(2)
                        Text(hit.pattern).font(.caption2).foregroundStyle(.tertiary)
                    }
                    Spacer()
                    if linked.contains(hit.ref) {
                        Label("Linked", systemImage: "link").font(.caption).foregroundStyle(.secondary)
                    } else {
                        Button("Link") { link(hit) }
                            .controlSize(.small)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }
}
