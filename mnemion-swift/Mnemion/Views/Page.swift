import MnemionKit
import SwiftUI

// The parts a designed screen adds to the platform's own: the headline it opens
// on, its section headers, and a project's mark. Lists, forms, rows, swipes and
// inspectors are SwiftUI's; a screen lays out by size class, never by a width
// it measured (Mnemion.spec.md, "views lay out with the platform").

extension View {
    /// The navigation title over a page whose headline does the talking: small
    /// on a phone, so two big titles don't stack.
    func pageTitle(_ title: String) -> some View {
        #if os(iOS)
        navigationTitle(title).navigationBarTitleDisplayMode(.inline)
        #else
        navigationTitle(title)
        #endif
    }
}

/// The large serif headline a page opens on, and a sentence on what it holds.
struct PageHeader: View {
    let title: String
    let summary: String
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var compact: Bool { sizeClass == .compact }
    #else
    private let compact = false
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 3 : 6) {
            Text(title)
                .font(.system(size: compact ? 26 : 32, weight: .semibold, design: .serif))
            Text(summary)
                .font(compact ? .body : .title3)
                .foregroundStyle(.secondary)
        }
    }
}

/// A small label over a group: "Commit to", "Serving no goal".
struct GroupLabel: View {
    let title: String

    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
    }
}

/// A titled block's heading: its mark, its name, how many, and a note at the far side.
struct SectionHeader: View {
    let title: String
    var systemImage: String?
    var tint: Color = .secondary
    var count: Int?
    var note: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            if let systemImage { Image(systemName: systemImage).foregroundStyle(tint) }
            Text(title).font(.title3.weight(.semibold))
            if let count {
                Text(count, format: .number)
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if let note {
                Text(note).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }
}

/// A project's mark everywhere it is named: a folder tinted by status, hollow
/// once the pattern declares that status closed.
struct ProjectIcon: View {
    let project: PatternEntry
    @Environment(PortfolioStore.self) private var store

    var body: some View {
        Image(systemName: Portfolio.isClosed(project, schema: store.schema(for: project.pattern)) ? "folder" : "folder.fill")
            .foregroundStyle(StatusBadge.color(for: project.entry.string("status") ?? ""))
    }
}

extension ToolbarContent {
    /// Kept in view longest when a short toolbar overflows, as the HIG asks for
    /// Compose-like actions on the iPhone Duo's vertical bars.
    @ToolbarContentBuilder
    func keptLongest() -> some ToolbarContent {
        if #available(iOS 27.0, macOS 26.1, *) {
            visibilityPriority(.high)
        } else {
            self
        }
    }
}

extension GeometryProxy {
    /// The display is partly folded: a reserved region divides it.
    var isDivided: Bool {
        if #available(iOS 27.1, macOS 27.1, *) {
            return reservedRegions(kind: .division).contains(where: \.isActive)
        }
        return false
    }
}

