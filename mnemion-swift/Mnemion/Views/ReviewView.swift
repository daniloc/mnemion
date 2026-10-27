import MnemionKit
import SwiftUI

/// What needs attention now, as the worker derives it: due review hooks,
/// overdue, due and stalled work, alignment gaps, and the untriaged inbox.
/// Every row has the three moves the review asks for: done, drop, reschedule.
struct ReviewView: View {
    let go: (Destination) -> Void
    @Environment(PortfolioStore.self) private var store
    @State private var running: ReviewHook?

    var body: some View {
        List {
            if let review = store.review {
                hooks(review)
                work("Overdue", review.allOverdue, empty: "Nothing overdue.")
                work("Due today", review.allDueToday)
                work("This week", review.allDueThisWeek)
                work("Stalled", review.allStalled, footer: stalledFooter(review))
                alignment(review)
                inbox
            } else if store.reviewUnavailable {
                Section {
                    Label("This hive's worker predates the review. Deploy the latest worker to see what needs attention.", systemImage: "info.circle")
                        .foregroundStyle(.secondary)
                }
                inbox
            } else {
                Section {
                    ProgressView("Deriving the review…")
                }
            }
        }
        .navigationTitle("Review")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu("Run a review", systemImage: "play.circle") {
                    ForEach(ReviewHook.allCases) { hook in
                        Button(hook.title, systemImage: hook.systemImage) { running = hook }
                    }
                }
                .disabled(store.review?.hooks.pattern == nil)
            }
        }
        .refreshable { await store.loadReview() }
        .sheet(item: $running) { hook in
            ReviewHookSheet(hook: hook)
        }
    }

    // MARK: Sections

    @ViewBuilder
    private func hooks(_ review: Review) -> some View {
        Section {
            if review.hooks.pattern == nil {
                Label("This hive has no reviews pattern yet. An agent can declare it from mnemion://review.", systemImage: "info.circle")
                    .foregroundStyle(.secondary)
            } else if review.dueHooks.isEmpty {
                Label("No review due. \(review.asOf)", systemImage: "checkmark.circle")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(review.dueHooks) { hook in
                    Button {
                        running = hook
                    } label: {
                        HStack {
                            Label(hook.title, systemImage: hook.systemImage)
                            Spacer()
                            Text(hook.prompt).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        } header: {
            Text("Reviews")
        } footer: {
            if let message = review.message { Text(message) }
        }
    }

    @ViewBuilder
    private func work(_ title: String, _ items: [Review.Brief], empty: String? = nil, footer: String? = nil) -> some View {
        if !items.isEmpty || empty != nil {
            Section {
                if items.isEmpty, let empty {
                    Text(empty).foregroundStyle(.secondary)
                }
                ForEach(items, id: \.ref) { brief in
                    WorkRow(brief: brief)
                }
            } header: {
                Text(items.isEmpty ? title : "\(title) · \(items.count)")
            } footer: {
                if let footer { Text(footer) }
            }
        }
    }

    private func stalledFooter(_ review: Review) -> String? {
        guard let days = review.work.first?.stallDays, !review.allStalled.isEmpty else { return nil }
        return "Open, untouched for \(days) days."
    }

    @ViewBuilder
    private func alignment(_ review: Review) -> some View {
        // Exemptions (the catch-all project) are the worker's, from the charter's
        // review_exempt, so agents and this screen read the same gaps.
        ForEach(review.alignment) { gap in
            let entries = gap.entries
            if !entries.isEmpty {
                Section("\(gapTitle(gap)) · \(entries.count)") {
                    ForEach(entries, id: \.ref) { brief in
                        Button {
                            open(brief)
                        } label: {
                            HStack {
                                Text(brief.label)
                                Spacer()
                                Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var inbox: some View {
        Section("Inbox") {
            Button {
                go(.inbox)
            } label: {
                HStack {
                    Label(store.notes.isEmpty ? "Nothing waiting for triage" : "\(store.notes.count) notes waiting for triage", systemImage: "tray")
                    Spacer()
                    Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: Helpers

    private func gapTitle(_ gap: Review.Gap) -> String {
        switch (gap.relation, gap.end) {
        case (Portfolio.serves, "source"): return "Projects serving no goal"
        case (Portfolio.serves, "target"): return "Goals nothing serves"
        case (Portfolio.belongsTo, "target"): return "Projects with no tasks"
        case (_, "source"): return "\(gap.pattern.capitalized) without \(gap.relation)"
        default: return "\(gap.pattern.capitalized) nothing \(gap.relation)"
        }
    }

    private func open(_ brief: Review.Brief) {
        if brief.pattern == Portfolio.projects, let project = store.project(ref: brief.ref) {
            go(.project(project.id))
        } else if brief.pattern == Portfolio.goals {
            go(.goals)
        }
    }
}

/// One task the review named, with the moves the review asks for.
struct WorkRow: View {
    let brief: Review.Brief
    @Environment(PortfolioStore.self) private var store
    @State private var rescheduling = false
    @State private var newDate = Date.now

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(brief.label)
                HStack(spacing: 8) {
                    DeadlineLabel(deadline: brief.deadline)
                    if let status = brief.status { StatusBadge(status: status) }
                    if let project = projectName {
                        Text(project).font(.caption).foregroundStyle(.tertiary)
                    }
                }
            }
            Spacer()
            Menu {
                // Only statuses this entry's pattern declares; the worker refuses any other.
                ForEach(store.statuses(for: brief.pattern).filter { $0 != brief.status }, id: \.self) { status in
                    Button(status.capitalized, systemImage: statusImage(status)) {
                        Task { await store.update(brief.ref, ["status": .string(status)]) }
                    }
                }
                Divider()
                Button("Reschedule…", systemImage: "calendar") {
                    newDate = Dates.date(brief.deadline) ?? .now
                    rescheduling = true
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
        .padding(.vertical, 2)
        .popover(isPresented: $rescheduling) {
            VStack(spacing: 12) {
                DatePicker("New deadline", selection: $newDate, displayedComponents: .date)
                    .datePickerStyle(.graphical)
                Button("Set deadline") {
                    rescheduling = false
                    Task { await store.update(brief.ref, ["deadline": .string(Dates.string(newDate))]) }
                }
                .buttonStyle(.borderedProminent)
            }
            .padding()
        }
    }

    private func statusImage(_ status: String) -> String {
        switch status.lowercased() {
        case "done", "complete", "completed": return "checkmark.circle"
        case "dropped", "cancelled", "canceled": return "xmark.circle"
        case "in-progress", "doing": return "play.circle"
        default: return "circle"
        }
    }

    private var projectName: String? {
        for (project, list) in store.tasks where list.contains(where: { $0.ref == brief.ref }) {
            return store.project(ref: project)?.entry.string("title")
        }
        return nil
    }
}
