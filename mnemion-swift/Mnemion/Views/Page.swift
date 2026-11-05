import MnemionKit
import SwiftUI

// The parts every designed screen is built from: one scrolling page width, one
// card surface, one section header, one divided list, one hover treatment. A
// screen says what it shows; these say how it looks.

/// A scrolling page of a readable width, reporting its width so a screen can
/// choose its columns.
struct Page<Content: View>: View {
    @Binding var width: CGFloat
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 36) {
                content
            }
            .frame(maxWidth: PageLayout.contentWidth, alignment: .leading)
            .padding(.horizontal, PageLayout.margin)
            .padding(.top, 20)
            .padding(.bottom, 48)
            .frame(maxWidth: .infinity)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }
}

enum PageLayout {
    static let gap: CGFloat = 12
    static let margin: CGFloat = 32
    static let contentWidth: CGFloat = 1040

    /// The width of one of `count` equal columns on a page this wide.
    static func column(of count: CGFloat, pageWidth: CGFloat) -> CGFloat {
        (min(pageWidth - 2 * margin, contentWidth) - (count - 1) * gap) / count
    }
}

/// The large serif headline a page opens on, and a sentence on what it holds.
struct PageHeader: View {
    let title: String
    let summary: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 32, weight: .semibold, design: .serif))
            Text(summary)
                .font(.title3)
                .foregroundStyle(.secondary)
        }
    }
}

/// The surface every grouped block on a page sits on.
struct Card: ViewModifier {
    var highlighted = false

    func body(content: Content) -> some View {
        content
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .background(highlighted ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.quinary),
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(.separator.opacity(0.5), lineWidth: 0.5)
            }
    }
}

extension View {
    func card(highlighted: Bool = false) -> some View { modifier(Card(highlighted: highlighted)) }
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

/// Rows with dividers that start at the text.
struct DividedRows<Item, ID: Hashable, Row: View>: View {
    let items: [Item]
    let id: KeyPath<Item, ID>
    var inset: CGFloat = 46
    @ViewBuilder let row: (Item) -> Row

    var body: some View {
        ForEach(items, id: id) { item in
            if items.first?[keyPath: id] != item[keyPath: id] { Divider().padding(.leading, inset) }
            row(item)
        }
    }
}

/// A plain button that lights its label on hover: a row, or a whole card with
/// `corner` matching it.
struct RowButtonStyle: ButtonStyle {
    var corner: CGFloat = 0

    func makeBody(configuration: Configuration) -> some View {
        Highlighted(configuration: configuration, corner: corner)
    }

    private struct Highlighted: View {
        let configuration: Configuration
        let corner: CGFloat
        @State private var hovering = false

        var body: some View {
            configuration.label
                .contentShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
                .background {
                    if hovering || configuration.isPressed {
                        RoundedRectangle(cornerRadius: corner, style: .continuous).fill(.quinary)
                    }
                }
                .onHover { hovering = $0 }
        }
    }
}

/// The same hover on a row that holds its own buttons, so it can't be one itself.
struct RowHover: ViewModifier {
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .background { if hovering { Rectangle().fill(.quinary) } }
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
    }
}

/// The main column and side rail: the rail takes one third-width column, so it
/// lines up with anything laid out in thirds above it.
struct PageColumns<Main: View, Rail: View>: View {
    let width: CGFloat
    @ViewBuilder let main: Main
    @ViewBuilder let rail: Rail

    var body: some View {
        if width > 820 {
            HStack(alignment: .top, spacing: PageLayout.gap) {
                main.frame(maxWidth: .infinity, alignment: .leading)
                rail.frame(width: PageLayout.column(of: 3, pageWidth: width))
            }
        } else {
            VStack(alignment: .leading, spacing: 32) {
                main
                rail
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
