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
    @State private var energy = ""
    @State private var candidates: [PatternEntry] = []
    @State private var chosen: Set<EntryRef> = []
    @State private var startReview: PatternEntry?
    @State private var saving = false
    @State private var commitProject: PatternEntry.ID?
    @State private var commitQuery = ""
    @FocusState private var answering: Bool

    private var period: String { store.review?.status(of: hook)?.period ?? Dates.today }
    private var answer: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var energyOptions: [String] {
        guard let pattern = store.review?.hooks.pattern else { return [] }
        return store.schema(for: pattern)?.facet("energy")?.options ?? []
    }

    /// The period in words: the day, the week it starts, or the month.
    private var periodTitle: String {
        guard let date = Dates.date(period) else { return period }
        switch hook {
        case .dayStart, .dayEnd:
            return date.formatted(.dateTime.weekday(.wide).month(.wide).day())
        case .weekStart, .weekEnd:
            return "Week of \(date.formatted(.dateTime.month(.wide).day()))"
        case .monthStart, .monthEnd:
            return date.formatted(.dateTime.month(.wide).year())
        }
    }

    var body: some View {
        #if os(macOS)
        // The Mac sheet draws its own header and footer, as capture does.
        VStack(spacing: 0) {
            content
            Divider()
            HStack {
                KeyHint(keys: "⌘↩", label: "Record")
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .controlSize(.large)
                recordButton
                    .keyboardShortcut(.return, modifiers: .command)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .sheetSize(minWidth: 560, minHeight: 640)
        .task { await load() }
        #else
        NavigationStack {
            content
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) { recordButton }
                }
                .task { await load() }
        }
        #endif
    }

    private var content: some View {
        Form {
            Section {
                header
                gathered
            }
            Section {
                TextField(hook.isStart ? "In your words" : "What happened", text: $text, axis: .vertical)
                    .lineLimit(4...)
                    .focused($answering)
            } header: {
                // The hook's question is the point of the sheet, so it is the largest thing on it.
                Text(hook.prompt)
                    .font(.system(size: 22, weight: .medium, design: .serif))
                    .foregroundStyle(Color.primary)
                    .textCase(nil)
            }
            // Energy is asked only when the reviews pattern declares the facet,
            // with the options it declares.
            if hook == .dayStart, !energyOptions.isEmpty {
                Section("Energy and attention") {
                    Picker("Energy", selection: $energy) {
                        ForEach(energyOptions, id: \.self) { Text($0.capitalized).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }
            }
            if hook.isStart { commitments }
        }
        .formStyle(.grouped)
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: hook.systemImage)
                .font(.title2)
                .foregroundStyle(hook.tint)
                .frame(width: 42, height: 42)
                .background(hook.tint.opacity(0.15), in: Circle())
            VStack(alignment: .leading, spacing: 1) {
                Text(hook.title).font(.title3.weight(.semibold))
                Text(periodTitle).font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    /// What the filter leaves of the candidates. Anything already chosen stays
    /// chosen when it is filtered out of view; the header keeps count.
    private var shownCandidates: [PatternEntry] {
        let project = store.project(commitProject)
        return candidates.filter {
            store.matches($0.ref, label: $0.entry.string("title") ?? "", project: project, query: commitQuery)
        }
    }

    @ViewBuilder
    private var commitments: some View {
        Section {
            if candidates.isEmpty {
                Text("Nothing open.").foregroundStyle(.secondary)
            } else {
                // Projects aren't sorted into projects: only tasks get the picker.
                if hook.commitsTo == Portfolio.tasks {
                    Picker("Project", selection: $commitProject) {
                        Text("All \(candidates.count)").tag(PatternEntry.ID?.none)
                        ForEach(store.projectCounts(for: candidates.map(\.ref)), id: \.project.id) { item in
                            Text("\(item.project.entry.string("title") ?? "Untitled") \(item.count)").tag(PatternEntry.ID?.some(item.project.id))
                        }
                    }
                }
                TextField("Filter", text: $commitQuery)
                if shownCandidates.isEmpty {
                    Text("Nothing matches.").foregroundStyle(.secondary)
                } else {
                    ForEach(shownCandidates) { commitRow($0) }
                }
            }
        } header: {
            HStack {
                Text(hook.commitsTo == Portfolio.tasks ? "Commit to" : "Projects that get attention")
                Spacer()
                if !chosen.isEmpty {
                    Text("\(chosen.count) chosen").textCase(nil)
                }
            }
        }
    }

    private func commitRow(_ item: PatternEntry) -> some View {
        let isChosen = chosen.contains(item.ref)
        return Button {
            if isChosen { chosen.remove(item.ref) } else { chosen.insert(item.ref) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: isChosen ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isChosen ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.entry.string("title") ?? "Untitled")
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: 8) {
                        if hook.commitsTo == Portfolio.tasks, let project = store.project(containing: item.ref) {
                            Text(project.entry.string("title") ?? "Untitled")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        DeadlineLabel(deadline: item.entry.string("deadline"))
                    }
                }
                Spacer(minLength: 8)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var recordButton: some View {
        Button {
            saving = true
            Task {
                let ok = await store.recordReview(
                    hook: hook, period: period, text: answer,
                    energy: hook == .dayStart && !energy.isEmpty ? energy : nil,
                    commits: Array(chosen), reflectsOn: startReview?.ref)
                saving = false
                if ok { dismiss() }
            }
        } label: {
            Text("Record").padding(.horizontal, 4)
        }
        .disabled(saving || answer.isEmpty)
    }

    /// What the hook gathers, from the review already on screen.
    @ViewBuilder
    private var gathered: some View {
        if let review = store.review {
            switch hook {
            case .dayStart:
                summary([
                    ("Overdue", review.allOverdue.count), ("Due today", review.allDueToday.count),
                    ("This week", review.allDueThisWeek.count), ("Inbox", store.notes.count),
                ])
            case .weekStart, .monthStart:
                summary([
                    ("Overdue", review.allOverdue.count), ("Stalled", review.allStalled.count),
                    ("Alignment gaps", review.alignment.reduce(0) { $0 + $1.entries.count }), ("Inbox", store.notes.count),
                ])
            case .dayEnd, .weekEnd, .monthEnd:
                if let start = startReview {
                    LabeledContent("The intention") {
                        Text(start.entry.string("intention") ?? "—")
                    }
                    if let energy = start.entry.string("energy") {
                        LabeledContent("Energy", value: energy)
                    }
                } else {
                    Text("No \(hook.counterpart.title.lowercased()) review for this period.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    /// What the hook gathered, a row each: four counts never fit a phone as tiles.
    private func summary(_ items: [(String, Int)]) -> some View {
        ForEach(items, id: \.0) { item in
            LabeledContent(item.0) {
                Text(item.1, format: .number).monospacedDigit()
            }
        }
    }

    /// Dated first, most overdue first; undated after, in the order they came.
    private func soonestFirst(_ a: PatternEntry, _ b: PatternEntry) -> Bool {
        switch (a.entry.string("deadline"), b.entry.string("deadline")) {
        case let (x?, y?): return x < y
        case (_?, nil): return true
        default: return false
        }
    }

    private func load() async {
        #if os(macOS)
        // On a phone the keyboard would cover what the review gathered.
        answering = true
        #endif
        if energy.isEmpty, energyOptions.count > 1 { energy = energyOptions[energyOptions.count / 2] }
        if hook.isStart {
            // The rows and the filter name each task's project.
            await store.loadMissingTasks()
            candidates = hook.commitsTo == Portfolio.tasks ? await store.openTasks().sorted(by: soonestFirst) : store.projects
            if hook == .dayStart {
                // Pre-select what is due today.
                chosen = Set(store.review?.allDueToday.map(\.ref) ?? [])
            }
        } else {
            startReview = await store.startReview(for: hook)
        }
    }
}
