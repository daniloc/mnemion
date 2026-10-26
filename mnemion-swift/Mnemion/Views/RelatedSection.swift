import MnemionKit
import SwiftUI

/// What an entry is connected to (`resolve`'s one hop), and what else in the
/// hive is near it by meaning (`prime`), with one-tap `references` links.
struct RelatedSection: View {
    let item: PatternEntry
    /// The text prime embeds: the entry's label and its longest text, by default.
    var text: String? = nil
    @Environment(PortfolioStore.self) private var store
    @State private var linked: [Resolution.Linked] = []
    @State private var nearby: [PrimeHit] = []
    @State private var added: Set<EntryRef> = []
    @State private var loadedNearby = false

    var body: some View {
        Section("Connected") {
            if linked.isEmpty {
                Text("No links yet.").foregroundStyle(.secondary)
            }
            ForEach(linked, id: \.uri) { link in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(link.entry.label).lineLimit(2)
                        Text([link.label, link.pattern].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                }
            }
            if !loadedNearby {
                Button("More like this", systemImage: "sparkles") {
                    Task {
                        nearby = await store.related(to: text ?? item.entry.label, excluding: item.ref)
                        loadedNearby = true
                    }
                }
            } else if nearby.isEmpty {
                Text("Nothing else nearby.").foregroundStyle(.secondary)
            } else {
                RelatedList(hits: nearby.filter { hit in !linked.contains { $0.uri == hit.uri } }, linked: added) { hit in
                    Task {
                        if await store.connect(item.ref, to: hit.ref) {
                            added.insert(hit.ref)
                            await load()
                        }
                    }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        if let resolved = try? await store.client.resolve(item.ref.uri) {
            linked = resolved.linked ?? []
        }
    }
}
