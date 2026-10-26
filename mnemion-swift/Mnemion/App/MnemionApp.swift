import SwiftUI

@main
struct MnemionApp: App {
    @State private var session = SessionModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
        }
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
