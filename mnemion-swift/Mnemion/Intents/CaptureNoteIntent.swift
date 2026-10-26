import AppIntents
import MnemionKit

/// "Capture a note in Mnemion": Siri, Shortcuts, the Action button, Spotlight.
/// Runs in the background without opening the app; the note lands in the inbox
/// with no project, like every other capture.
struct CaptureNoteIntent: AppIntent {
    static let title: LocalizedStringResource = "Capture a Note"
    static let description = IntentDescription("Saves a note to your Mnemion inbox, to be triaged later.")
    static let openAppWhenRun = false

    @Parameter(title: "Note", requestValueDialog: "What should I jot down?")
    var text: String

    @Parameter(title: "Link")
    var link: URL?

    static var parameterSummary: some ParameterSummary {
        Summary("Capture \(\.$text)") {
            \.$link
        }
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let client = HiveClient.restored(callbackURI: Self.callbackURI) else {
            throw CaptureError.signedOut
        }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { throw CaptureError.empty }
        _ = try await client.capture(body, source: .current, url: link?.absoluteString)
        return .result(dialog: "Saved to your Mnemion inbox.")
    }

    static var callbackURI: URL {
        URL(string: "\(Bundle.main.bundleIdentifier ?? SharedSession.keychainService):/oauth/callback")!
    }
}

enum CaptureError: LocalizedError {
    case signedOut, empty

    var errorDescription: String? {
        switch self {
        case .signedOut: return "Open Mnemion and sign in to your hive first."
        case .empty: return "The note is empty."
        }
    }
}

struct MnemionShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: CaptureNoteIntent(),
            phrases: [
                "Capture a note in \(.applicationName)",
                "Jot something down in \(.applicationName)",
                "Add to my \(.applicationName) inbox",
            ],
            shortTitle: "Capture a note",
            systemImageName: "tray.and.arrow.down")
    }
}
