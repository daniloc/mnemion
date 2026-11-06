import MnemionKit
import SwiftUI

/// Goals, each with the projects that serve it and how their work stands. A goal
/// with nothing serving it is the question the monthly review asks, so it says so.
struct GoalsView: View {
    let go: (Destination) -> Void
    @Environment(PortfolioStore.self) private var store

    var body: some View {
        Group {
            if store.goals.isEmpty {
                ContentUnavailableView("No goals yet", systemImage: "scope",
                    description: Text("Goals are directional and never checked off. An agent can create them."))
            } else {
                List {
                    Section {
                        PageHeader(title: store.goals.count == 1 ? "1 goal" : "\(store.goals.count) goals", summary: summary)
                            .listRowBackground(Color.clear)
                    }
                    ForEach(store.goals) { GoalSection(goal: $0, go: go) }
                }
                #if os(iOS)
                .listStyle(.insetGrouped)
                #else
                .listStyle(.inset)
                #endif
                .listSectionSpacing(.compact)
            }
        }
        .pageTitle("Goals")
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
}

/// A goal as a list section: what it is, the projects serving it, and a way to add one.
private struct GoalSection: View {
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
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(goal.entry.string("title") ?? "Untitled")
                    .font(.system(size: 19, weight: .semibold, design: .serif))
                if let horizon = goal.entry.string("horizon") {
                    Label(horizon, systemImage: "clock")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .labelStyle(.titleAndIcon)
                }
                if let why = goal.entry.string("why") {
                    Text(why)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .padding(.top, 4)
                }
            }
            .padding(.vertical, 6)

            if serving.isEmpty {
                Label("No project serves this goal", systemImage: "exclamationmark.circle.fill")
                    .font(.callout)
                    .foregroundStyle(.orange)
            }
            ForEach(serving) { project in
                ServingRow(project: project) { go(.project(project.id)) }
            }
            if !addable.isEmpty {
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
                .menuIndicator(.hidden)
            }
        }
    }
}

/// A project under its goal: how much is open, and how much of that is late.
private struct ServingRow: View {
    let project: PatternEntry
    let open: () -> Void
    @Environment(PortfolioStore.self) private var store
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    /// A phone can't hold a name and two counts on a line.
    private var compact: Bool {
        #if os(iOS)
        sizeClass == .compact
        #else
        false
        #endif
    }

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
                if compact {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(project.entry.string("title") ?? "Untitled")
                        HStack(spacing: 8) { counts }.font(.caption)
                    }
                    Spacer(minLength: 8)
                } else {
                    Text(project.entry.string("title") ?? "Untitled").lineLimit(1)
                    Spacer(minLength: 8)
                    counts.font(.callout)
                }
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        // The row's text keeps its own colors; the list still highlights the tap.
        .foregroundStyle(.primary)
    }

    @ViewBuilder
    private var counts: some View {
        if overdue > 0 {
            Text("\(overdue) overdue").foregroundStyle(.red)
        }
        if let openCount {
            Text("\(openCount) open").monospacedDigit().foregroundStyle(.secondary)
        }
    }
}
