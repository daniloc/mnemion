import MnemionKit
import SwiftUI

/// What needs attention now, as the worker derives it: due review hooks,
/// overdue, due and stalled work, alignment gaps, and the untriaged inbox.
/// It reads as a page, not a list of records: the day and what it asks, the
/// reviews waiting, the work in order of urgency, and what is structural rather
/// than urgent, beside the work where there is room. Every row has the moves the
/// review asks for: done, drop, reschedule.
struct ReviewView: View {
    let go: (Destination) -> Void
    @Environment(PortfolioStore.self) private var store
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif
    @State private var running: ReviewHook?
    /// The work filter: the rest of the page always shows the whole review.
    @SceneStorage("reviewProject") private var projectFilter = ""
    @State private var query = ""
    /// The structural part in an inspector, off by default: the review cards
    /// need the width more, and without it the structure follows the work.
    @AppStorage("reviewStructureShown") private var structureShown = false

    private var regular: Bool {
        #if os(iOS)
        sizeClass == .regular
        #else
        true
        #endif
    }

    private var inspecting: Bool { regular && structureShown }

    var body: some View {
        Group {
            if let review = store.review {
                List {
                    Section {
                        PageHeader(title: headline(review), summary: summary(review))
                            .listRowBackground(Color.clear)
                    }
                    hooks(review)
                    work(review)
                    if !inspecting { structure(review) }
                }
                #if os(iOS)
                .listStyle(.insetGrouped)
                #else
                .listStyle(.inset)
                #endif
                .headerProminence(.increased)
                .searchable(text: $query, prompt: "Filter work")
                .inspector(isPresented: Binding(get: { inspecting }, set: { structureShown = $0 })) {
                    List { structure(review) }
                        .inspectorColumnWidth(min: 240, ideal: 280, max: 360)
                }
            } else if store.reviewUnavailable {
                List {
                    Label("This hive’s worker predates the review. Deploy the latest worker to see what needs attention.",
                          systemImage: "info.circle")
                        .foregroundStyle(.secondary)
                    InboxRow(go: go)
                }
            } else {
                ProgressView("Deriving the review…")
            }
        }
        .pageTitle("Review")
        .toolbar {
            if let review = store.review {
                ToolbarItem(placement: .primaryAction) { projectMenu(review) }
            }
            ToolbarItem(placement: .primaryAction) {
                Menu("Run a review", systemImage: "play.circle") {
                    ForEach(ReviewHook.allCases) { hook in
                        Button(hook.title, systemImage: hook.systemImage) { running = hook }
                    }
                }
                .disabled(store.review?.hooks.pattern == nil)
            }
            if regular {
                ToolbarItem(placement: .primaryAction) {
                    Button("Structure", systemImage: "sidebar.trailing") { structureShown.toggle() }
                }
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

    /// The day; a phone abbreviates the month to keep it on one line.
    private func headline(_ review: Review) -> String {
        let month: Date.FormatStyle.Symbol.Month = regular ? .wide : .abbreviated
        return (Dates.date(review.asOf) ?? .now).formatted(.dateTime.weekday(.wide).month(month).day())
    }

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
        Section {
            if review.hooks.pattern == nil {
                Label("This hive has no reviews pattern yet. An agent can declare it from mnemion://review.",
                      systemImage: "info.circle")
                    .foregroundStyle(.secondary)
            } else {
                let cards = ForEach([ReviewHook.dayStart, .weekStart, .monthStart], id: \.self) { start in
                    RhythmCard(start: start, review: review) { running = $0 }
                }
                // Three across when each card has room for its words. Otherwise a
                // phone scrolls them sideways, the next one showing at the edge, so
                // it doesn't spend a screenful on reviews above the work; a Mac,
                // with no cue that a row scrolls, stacks them.
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 12) { cards }
                    #if os(macOS)
                    VStack(spacing: 12) { cards }
                    #else
                    ScrollView(.horizontal) {
                        HStack(alignment: .top, spacing: 12) {
                            cards.containerRelativeFrame(.horizontal, count: 6, span: 5, spacing: 12)
                        }
                        .scrollTargetLayout()
                    }
                    .scrollIndicators(.never)
                    .scrollTargetBehavior(.viewAligned)
                    #endif
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
        }
    }

    @ViewBuilder
    private func work(_ review: Review) -> some View {
        let all = review.allOverdue + review.allDueToday + review.allDueThisWeek + review.allStalled
        let project = filterProject(review)
        let filtering = project != nil || !query.trimmingCharacters(in: .whitespaces).isEmpty
        let matches = { (brief: Review.Brief) in store.matches(brief.ref, label: brief.label, project: project, query: query) }
        let shown = { (items: [Review.Brief]) in items.filter(matches) }
        WorkSection(title: "Overdue", systemImage: "exclamationmark.circle.fill", tint: .red,
                    items: shown(review.allOverdue), age: .late, expanded: filtering, go: go)
        WorkSection(title: "Due today", systemImage: "sun.max.fill", tint: .orange,
                    items: shown(review.allDueToday), age: .none, expanded: filtering, go: go)
        WorkSection(title: "This week", systemImage: "calendar", tint: .blue,
                    items: shown(review.allDueThisWeek), age: .weekday, expanded: filtering, go: go)
        WorkSection(title: "Stalled", systemImage: "hourglass", tint: .secondary,
                    subtitle: stalledSubtitle(review), items: shown(review.allStalled), age: .idle, expanded: filtering, go: go)
        if filtering, !all.contains(where: matches) {
            Section {
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

    /// A project that has since left the review stops filtering rather than emptying the list.
    private func filterProject(_ review: Review) -> PatternEntry? {
        let all = review.allOverdue + review.allDueToday + review.allDueThisWeek + review.allStalled
        return store.projectCounts(for: all.map(\.ref)).first { $0.project.id == projectFilter }?.project
    }

    /// Narrow the work to one project: a picker in the toolbar, beside the search.
    private func projectMenu(_ review: Review) -> some View {
        let all = review.allOverdue + review.allDueToday + review.allDueThisWeek + review.allStalled
        let projects = store.projectCounts(for: all.map(\.ref))
        let selected = filterProject(review)?.id ?? ""
        return Menu("Project", systemImage: selected.isEmpty ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill") {
            Picker("Project", selection: $projectFilter) {
                Text("All \(all.count)").tag("")
                ForEach(projects, id: \.project.id) { item in
                    Text("\(item.project.entry.string("title") ?? "Untitled") \(item.count)").tag(item.project.id)
                }
            }
            .pickerStyle(.inline)
        }
        .disabled(projects.isEmpty)
    }

    private func stalledSubtitle(_ review: Review) -> String? {
        review.work.first.map { "Open, untouched for \($0.stallDays) days or more" }
    }

    /// What is structural rather than urgent: the inbox, and the alignment gaps.
    @ViewBuilder
    private func structure(_ review: Review) -> some View {
        Section { InboxRow(go: go) }
        // Exemptions (the catch-all project) are the worker's, from the charter's
        // review_exempt, so agents and this screen read the same gaps.
        ForEach(review.alignment.filter { !$0.entries.isEmpty }) { gap in
            Section(gapTitle(gap)) {
                ForEach(gap.entries, id: \.ref) { brief in
                    Button {
                        open(brief)
                    } label: {
                        HStack(spacing: 6) {
                            Text(brief.label).lineLimit(2).multilineTextAlignment(.leading)
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
                        }
                        .contentShape(Rectangle())
                    }
                    .foregroundStyle(.primary)
                    #if os(macOS)
                    .buttonStyle(.plain)
                    #endif
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

    /// The rhythm a start opens, as its card names it.
    var rhythm: String {
        switch self {
        case .dayStart, .dayEnd: return "Today"
        case .weekStart, .weekEnd: return "This week"
        case .monthStart, .monthEnd: return "This month"
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

/// One rhythm's two ends. Both are always shown: the review derives when each
/// is due, and a close that hasn't opened yet is part of the picture.
private struct RhythmCard: View {
    let start: ReviewHook
    let review: Review
    let run: (ReviewHook) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(start.rhythm)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(start.tint)
                .padding(.horizontal, 10)
                .padding(.bottom, 2)
            HookRow(hook: start, state: state(of: start)) { run(start) }
            HookRow(hook: start.counterpart, state: state(of: start.counterpart)) { run(start.counterpart) }
        }
        .padding(10)
        // Room for its words: three of these go across only when each gets it.
        .frame(idealWidth: Self.idealWidth, maxWidth: .infinity, alignment: .leading)
        .background(Self.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    /// Wide enough that a title and its question each keep to two lines. iOS
    /// text is larger: at 200 points the unfolded iPhone Duo broke "Start the
    /// week" over two lines and cut the question short.
    #if os(macOS)
    private static let idealWidth: CGFloat = 200
    #else
    private static let idealWidth: CGFloat = 240
    #endif

    /// A list row's own surface, which this card stands in for.
    #if os(macOS)
    private static let surface = AnyShapeStyle(.quinary)
    #else
    private static let surface = AnyShapeStyle(.background)
    #endif

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

private struct InboxRow: View {
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
            .contentShape(Rectangle())
        }
        .foregroundStyle(.primary)
        #if os(macOS)
        .buttonStyle(.plain)
        #endif
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
            Section {
                ForEach(shown, id: \.ref) { brief in
                    WorkRow(brief: brief, age: age, go: go)
                }
                if !expanded, items.count > Self.preview {
                    Button(showAll ? "Show fewer" : "Show all \(items.count)") {
                        withAnimation(.snappy(duration: 0.2)) { showAll.toggle() }
                    }
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                }
            } header: {
                SectionHeader(title: title, systemImage: systemImage, tint: tint, count: items.count, note: subtitle)
                    .textCase(nil)
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
                    #if !os(macOS)
                    // A phone needs the width for the title, so the age rides along here.
                    ageLabel.font(.caption)
                    #endif
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { if let project { go(.project(project.id)) } }
            Spacer(minLength: 8)
            #if os(macOS)
            // One slot: the moves take the age's place on hover, so controls that
            // aren't showing never squeeze the title.
            ZStack(alignment: .trailing) {
                ageLabel.font(.callout).opacity(hovering || rescheduling ? 0 : 1)
                controls.opacity(hovering || rescheduling ? 1 : 0)
            }
            #else
            // No hover here: the moves are behind the menu and a long press.
            Menu { moves } label: {
                Image(systemName: "ellipsis")
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .tint(.secondary)
            #endif
        }
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

    #if os(macOS)
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
    #endif

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
