import SwiftUI

/// A 1 px hairline. The default separator; rules, not nested boxes.
struct Hairline: View {
    var strong = false
    var body: some View {
        Rectangle().fill(strong ? Color.ruleStrong : Color.rule).frame(height: 1).accessibilityHidden(true)
    }
}

/// The three kinds of button (phone.md section 2): primary (one per view), secondary, ghost.
/// `quiet` is the ghost. There is no red and no destructive kind.
enum ButtonKind { case primary, secondary, quiet }

/// Buttons (phone.md section 2): sentence-case sans 15/600, 44 tall at radius 10; `medium` is 46
/// tall at radius 12 (the sheet's secondary pair); `large` is the 54 tall primary at radius 12 with
/// 17 pt text. Secondary is `--text` on `--hover` with a `--rule-strong` border; the ghost is full
/// `--text`, never `--text-2`.
struct VyreButtonStyle: ButtonStyle {
    var kind: ButtonKind = .secondary
    var fill = false
    var large = false
    var medium = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        let radius: CGFloat = large || medium ? 12 : Radius.card
        configuration.label
            .vyre(large ? .buttonLarge : .button)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .padding(.horizontal, kind == .quiet ? Space.s : Space.gutter)
            .frame(minHeight: large ? 54 : medium ? 46 : Space.target)
            .frame(maxWidth: fill || large ? .infinity : nil)
            .foregroundStyle(foreground)
            .background(background.opacity(configuration.isPressed ? 0.85 : 1), in: RoundedRectangle(cornerRadius: radius))
            .overlay {
                if kind == .secondary { RoundedRectangle(cornerRadius: radius).strokeBorder(Color.ruleStrong, lineWidth: 1) }
            }
            .opacity(enabled ? 1 : 0.45)
            .contentShape(Rectangle())
    }

    private var foreground: Color {
        switch kind {
        case .primary: .primaryInk
        case .secondary, .quiet: .text
        }
    }
    private var background: Color {
        switch kind {
        case .primary: .primaryBg
        case .secondary: .hover
        case .quiet: .clear
        }
    }
}

extension ButtonStyle where Self == VyreButtonStyle {
    static var primary: VyreButtonStyle { VyreButtonStyle(kind: .primary) }
    static var secondary: VyreButtonStyle { VyreButtonStyle(kind: .secondary) }
    static var quiet: VyreButtonStyle { VyreButtonStyle(kind: .quiet) }
    static func vyre(_ kind: ButtonKind, fill: Bool = false, large: Bool = false, medium: Bool = false) -> VyreButtonStyle {
        VyreButtonStyle(kind: kind, fill: fill, large: large, medium: medium)
    }
}

/// The small round dot beside a label: Beacon for needs you, Signal for working, ash for idle.
struct Dot: View {
    var color: Color
    var size: CGFloat = 6
    var body: some View { Circle().fill(color).frame(width: size, height: size).accessibilityHidden(true) }
}

/// A section header: engraved label left, optional engraved note right.
struct SectionHead: View {
    let title: String
    var note: String? = nil
    var color: Color = .label
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Engraved(title, color: color)
            Spacer(minLength: Space.m)
            if let note { Engraved(note) }
        }
    }
}

/// The ground of every screen.
struct Ground: ViewModifier {
    func body(content: Content) -> some View {
        content.background(Color.bg.ignoresSafeArea())
    }
}

extension View {
    func vyreGround() -> some View { modifier(Ground()) }

    /// Standard navigation bar look: ground-coloured, hairline below.
    func vyreNavBar() -> some View {
        self.toolbarBackground(Color.bg, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
    }
}

/// "Something failed" as a fact, not an alarm (phone.md section 11): a crossed circle, a `failed`
/// label and the reason in `--text`. Never red.
struct FailedLine: View {
    let text: String
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "xmark.circle").font(.system(size: 13, weight: .regular)).foregroundStyle(Color.text)
                .accessibilityHidden(true)
            Text("failed").vyre(.small, weight: 600).foregroundStyle(Color.label)
            Text(text).vyre(.small).foregroundStyle(Color.text).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// An empty state: one plain sentence, ash.
struct EmptyLine: View {
    let text: String
    var body: some View {
        Text(text).vyre(.small).foregroundStyle(Color.label).frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, Space.m)
    }
}
