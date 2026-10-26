import MnemionKit
import SwiftUI

struct ProjectsView: View {
    @Environment(SessionModel.self) private var session
    @Environment(PortfolioStore.self) private var store
    @State private var selection: PatternEntry.ID?

    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            List(selection: $selection) {
                Section {
                    ForEach(store.projects) { project in
                        ProjectRow(project: project, unaligned: store.unaligned.contains(project.ref))
                            .tag(project.id)
                    }
                }
                if !store.unservedGoals.isEmpty {
                    // The weekly review's other half: goals no project serves,
                    // so no work feeds them.
                    Section("Goals nothing serves") {
                        ForEach(store.unservedGoals) { goal in
                            Label(goal.entry.string("title") ?? "Untitled", systemImage: "scope")
                                .foregroundStyle(.secondary)
                                .selectionDisabled()
                        }
                    }
                }
            }
            .navigationTitle("Projects")
            .overlay {
                if store.projects.isEmpty {
                    ContentUnavailableView("No projects yet", systemImage: "folder",
                        description: Text("Projects created by you or your agents appear here."))
                }
            }
            .refreshable {
                await store.loadProjects()
                await store.loadAlignment()
            }
            .toolbar {
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
            if let project = store.project(selection) {
                ProjectDetailView(project: project)
                    .id(project.id)
            } else {
                ContentUnavailableView("Select a project", systemImage: "square.stack.3d.up")
            }
        }
        .task {
            await store.loadProjects()
            await store.loadSchema()
            await store.loadAlignment()
        }
        .task { await store.listen() }
        .alert("Mnemion", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.error ?? "")
        }
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
        case "incubating", "open": return .orange
        default: return .secondary
        }
    }
}
