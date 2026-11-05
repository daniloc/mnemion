import MnemionKit
import SwiftUI

/// What needs attention now, as the worker derives it: due review hooks,
/// overdue, due and stalled work, alignment gaps, and the untriaged inbox.
/// It reads as a page, not a list of records: the day and what it asks, the
/// reviews waiting, the work in order of urgency, and a rail for what is
/// structural rather than urgent. Every row has the moves the review asks for:
/// done, drop, reschedule.
struct ReviewView: View {
    let go: (Destination) -> Void
    @Environment(PortfolioStore.self) private var store
    @State private var running: ReviewHook?
    @State private var width: CGFloat = 1000
    /// The work filter: the rest of the page always shows the whole review.
    @SceneStorage("reviewProject") private var projectFilter = ""
    @State private var query = ""

    var body: some View {
        Page(width: $width) {
            if let review = store.review {
                PageHeader(title: (Dates.date(review.asOf) ?? .now).formatted(.dateTime.weekday(.wide).month(.wide).day()),
                           summary: summary(review))
                hooks(review)
                PageColumns(width: width) {
                    work(review)
                } rail: {
                    rail(review)
                }
            } else if store.reviewUnavailable {
                Notice(text: "This hive’s worker predates the review. Deploy the latest worker to see what needs attention.")
                InboxCard(go: go)
            } else {
                ProgressView("Deriving the review…")
                    .frame(maxWidth: .infinity)
                    .padding(.top, 120)
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
        // Rows name their project; the review itself carries only the task.
        .task(id: store.projects.count) { await store.loadMissingTasks() }
        .sheet(item: $running) { hook in
            ReviewHookSheet(hook: hook)
        }
    }

    // MARK: The page

    /// The review in a sentence, in order of urgency.
    private func summary(_ review: Review) -> String {
        let parts = [
            (review.allOverdue.count, "overdue"),
            (review.allDueToday.count, "due today"),
            (review.allDueThisWeek.count, "due this week"),
            (review.allStalled.count, "stalled"),
        ].filter { $0.0 > 0 }.map { "\($0.0) \($0.1)" }
        return parts.isEmpty ? "Nothing needs you right now." : parts.formatted(.list(type: .and)).capitalizedFirst + "."
    }

    /// Day, week and month, each with both ends: what is recorded, what is due
    /// now, and when a close opens, so a start never looks like it has no end.
    @ViewBuilder
    private func hooks(_ review: Review) -> some View {
        if review.hooks.pattern == nil {
            Notice(text: "This hive has no reviews pattern yet. An agent can declare it from mnemion://review.")
        } else {
            // Three across or one column: an orphaned card would read as a missing one.
            let columns = Array(repeating: GridItem(.flexible(), spacing: PageLayout.gap, alignment: .top), count: width > 640 ? 3 : 1)
            LazyVGrid(columns: columns, alignment: .leading, spacing: PageLayout.gap) {
                RhythmCard(title: "Today", start: .dayStart, review: review) { running = $0 }
                RhythmCard(title: "This week", start: .weekStart, review: review) { running = $0 }
                RhythmCard(title: "This month", start: .monthStart, review: review) { running = $0 }
            }
        }
    }

    private func work(_ review: Review) -> some View {
        let all = review.allOverdue + review.allDueToday + review.allDueThisWeek + review.allStalled
        let projects = workProjects(all)
        // A project that has since left the review stops filtering rather than emptying the list.
        let project = projects.first { $0.project.id == projectFilter }?.project
        let filtering = project != nil || !trimmedQuery.isEmpty
        let shown = { (items: [Review.Brief]) in items.filter { matches($0, project: project) } }
        return VStack(alignment: .leading, spacing: 32) {
            if !all.isEmpty {
                WorkFilter(projects: projects, total: all.count, selected: project?.id, query: $query) {
                    projectFilter = $0 ?? ""
                }
                .padding(.bottom, -12)
            }
            WorkSection(title: "Overdue", systemImage: "exclamationmark.circle.fill", tint: .red,
                        items: shown(review.allOverdue), age: .late, expanded: filtering, go: go)
            WorkSection(title: "Due today", systemImage: "sun.max.fill", tint: .orange,
                        items: shown(review.allDueToday), age: .none, expanded: filtering, go: go)
            WorkSection(title: "This week", systemImage: "calendar", tint: .blue,
                        items: shown(review.allDueThisWeek), age: .weekday, expanded: filtering, go: go)
            WorkSection(title: "Stalled", systemImage: "hourglass", tint: .secondary,
                        subtitle: stalledSubtitle(review), items: shown(review.allStalled), age: .idle, expanded: filtering, go: go)
            if filtering, !all.contains(where: { matches($0, project: project) }) {
                ContentUnavailableView {
                    Label("Nothing matches", systemImage: "line.3.horizontal.decrease.circle")
                } actions: {
                    Button("Clear Filter") {
                        projectFilter = ""
                        query = ""
                    }
                }
            }
        }
    }

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespaces) }

    private func matches(_ brief: Review.Brief, project: PatternEntry?) -> Bool {
        let owner = store.project(containing: brief.ref)
        if let project, owner?.id != project.id { return false }
        guard !trimmedQuery.isEmpty else { return true }
        return brief.label.localizedStandardContains(trimmedQuery)
            || owner?.entry.string("title")?.localizedStandardContains(trimmedQuery) == true
    }

    /// The projects with work in the review, busiest first.
    private func workProjects(_ items: [Review.Brief]) -> [(project: PatternEntry, count: Int)] {
        var counts: [EntryRef: (project: PatternEntry, count: Int)] = [:]
        for brief in items {
            guard let project = store.project(containing: brief.ref) else { continue }
            counts[project.ref, default: (project, 0)].count += 1
        }
        return counts.values.sorted {
            $0.count != $1.count ? $0.count > $1.count
                : ($0.project.entry.string("title") ?? "") < ($1.project.entry.string("title") ?? "")
        }
    }

    private func stalledSubtitle(_ review: Review) -> String? {
        review.work.first.map { "Open, untouched for \($0.stallDays) days or more" }
    }

    private func rail(_ review: Review) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            InboxCard(go: go)
            // Exemptions (the catch-all project) are the worker's, from the charter's
            // review_exempt, so agents and this screen read the same gaps.
            ForEach(review.alignment.filter { !$0.entries.isEmpty }) { gap in
                VStack(alignment: .leading, spacing: 8) {
                    GroupLabel(gapTitle(gap))
                    ForEach(gap.entries, id: \.ref) { brief in
                        Button {
                            open(brief)
                        } label: {
                            HStack(spacing: 6) {
                                Text(brief.label).lineLimit(2).multilineTextAlignment(.leading)
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
                            }
                            .font(.callout)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // MARK: Helpers

    private func gapTitle(_ gap: Review.Gap) -> String {
        switch (gap.relation, gap.end) {
        case (Portfolio.serves, "source"): return "Serving no goal"
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

private extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

extension ReviewHook {
    /// When a close opens, in words: the worker's windows (entities/Hive/review.ts).
    /// The hour and the timezone are the charter's, so this names no time of day.
    var opens: String {
        switch self {
        case .dayEnd: return "Opens later today"
        case .weekEnd: return "Opens Friday"
        case .monthEnd: return "Opens in the month’s last three days"
        default: return "Open now"
        }
    }

    /// One color per rhythm: the day, the week, the month.
    var tint: Color {
        switch self {
        case .dayStart, .dayEnd: return .orange
        case .weekStart, .weekEnd: return .blue
        case .monthStart, .monthEnd: return .purple
        }
    }
}

// MARK: - Parts

private struct Notice: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "info.circle")
            .foregroundStyle(.secondary)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
    }
}

/// One rhythm's two ends. Both are always shown: the review derives when each
/// is due, and a close that hasn't opened yet is part of the picture.
private struct RhythmCard: View {
    let title: String
    let start: ReviewHook
    let review: Review
    let run: (ReviewHook) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(start.tint)
                .padding(.horizontal, 10)
                .padding(.bottom, 2)
            HookRow(hook: start, state: state(of: start)) { run(start) }
            HookRow(hook: start.counterpart, state: state(of: start.counterpart)) { run(start.counterpart) }
        }
        .padding(10)
        .card()
    }

    private func state(of hook: ReviewHook) -> HookRow.State {
        guard let status = review.status(of: hook) else { return .upcoming }
        if status.due { return .due }
        // Start hooks are open all period, so not due means recorded. A close is
        // recorded when its latest entry names this period; otherwise it hasn't opened.
        return hook.isStart || status.last?.period == status.period ? .recorded : .upcoming
    }
}

private struct HookRow: View {
    enum State { case recorded, due, upcoming }

    let hook: ReviewHook
    let state: State
    let run: () -> Void
    @SwiftUI.State private var hovering = false

    var body: some View {
        Button(action: run) {
            HStack(alignment: .top, spacing: 9) {
                icon.font(.body).frame(width: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(hook.title)
                        .fontWeight(state == .due ? .semibold : .regular)
                        .foregroundStyle(state == .upcoming ? .secondary : .primary)
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        // Every row keeps two lines, so the three cards stay level.
                        .lineLimit(2, reservesSpace: true)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 4)
                if state == .due {
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .background(background, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        // One entry per period: a recorded review is not offered twice.
        .disabled(state == .recorded)
        .onHover { hovering = $0 }
        .help(state == .upcoming ? "You can run it early." : "")
    }

    @ViewBuilder
    private var icon: some View {
        switch state {
        case .recorded:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .due:
            Image(systemName: hook.systemImage).foregroundStyle(hook.tint)
        case .upcoming:
            Image(systemName: "circle.dashed").foregroundStyle(.tertiary)
        }
    }

    private var detail: String {
        switch state {
        case .recorded: return "Recorded"
        case .due: return hook.prompt
        case .upcoming: return hook.opens
        }
    }

    private var background: AnyShapeStyle {
        if state == .due { return AnyShapeStyle(hook.tint.opacity(hovering ? 0.2 : 0.12)) }
        return hovering && state != .recorded ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.clear)
    }
}

private struct InboxCard: View {
    let go: (Destination) -> Void
    @Environment(PortfolioStore.self) private var store

    var body: some View {
        Button {
            go(.inbox)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: store.notes.isEmpty ? "tray" : "tray.full")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Inbox").font(.headline)
                    Text(store.notes.isEmpty ? "Nothing to triage" : "\(store.notes.count) waiting for triage")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
            .padding(14)
        }
        .buttonStyle(RowButtonStyle(corner: 12))
        .card()
    }
}

/// Narrow the work to one project, or to words in a task or project name.
private struct WorkFilter: View {
    let projects: [(project: PatternEntry, count: Int)]
    let total: Int
    let selected: PatternEntry.ID?
    @Binding var query: String
    let select: (PatternEntry.ID?) -> Void

    var body: some View {
        // Wrapped rather than scrolled: every project stays in view, and a Mac
        // has no visible cue that a row of chips scrolls sideways.
        FlowLayout(spacing: 6) {
            FilterChip(title: "All", count: total, isOn: selected == nil) { select(nil) }
            ForEach(projects, id: \.project.id) { item in
                FilterChip(title: item.project.entry.string("title") ?? "Untitled", count: item.count,
                           isOn: selected == item.project.id) { select(item.project.id) }
            }
            HStack(spacing: 5) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Filter", text: $query)
                    .textFieldStyle(.plain)
                if !query.isEmpty {
                    Button {
                        query = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear filter")
                }
            }
            .font(.callout)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .frame(width: 150)
            .background(.quinary, in: Capsule())
        }
    }
}

/// Lays its subviews out in rows, wrapping at the proposed width.
private struct FlowLayout: Layout {
    var spacing: CGFloat

    private func rows(_ subviews: Subviews, width: CGFloat) -> (origins: [CGPoint], size: CGSize) {
        var origins: [CGPoint] = []
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            origins.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return (origins, CGSize(width: widest, height: y + rowHeight))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        rows(subviews, width: proposal.width ?? .infinity).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let origins = rows(subviews, width: bounds.width).origins
        for (subview, origin) in zip(subviews, origins) {
            subview.place(at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y), proposal: .unspecified)
        }
    }
}

private struct FilterChip: View {
    let title: String
    let count: Int
    let isOn: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Text(title).lineLimit(1)
                Text(count, format: .number).foregroundStyle(isOn ? AnyShapeStyle(.white.opacity(0.8)) : AnyShapeStyle(.secondary))
            }
            .font(.callout)
            .foregroundStyle(isOn ? AnyShapeStyle(.white) : AnyShapeStyle(.primary))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(isOn ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.quinary), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

/// How a row states its time; the section already says what kind of time it is.
private enum WorkAge {
    case none, late, weekday, idle
}

/// A titled group of work. Long ones open on their first rows, so one bad month
/// doesn't push everything else off the page.
private struct WorkSection: View {
    let title: String
    let systemImage: String
    let tint: Color
    var subtitle: String?
    let items: [Review.Brief]
    let age: WorkAge
    /// A filtered list is already short: show all of it.
    var expanded = false
    let go: (Destination) -> Void
    @State private var showAll = false

    private static let preview = 5
    private var shown: [Review.Brief] { showAll || expanded ? items : Array(items.prefix(Self.preview)) }

    var body: some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: title, systemImage: systemImage, tint: tint, count: items.count, note: subtitle)
                VStack(spacing: 0) {
                    DividedRows(items: shown, id: \.ref) { brief in
                        WorkRow(brief: brief, age: age, go: go)
                    }
                    if !expanded, items.count > Self.preview {
                        Divider().padding(.leading, 46)
                        Button(showAll ? "Show fewer" : "Show all \(items.count)") {
                            withAnimation(.snappy(duration: 0.2)) { showAll.toggle() }
                        }
                        .buttonStyle(.plain)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 10)
                        .frame(maxWidth: .infinity)
                        .contentShape(Rectangle())
                    }
                }
                .card()
            }
        }
    }
}

/// One task the review named: finish it in a click, open its project, and on
/// hover (always, where there is no hover) reschedule or pick another status.
private struct WorkRow: View {
    let brief: Review.Brief
    let age: WorkAge
    let go: (Destination) -> Void
    @Environment(PortfolioStore.self) private var store
    @State private var rescheduling = false
    @State private var hovering = false
    @State private var finishing = false

    private var project: PatternEntry? { store.project(containing: brief.ref) }

    private var closing: String? { store.closingStatus(for: brief.pattern) }

    private var controlsVisible: Bool {
        #if os(macOS)
        hovering || rescheduling
        #else
        true
        #endif
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            finish
            VStack(alignment: .leading, spacing: 3) {
                Text(brief.label)
                    .lineLimit(2)
                    .foregroundStyle(finishing ? .secondary : .primary)
                HStack(spacing: 8) {
                    if let project {
                        Text(project.entry.string("title") ?? "Untitled")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    // The initial status says nothing in a list of open work.
                    if let status = brief.status, status != store.statuses(for: brief.pattern).first {
                        StatusBadge(status: status)
                    }
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { if let project { go(.project(project.id)) } }
            Spacer(minLength: 8)
            // One slot: the moves take the age's place on hover, so controls that
            // aren't showing never squeeze the title.
            ZStack(alignment: .trailing) {
                ageLabel.opacity(controlsVisible ? 0 : 1)
                controls.opacity(controlsVisible ? 1 : 0)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background { if hovering { Rectangle().fill(.quinary) } }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .contextMenu { moves }
        .popover(isPresented: $rescheduling) {
            ReschedulePopover(deadline: brief.deadline) { date in
                rescheduling = false
                Task { await store.update(brief.ref, ["deadline": .string(Dates.string(date))]) }
            }
        }
    }

    /// A circle that writes the pattern's first declared closed status; absent
    /// when the pattern declares none, so it only offers what the hive accepts.
    @ViewBuilder
    private var finish: some View {
        if let closing {
            Button {
                finishing = true
                Task {
                    if await !store.update(brief.ref, ["status": .string(closing)]) { finishing = false }
                }
            } label: {
                Image(systemName: finishing ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(finishing ? Color.green : Color.secondary)
            }
            .buttonStyle(.plain)
            .disabled(finishing)
            .help("Mark \(closing)")
            .accessibilityLabel("Finish")
        } else {
            Image(systemName: "circle").font(.title3).hidden()
        }
    }

    private var controls: some View {
        HStack(spacing: 10) {
            Button {
                rescheduling = true
            } label: {
                Image(systemName: "calendar")
            }
            .buttonStyle(.plain)
            .help("Reschedule")
            .accessibilityLabel("Reschedule")
            Menu {
                moves
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Change status")
        }
        .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private var moves: some View {
        // Only statuses this entry's pattern declares; the worker refuses any other.
        ForEach(store.statuses(for: brief.pattern).filter { $0 != brief.status }, id: \.self) { status in
            Button(status.capitalized, systemImage: statusImage(status)) {
                Task { await store.update(brief.ref, ["status": .string(status)]) }
            }
        }
        Divider()
        Button("Reschedule…", systemImage: "calendar") { rescheduling = true }
    }

    @ViewBuilder
    private var ageLabel: some View {
        if let text = ageText {
            Text(text)
                .font(.callout)
                .monospacedDigit()
                .foregroundStyle(age == .late ? Color.red : Color.secondary)
                .help(Dates.describe(deadline: brief.deadline) ?? "")
        }
    }

    private var ageText: String? {
        switch age {
        case .none:
            return nil
        case .late:
            return Dates.daysFromToday(brief.deadline).map { Self.days(-$0) }
        case .weekday:
            return Dates.date(brief.deadline)?.formatted(.dateTime.weekday(.abbreviated))
        case .idle:
            return Dates.daysFromToday(brief.updatedAt).map { Self.days(-$0) }
        }
    }

    private static func days(_ n: Int) -> String { n == 1 ? "1 day" : "\(n) days" }

    private func statusImage(_ status: String) -> String {
        let closed = store.schema(for: brief.pattern)?.facet("status")?.closed ?? []
        return closed.contains(status) ? "checkmark.circle" : "circle"
    }
}

/// The two dates people mostly mean, and the calendar for the rest.
private struct ReschedulePopover: View {
    let set: (Date) -> Void
    @State private var date: Date

    init(deadline: String?, set: @escaping (Date) -> Void) {
        self.set = set
        // A past deadline is not a useful place to open the calendar.
        let current = Dates.date(deadline) ?? .now
        _date = State(initialValue: max(current, .now))
    }

    private var tomorrow: Date { Calendar.current.date(byAdding: .day, value: 1, to: .now) ?? .now }
    private var nextMonday: Date {
        Calendar.current.nextDate(after: .now, matching: DateComponents(weekday: 2), matchingPolicy: .nextTime) ?? .now
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Button("Tomorrow") { set(tomorrow) }
                Button("Next Monday") { set(nextMonday) }
            }
            DatePicker("New deadline", selection: $date, displayedComponents: .date)
                .datePickerStyle(.graphical)
                .labelsHidden()
            Button("Set Deadline") { set(date) }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(14)
    }
}
