import MnemionKit
import SwiftUI

/// Goals, each with the projects that serve it and how their work stands. A goal
/// with nothing serving it is the question the monthly review asks, so it says so.
struct GoalsView: View {
    let go: (Destination) -> Void
    @Environment(PortfolioStore.self) private var store
    @State private var width: CGFloat = 1000

    var body: some View {
        Page(width: $width) {
            if store.goals.isEmpty {
                ContentUnavailableView("No goals yet", systemImage: "scope",
                    description: Text("Goals are directional and never checked off. An agent can create them."))
            } else {
                PageHeader(title: store.goals.count == 1 ? "1 goal" : "\(store.goals.count) goals", summary: summary)
                columns
            }
        }
        .navigationTitle("Goals")
        .refreshable { await store.loadGoals() }
        .task(id: store.projects.count) { await store.loadMissingTasks() }
    }

    private var unserved: Int {
        store.goals.filter { (store.goalProjects[$0.ref] ?? []).isEmpty }.count
    }

    private var summary: String {
        switch unserved {
        case 0: return "Every one has a project serving it."
        case 1: return "One has nothing serving it."
        default: return "\(unserved) have nothing serving them."
        }
    }

    /// Two columns where they fit, each filled in turn, so cards of different
    /// heights stack without gaps.
    @ViewBuilder
    private var columns: some View {
        if width > 820 {
            HStack(alignment: .top, spacing: PageLayout.gap) {
                column(remainder: 0)
                column(remainder: 1)
            }
        } else {
            VStack(spacing: PageLayout.gap) {
                ForEach(store.goals) { GoalCard(goal: $0, go: go) }
            }
        }
    }

    private func column(remainder: Int) -> some View {
        VStack(spacing: PageLayout.gap) {
            ForEach(Array(store.goals.enumerated()).filter { $0.offset % 2 == remainder }, id: \.element.id) { _, goal in
                GoalCard(goal: goal, go: go)
            }
        }
        .frame(maxWidth: .infinity, alignment: .top)
    }
}

private struct GoalCard: View {
    let goal: PatternEntry
    let go: (Destination) -> Void
    @Environment(PortfolioStore.self) private var store

    private var serving: [PatternEntry] {
        (store.goalProjects[goal.ref] ?? []).compactMap(store.project(ref:))
    }

    private var addable: [PatternEntry] {
        let serving = Set(serving.map(\.ref))
        return store.projects.filter { !serving.contains($0.ref) && !store.isExempt($0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text(goal.entry.string("title") ?? "Untitled")
                    .font(.system(size: 19, weight: .semibold, design: .serif))
                    .fixedSize(horizontal: false, vertical: true)
                if let horizon = goal.entry.string("horizon") {
                    Label(horizon, systemImage: "clock")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let why = goal.entry.string("why") {
                    Text(why)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 4)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)

            Divider()
            if serving.isEmpty {
                Label("No project serves this goal", systemImage: "exclamationmark.circle.fill")
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 11)
            }
            DividedRows(items: serving, id: \.id, inset: 44) { project in
                ServingRow(project: project) { go(.project(project.id)) }
            }
            if !addable.isEmpty {
                Divider()
                Menu {
                    ForEach(addable) { project in
                        Button(project.entry.string("title") ?? "Untitled") {
                            Task { await store.serve(project, goal: goal) }
                        }
                    }
                } label: {
                    Label("Serve with a project", systemImage: "plus")
                        .font(.callout)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .padding(.horizontal, 16)
                .padding(.vertical, 9)
            }
        }
        .card()
    }
}

/// A project under its goal: how much is open, and how much of that is late.
private struct ServingRow: View {
    let project: PatternEntry
    let open: () -> Void
    @Environment(PortfolioStore.self) private var store

    private var openCount: Int? {
        store.tasks[project.ref].map { $0.filter { !store.isClosed($0) }.count }
    }

    private var overdue: Int {
        store.review?.allOverdue.filter { store.project(containing: $0.ref)?.ref == project.ref }.count ?? 0
    }

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                ProjectIcon(project: project).frame(width: 18)
                Text(project.entry.string("title") ?? "Untitled").lineLimit(1)
                Spacer(minLength: 8)
                if overdue > 0 {
                    Text("\(overdue) overdue").font(.callout).foregroundStyle(.red)
                }
                if let openCount {
                    Text("\(openCount) open").font(.callout).monospacedDigit().foregroundStyle(.secondary)
                }
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 9)
        }
        .buttonStyle(RowButtonStyle())
    }
}
