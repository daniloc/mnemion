import MnemionKit
import SwiftUI

/// Where the sidebar can go. The review comes first: the app opens on what
/// needs attention, not on a list.
enum Destination: Hashable {
    case review, inbox, goals
    case project(PatternEntry.ID)
}

/// The signed-in window: a sidebar of review, inbox, goals and projects, and a
/// detail pane for the selection.
struct ProjectsView: View {
    @Environment(SessionModel.self) private var session
    @Environment(PortfolioStore.self) private var store
    @Environment(AppState.self) private var app
    @State private var selection: Destination? = .review

    var body: some View {
        @Bindable var store = store
        @Bindable var app = app
        NavigationSplitView {
            List(selection: $selection) {
                Section {
                    Label("Review", systemImage: "checklist")
                        .badge(reviewBadge)
                        .tag(Destination.review)
                    Label("Inbox", systemImage: "tray")
                        .badge(store.notes.count)
                        .tag(Destination.inbox)
                    Label("Goals", systemImage: "scope")
                        .tag(Destination.goals)
                }
                Section("Projects") {
                    ForEach(store.projects) { project in
                        ProjectRow(project: project, unaligned: store.unaligned.contains(project.ref))
                            .tag(Destination.project(project.id))
                    }
                }
            }
            .navigationTitle("Mnemion")
            .refreshable { await store.loadAll() }
            .toolbar {
                ToolbarItem {
                    Button("New note", systemImage: "square.and.pencil") { app.showCapture = true }
                        .keyboardShortcut("n", modifiers: .command)
                }
                ToolbarItem {
                    Menu {
                        Section("\(store.member) · \(store.host)") {
                            Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                                session.signOut()
                            }
                        }
                    } label: {
                        Label("Account", systemImage: "person.crop.circle")
                    }
                }
            }
        } detail: {
            switch selection {
            case .review:
                ReviewView(go: { selection = $0 })
            case .inbox:
                InboxView()
            case .goals:
                GoalsView(go: { selection = $0 })
            case .project(let id):
                if let project = store.project(id) {
                    ProjectDetailView(project: project)
                        .id(project.id)
                } else {
                    ContentUnavailableView("Select a project", systemImage: "square.stack.3d.up")
                }
            case nil:
                ContentUnavailableView("Select something", systemImage: "square.stack.3d.up")
            }
        }
        .task { await store.loadAll() }
        .task { await store.listen() }
        .sheet(isPresented: $app.showCapture) {
            CaptureView()
        }
        .alert("Mnemion", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.error ?? "")
        }
    }

    /// Due hooks plus overdue and due-today work.
    private var reviewBadge: Int {
        guard let r = store.review else { return 0 }
        return r.hooks.due.count + r.allOverdue.count + r.allDueToday.count
    }
}

private struct ProjectRow: View {
    let project: PatternEntry
    /// Serves no goal: surfaced for the weekly review.
    let unaligned: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(project.entry.string("title") ?? "Untitled")
                .font(.headline)
            HStack(spacing: 6) {
                if let status = project.entry.string("status") { StatusBadge(status: status) }
                if unaligned {
                    Label("Serves no goal", systemImage: "exclamationmark.circle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                if let horizon = project.entry.string("horizon") {
                    Text(horizon).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct StatusBadge: View {
    let status: String

    var body: some View {
        Text(status)
            .font(.caption2.weight(.semibold))
            .textCase(.uppercase)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }

    private var color: Color {
        switch status.lowercased() {
        case "done", "complete", "completed": return .green
        case "active", "in-progress", "doing": return .blue
        case "blocked": return .red
        case "dropped", "retired", "cancelled": return .gray
        case "incubating", "open": return .orange
        default: return .secondary
        }
    }
}
