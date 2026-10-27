import MnemionKit
import SwiftUI

/// Window-level state the commands and the menu bar item share.
@MainActor @Observable
final class AppState {
    var showCapture = false
}

@main
struct MnemionApp: App {
    @State private var session = SessionModel()
    @State private var app = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .environment(app)
                #if os(macOS)
                .onAppear { QuickCapture.shared.install(session: session) }
                #endif
        }
        #if os(macOS)
        .defaultSize(width: 1100, height: 720)
        #endif
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Note") { app.showCapture = true }
                    .keyboardShortcut("n", modifiers: .command)
                #if os(macOS)
                Button("Quick Capture") { QuickCapture.shared.show() }
                    .keyboardShortcut("n", modifiers: [.control, .option])
                #endif
            }
            CommandGroup(after: .appSettings) {
                // The account lives in the app menu, out of the sidebar's way.
                if case .signedIn(let store) = session.phase {
                    Divider()
                    Button("Sign Out of \(store.host)") { session.signOut() }
                }
            }
        }
        #if os(macOS)
        // Capture from anywhere: the menu bar item (and ⌃⌥N, see QuickCapture)
        // takes a note without bringing the window forward, then offers what
        // the hive already holds.
        MenuBarExtra("Mnemion", systemImage: "tray.and.arrow.down") {
            MenuBarCapture()
                .environment(session)
        }
        .menuBarExtraStyle(.window)
        #endif
    }
}

struct RootView: View {
    @Environment(SessionModel.self) private var session

    var body: some View {
        switch session.phase {
        case .signedOut:
            SignInView()
        case .signedIn(let store):
            ProjectsView()
                .environment(store)
                .id(ObjectIdentifier(store)) // a new sign-in is a fresh tree
        }
    }
}

#if os(macOS)
private struct MenuBarCapture: View {
    @Environment(SessionModel.self) private var session

    var body: some View {
        switch session.phase {
        case .signedOut:
            SignedOutCapture()
        case .signedIn(let store):
            CaptureView(style: .panel)
                .environment(store)
        }
    }
}
#endif
