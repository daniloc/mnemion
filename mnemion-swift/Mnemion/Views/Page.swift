import MnemionKit
import SwiftUI

// The parts every designed screen is built from: one scrolling page width, one
// card surface, one section header, one divided list, one hover treatment. A
// screen says what it shows; these say how it looks.

extension EnvironmentValues {
    /// A phone-width page: a tighter margin, and one column of everything.
    @Entry var pageIsCompact = false
}

/// A scrolling page of a readable width, reporting its width so a screen can
/// choose its columns.
struct Page<Content: View>: View {
    @Binding var width: CGFloat
    @ViewBuilder let content: Content

    var body: some View {
        let compact = PageLayout.isCompact(width)
        GeometryReader { geo in
        ScrollView {
            VStack(alignment: .leading, spacing: compact ? 24 : 36) {
                content
            }
            .frame(maxWidth: PageLayout.contentWidth, alignment: .leading)
            .padding(.horizontal, PageLayout.margin(width))
            .padding(.top, compact ? 8 : 20)
            .padding(.bottom, 48)
            // Exactly the scroll view's width. A fraction of a point of overflow
            // from any row would otherwise let the whole page pan sideways.
            .frame(width: geo.size.width)
        }
        .onChange(of: geo.size.width, initial: true) { _, w in width = w }
        }
        .environment(\.pageIsCompact, compact)
    }
}

enum PageLayout {
    static let gap: CGFloat = 12
    static let contentWidth: CGFloat = 1040

    static func isCompact(_ pageWidth: CGFloat) -> Bool { pageWidth < 500 }
    /// The phone's own margin, so a page lines up with the navigation bar over it.
    static func margin(_ pageWidth: CGFloat) -> CGFloat { isCompact(pageWidth) ? 16 : 32 }

    /// The width of one of `count` equal columns on a page this wide.
    static func column(of count: CGFloat, pageWidth: CGFloat) -> CGFloat {
        (min(pageWidth - 2 * margin(pageWidth), contentWidth) - (count - 1) * gap) / count
    }
}

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
    @Environment(\.pageIsCompact) private var compactPage
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var compact: Bool { compactPage || sizeClass == .compact }
    #else
    private var compact: Bool { compactPage }
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
    /// When the columns stack, the rail reads first: what a thing is, before its work.
    var railLeadsWhenStacked = false
    @ViewBuilder let main: Main
    @ViewBuilder let rail: Rail

    var body: some View {
        if width > 820 {
            HStack(alignment: .top, spacing: PageLayout.gap) {
                main.frame(maxWidth: .infinity, alignment: .leading)
                rail.frame(width: PageLayout.column(of: 3, pageWidth: width))
            }
        } else {
            VStack(alignment: .leading, spacing: PageLayout.isCompact(width) ? 24 : 32) {
                if railLeadsWhenStacked { rail }
                main
                if !railLeadsWhenStacked { rail }
            }
        }
    }
}

/// Narrow a list of work to one project, or to words in its name or its project's.
/// With no projects to offer, it is just the text field.
struct ProjectFilter: View {
    let projects: [(project: PatternEntry, count: Int)]
    let total: Int
    let selected: PatternEntry.ID?
    @Binding var query: String
    let select: (PatternEntry.ID?) -> Void
    @Environment(\.pageIsCompact) private var compact

    var body: some View {
        if compact {
            // A finger knows a row of chips scrolls; on a phone, wrapping would
            // push the work down the screen.
            VStack(alignment: .leading, spacing: 8) {
                ScrollView(.horizontal) {
                    HStack(spacing: 6) {
                        chips
                    }
                }
                .scrollIndicators(.never)
                .scrollClipDisabled()
                // A short row has nothing to scroll, so it shouldn't move at all.
                .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
                search(width: nil)
            }
        } else {
            // Wrapped rather than scrolled: every project stays in view, and a Mac
            // has no visible cue that a row of chips scrolls sideways.
            FlowLayout(spacing: 6) {
                chips
                search(width: 150)
            }
        }
    }

    @ViewBuilder
    private var chips: some View {
        if !projects.isEmpty {
            FilterChip(title: "All", count: total, isOn: selected == nil) { select(nil) }
        }
        ForEach(projects, id: \.project.id) { item in
            FilterChip(title: item.project.entry.string("title") ?? "Untitled", count: item.count,
                       isOn: selected == item.project.id) { select(item.project.id) }
        }
    }

    private func search(width: CGFloat?) -> some View {
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
            .frame(width: width)
            .background(.quinary, in: Capsule())
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
