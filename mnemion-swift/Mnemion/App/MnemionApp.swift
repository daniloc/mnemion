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
        }
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Note") { app.showCapture = true }
                    .keyboardShortcut("n", modifiers: .command)
            }
        }
        #if os(macOS)
        // Capture from anywhere: the menu bar item takes a note without
        // bringing the window forward, then offers what the hive already holds.
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
            Text("Sign in to Mnemion to capture notes.")
                .foregroundStyle(.secondary)
                .padding()
                .frame(width: 320)
        case .signedIn(let store):
            CaptureView(compact: true)
                .environment(store)
                .frame(width: 360)
        }
    }
}
#endif
