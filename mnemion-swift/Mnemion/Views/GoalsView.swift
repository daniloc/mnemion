import MnemionKit
import SwiftUI

/// Goals, each with the projects that serve it and their open work. A goal with
/// nothing serving it is the question the monthly review asks.
struct GoalsView: View {
    let go: (Destination) -> Void
    @Environment(PortfolioStore.self) private var store

    var body: some View {
        List {
            ForEach(store.goals) { goal in
                GoalSection(goal: goal, go: go)
            }
            if store.goals.isEmpty {
                ContentUnavailableView("No goals yet", systemImage: "scope",
                    description: Text("Goals are directional and never checked off. An agent can create them."))
            }
        }
        .navigationTitle("Goals")
        .refreshable { await store.loadGoals() }
    }
}

private struct GoalSection: View {
    let goal: PatternEntry
    let go: (Destination) -> Void
    @Environment(PortfolioStore.self) private var store

    private var serving: [PatternEntry] {
        (store.goalProjects[goal.ref] ?? []).compactMap(store.project(ref:))
    }

    private var unserving: [PatternEntry] {
        let serving = Set(serving.map(\.ref))
        return store.projects.filter { !serving.contains($0.ref) && !store.isExempt($0) }
    }

    var body: some View {
        Section {
            if let why = goal.entry.string("why") {
                Text(why).font(.callout).foregroundStyle(.secondary)
            }
            if serving.isEmpty {
                Label("No project serves this goal", systemImage: "exclamationmark.circle")
                    .foregroundStyle(.orange)
            }
            ForEach(serving) { project in
                Button {
                    go(.project(project.id))
                } label: {
                    HStack {
                        Text(project.entry.string("title") ?? "Untitled")
                        Spacer()
                        if let open = openCount(project) {
                            Text("\(open) open").font(.caption).foregroundStyle(.secondary)
                        }
                        Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                    }
                }
                .buttonStyle(.plain)
                .task { if store.tasks[project.ref] == nil { await store.loadTasks(for: project) } }
            }
            if !unserving.isEmpty {
                Menu {
                    ForEach(unserving) { project in
                        Button(project.entry.string("title") ?? "Untitled") {
                            Task { await store.serve(project, goal: goal) }
                        }
                    }
                } label: {
                    Label("Serve with a project…", systemImage: "plus.circle")
                        .font(.callout)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
            }
        } header: {
            HStack {
                Text(goal.entry.string("title") ?? "Untitled")
                if let horizon = goal.entry.string("horizon") {
                    Text("· \(horizon)").foregroundStyle(.secondary)
                }
            }
        }
    }

    private func openCount(_ project: PatternEntry) -> Int? {
        store.tasks[project.ref].map { $0.filter { !store.isClosed($0) }.count }
    }
}
