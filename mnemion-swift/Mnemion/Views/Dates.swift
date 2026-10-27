import MnemionKit
import SwiftUI

/// Date-only strings (`YYYY-MM-DD`) as the hive stores deadlines and review
/// periods: parsed and rendered in the local calendar, never shifted by time.
enum Dates {
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .iso8601)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// A date-only value is that day; a timestamp (the hive stores UTC) is read
    /// as the local calendar day it falls on.
    static func date(_ s: String?) -> Date? {
        guard let s, s.count >= 10 else { return nil }
        if s.contains("T") {
            let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
            if let instant = (try? Date(s, strategy: fractional)) ?? (try? Date(s, strategy: .iso8601)) {
                return Calendar.current.startOfDay(for: instant)
            }
        }
        return formatter.date(from: String(s.prefix(10)))
    }

    static func string(_ d: Date) -> String { formatter.string(from: d) }

    static var today: String { string(.now) }

    /// Whole days from today to the date: negative when past.
    static func daysFromToday(_ s: String?) -> Int? {
        guard let d = date(s) else { return nil }
        let cal = Calendar.current
        return cal.dateComponents([.day], from: cal.startOfDay(for: .now), to: cal.startOfDay(for: d)).day
    }

    /// "3 days overdue", "due today", "due in 2 days", "due Nov 1".
    static func describe(deadline s: String?) -> String? {
        guard let days = daysFromToday(s), let d = date(s) else { return nil }
        switch days {
        case ..<(-1): return "\(-days) days overdue"
        case -1: return "1 day overdue"
        case 0: return "due today"
        case 1: return "due tomorrow"
        case 2...13: return "due in \(days) days"
        default: return "due \(d.formatted(.dateTime.month(.abbreviated).day()))"
        }
    }
}

extension View {
    /// A floor for sheets on the Mac; phones get the sheet's own width.
    @ViewBuilder
    func sheetSize(minWidth: CGFloat, minHeight: CGFloat) -> some View {
        #if os(macOS)
        self.frame(minWidth: minWidth, minHeight: minHeight)
        #else
        self
        #endif
    }
}

/// A deadline as a short, color-coded label.
struct DeadlineLabel: View {
    let deadline: String?
    var closed = false

    var body: some View {
        if let text = Dates.describe(deadline: deadline) {
            let days = Dates.daysFromToday(deadline) ?? 0
            Label(text, systemImage: days < 0 ? "exclamationmark.triangle" : "calendar")
                .font(.caption)
                .foregroundStyle(closed ? Color.gray.opacity(0.6) : days < 0 ? Color.red : days <= 2 ? Color.orange : Color.secondary)
                .labelStyle(.titleAndIcon)
        }
    }
}
