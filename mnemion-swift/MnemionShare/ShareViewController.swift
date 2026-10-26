import MnemionKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The share sheet: a URL or some text from any app becomes an inbox note, with
/// no project and no classification. Reads the signed-in session from the
/// keychain item the main app shares; asks for a sign-in otherwise.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ShareView(
            items: extensionContext?.inputItems as? [NSExtensionItem] ?? [],
            finish: { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) },
            cancel: { [weak self] in
                self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
            }))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }
}

private struct ShareView: View {
    let items: [NSExtensionItem]
    let finish: () -> Void
    let cancel: () -> Void
    @State private var text = ""
    @State private var url: String?
    @State private var saving = false
    @State private var saved = false
    @State private var problem: String?

    private var client: HiveClient? {
        HiveClient.restored(callbackURI: URL(string: "\(SharedSession.keychainService):/oauth/callback")!)
    }

    var body: some View {
        NavigationStack {
            Form {
                if client == nil {
                    Text("Open Mnemion and sign in to your hive first.")
                        .foregroundStyle(.secondary)
                } else if saved {
                    Label("Saved to the inbox", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                } else {
                    Section("Note") {
                        TextField("Jot it down. Classify later.", text: $text, axis: .vertical)
                            .lineLimit(4...)
                    }
                    if let url {
                        Section("Link") {
                            Text(url).font(.footnote).foregroundStyle(.secondary).lineLimit(3)
                        }
                    }
                    if let problem {
                        Text(problem).foregroundStyle(.red).font(.footnote)
                    }
                }
            }
            .navigationTitle("Mnemion")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(saved ? "Done" : "Cancel") { saved ? finish() : cancel() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if !saved {
                        Button("Save", action: save)
                            .disabled(saving || client == nil || (text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && url == nil))
                    }
                }
            }
            .task { await load() }
        }
    }

    /// The first URL and the first text the host app shared.
    private func load() async {
        for item in items {
            for provider in item.attachments ?? [] {
                if url == nil, provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let loaded = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                    url = loaded.absoluteString
                } else if text.isEmpty, provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let loaded = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                    text = loaded
                }
            }
            if text.isEmpty, let title = item.attributedContentText?.string, !title.isEmpty { text = title }
        }
        if text.isEmpty, let url { text = url }
    }

    private func save() {
        guard let client else { return }
        saving = true
        Task {
            do {
                _ = try await client.capture(text.trimmingCharacters(in: .whitespacesAndNewlines), source: .share, url: url)
                saved = true
                try? await Task.sleep(for: .seconds(0.8))
                finish()
            } catch {
                problem = error.localizedDescription
            }
            saving = false
        }
    }
}
