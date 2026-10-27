import Foundation

/// `mnemion://review` as `GET /api/review` serves it: what needs attention now,
/// derived by the worker on every read (entities/Hive/review.ts). Nothing here
/// is stored; a hook is due until a review entry covers its period, work is
/// judged by deadline and last touch, alignment by the links a chain's steps
/// lack. The app renders it and writes the review entries that resolve it.
public struct Review: Decodable, Sendable {
    public let asOf: String
    public let timezone: String
    public let hooks: Hooks
    public let work: [Work]
    public let alignment: [Gap]
    public let message: String?

    enum CodingKeys: String, CodingKey { case asOf = "as_of", timezone, hooks, work, alignment, message }

    public struct Hooks: Decodable, Sendable {
        /// The pattern review entries go in; nil when the hive declares none yet.
        public let pattern: String?
        public let due: [String]
        public let status: [HookStatus]
    }

    public struct HookStatus: Decodable, Sendable, Identifiable {
        public let kind: String
        /// The current period's key: the day, the week's Monday, or the month's first.
        public let period: String
        public let due: Bool
        public let last: Last?
        public var id: String { kind }
        public var hook: ReviewHook? { ReviewHook(rawValue: kind) }

        public struct Last: Decodable, Sendable {
            public let id: Int
            public let period: String
        }
    }

    public struct Work: Decodable, Sendable, Identifiable {
        public let pattern: String
        public let open: Int
        public let undated: Int
        public let stallDays: Int
        public let overdue: [Brief]
        public let dueToday: [Brief]
        public let dueThisWeek: [Brief]
        public let stalled: [Brief]
        public var id: String { pattern }

        enum CodingKeys: String, CodingKey {
            case pattern, open, undated, overdue, stalled
            case stallDays = "stall_days", dueToday = "due_today", dueThisWeek = "due_this_week"
        }
    }

    /// An entry as the review names it: enough to show a row and to act on it.
    public struct Brief: Decodable, Sendable, Hashable {
        public let pattern: String
        public let id: Int
        public let label: String
        public let uri: String
        public let status: String?
        public let deadline: String?
        public let updatedAt: String?
        public var ref: EntryRef { EntryRef(pattern: pattern, id: id) }

        enum CodingKeys: String, CodingKey { case pattern, id, label, uri, status, deadline, updatedAt = "updated_at" }
    }

    public struct Gap: Decodable, Sendable, Identifiable {
        public let chain: String
        public let relation: String
        /// "source": entries lacking the relation; "target": entries nothing reaches.
        public let end: String
        public let pattern: String
        public let entries: [Brief]
        public var id: String { "\(chain):\(relation):\(end):\(pattern)" }
    }

    public var allOverdue: [Brief] { work.flatMap(\.overdue) }
    public var allDueToday: [Brief] { work.flatMap(\.dueToday) }
    public var allDueThisWeek: [Brief] { work.flatMap(\.dueThisWeek) }
    public var allStalled: [Brief] { work.flatMap(\.stalled) }
    public var dueHooks: [ReviewHook] { hooks.due.compactMap(ReviewHook.init(rawValue:)) }
    public func status(of hook: ReviewHook) -> HookStatus? { hooks.status.first { $0.kind == hook.rawValue } }
}

/// The six review hooks, in the order a day, a week and a month unfold.
public enum ReviewHook: String, CaseIterable, Sendable, Identifiable {
    case dayStart = "day-start", dayEnd = "day-end"
    case weekStart = "week-start", weekEnd = "week-end"
    case monthStart = "month-start", monthEnd = "month-end"

    public var id: String { rawValue }

    public var isStart: Bool {
        switch self {
        case .dayStart, .weekStart, .monthStart: return true
        case .dayEnd, .weekEnd, .monthEnd: return false
        }
    }

    /// The start hook an end hook reflects on, and vice versa.
    public var counterpart: ReviewHook {
        switch self {
        case .dayStart: return .dayEnd
        case .dayEnd: return .dayStart
        case .weekStart: return .weekEnd
        case .weekEnd: return .weekStart
        case .monthStart: return .monthEnd
        case .monthEnd: return .monthStart
        }
    }

    public var title: String {
        switch self {
        case .dayStart: return "Start the day"
        case .dayEnd: return "Close the day"
        case .weekStart: return "Start the week"
        case .weekEnd: return "Close the week"
        case .monthStart: return "Start the month"
        case .monthEnd: return "Close the month"
        }
    }

    /// The question the hook asks; the answer becomes `intention` or `reflection`.
    public var prompt: String {
        switch self {
        case .dayStart: return "What is the one outcome for today?"
        case .dayEnd: return "Did it happen? What intervened, and what changed?"
        case .weekStart: return "Which projects get attention this week?"
        case .weekEnd: return "What moved, what stalled, what carries over?"
        case .monthStart: return "Which goals get a project this month?"
        case .monthEnd: return "What did the month prove, and what should retire?"
        }
    }

    /// What a start hook commits to: tasks for a day, projects for a week or month.
    public var commitsTo: String {
        switch self {
        case .dayStart, .dayEnd: return Portfolio.tasks
        case .weekStart, .weekEnd, .monthStart, .monthEnd: return Portfolio.projects
        }
    }

    public var systemImage: String {
        switch self {
        case .dayStart: return "sunrise"
        case .dayEnd: return "sunset"
        case .weekStart: return "calendar"
        case .weekEnd: return "calendar.badge.checkmark"
        case .monthStart: return "calendar.circle"
        case .monthEnd: return "calendar.circle.fill"
        }
    }
}

/// The relations the reviews doctrine names.
public enum Reviews {
    public static let commitsTo = "commits-to"
    public static let reflectsOn = "reflects-on"
}

extension HiveClient {
    /// The derived review, fresh from the worker.
    public func review() async throws -> Review {
        try decode(Review.self, from: try await send(get("api/review")))
    }

    /// One atomic batch (`POST /api/batch`): `link` / `unlink` shortcut items need
    /// no operation, and required-relation rules are judged on the end state, so a
    /// move is an unlink and a link in one call.
    @discardableResult
    public func batch(_ operations: [[String: JSONValue]]) async throws -> Data {
        try await send(post("api/batch", body: ["operations": .array(operations.map { .object($0) })]))
    }

    /// Record a review: the hook, its period, the human's words, and links to the
    /// work committed to (`commits-to`) or the start review answered (`reflects-on`).
    public func recordReview(
        in pattern: String, hook: ReviewHook, period: String,
        text: String, energy: String?, commits: [EntryRef], reflectsOn: EntryRef?
    ) async throws -> PatternEntry {
        var data: [String: JSONValue] = ["kind": .string(hook.rawValue), "period": .string(period)]
        data[hook.isStart ? "intention" : "reflection"] = .string(text)
        if let energy, !energy.isEmpty { data["energy"] = .string(energy) }
        var relate: [String: [EntryRef]] = [:]
        if !commits.isEmpty { relate[Reviews.commitsTo] = commits }
        if let reflectsOn { relate[Reviews.reflectsOn] = [reflectsOn] }
        let created = try await mutate(pattern, .create, data, relate: relate)
        guard let entry = created.entry else { throw HiveError.decoding("create returned no entry") }
        return PatternEntry(pattern: pattern, entry: entry)
    }

    /// Fetch one entry in full (for its version, before an update).
    public func entry(_ ref: EntryRef) async throws -> PatternEntry? {
        try await entries(ref.pattern, ids: [ref.id]).first.map { PatternEntry(pattern: ref.pattern, entry: $0) }
    }
}
