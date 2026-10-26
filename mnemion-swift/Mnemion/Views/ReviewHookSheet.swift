import MnemionKit
import SwiftUI

/// Run one review hook with the human: show what the hive gathered, ask the
/// hook's question, and record the answer as a review entry linked to the work
/// committed to (start hooks) or the start review answered (end hooks).
struct ReviewHookSheet: View {
    let hook: ReviewHook
    @Environment(PortfolioStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var energy = "medium"
    @State private var candidates: [PatternEntry] = []
    @State private var chosen: Set<EntryRef> = []
    @State private var startReview: PatternEntry?
    @State private var saving = false

    private var period: String { store.review?.status(of: hook)?.period ?? Dates.today }

    var body: some View {
        NavigationStack {
            Form {
                gathered
                if hook == .dayStart {
                    Section("Energy and attention") {
                        Picker("Energy", selection: $energy) {
                            Text("Low").tag("low")
                            Text("Medium").tag("medium")
                            Text("High").tag("high")
                        }
                        .pickerStyle(.segmented)
                    }
                }
                Section(hook.prompt) {
                    TextField(hook.isStart ? "In your words" : "What happened", text: $text, axis: .vertical)
                        .lineLimit(4...)
                }
                if hook.isStart {
                    Section(hook.commitsTo == Portfolio.tasks ? "Commit to" : "Projects that get attention") {
                        if candidates.isEmpty {
                            Text("Nothing open.").foregroundStyle(.secondary)
                        }
                        ForEach(candidates) { item in
                            Toggle(isOn: Binding(
                                get: { chosen.contains(item.ref) },
                                set: { on in if on { chosen.insert(item.ref) } else { chosen.remove(item.ref) } }
                            )) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.entry.string("title") ?? "Untitled")
                                    DeadlineLabel(deadline: item.entry.string("deadline"))
                                }
                            }
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("\(hook.title) · \(period)")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Record") {
                        saving = true
                        Task {
                            let ok = await store.recordReview(
                                hook: hook, period: period, text: text.trimmingCharacters(in: .whitespacesAndNewlines),
                                energy: hook == .dayStart ? energy : nil,
                                commits: Array(chosen), reflectsOn: startReview?.ref)
                            saving = false
                            if ok { dismiss() }
                        }
                    }
                    .disabled(saving || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .task { await load() }
        }
        .frame(minWidth: 480, minHeight: 520)
    }

    /// What the hook gathers, from the review already on screen.
    @ViewBuilder
    private var gathered: some View {
        if let review = store.review {
            switch hook {
            case .dayStart:
                summary([
                    ("Overdue", review.allOverdue.count), ("Due today", review.allDueToday.count),
                    ("Due this week", review.allDueThisWeek.count), ("Inbox", store.notes.count),
                ])
            case .weekStart, .monthStart:
                summary([
                    ("Overdue", review.allOverdue.count), ("Stalled", review.allStalled.count),
                    ("Alignment gaps", review.alignment.reduce(0) { $0 + $1.entries.count }), ("Inbox", store.notes.count),
                ])
            case .dayEnd, .weekEnd, .monthEnd:
                if let start = startReview {
                    Section("The intention") {
                        Text(start.entry.string("intention") ?? "—")
                        if let energy = start.entry.string("energy") {
                            Text("Energy: \(energy)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Section {
                        Text("No \(hook.counterpart.title.lowercased()) review for this period.")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func summary(_ items: [(String, Int)]) -> some View {
        Section("Gathered") {
            ForEach(items, id: \.0) { item in
                LabeledContent(item.0, value: String(item.1))
            }
        }
    }

    private func load() async {
        if hook.isStart {
            candidates = hook.commitsTo == Portfolio.tasks ? await store.openTasks() : store.projects
            if hook == .dayStart {
                // Pre-select what is due today.
                chosen = Set(store.review?.allDueToday.map(\.ref) ?? [])
            }
        } else {
            startReview = await store.startReview(for: hook)
        }
    }
}
