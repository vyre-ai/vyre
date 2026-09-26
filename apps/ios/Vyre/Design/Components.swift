import SwiftUI

/// A 1 px hairline. The default separator; rules, not nested boxes.
struct Hairline: View {
    var strong = false
    var body: some View {
        Rectangle().fill(strong ? Color.ruleStrong : Color.rule).frame(height: 1).accessibilityHidden(true)
    }
}

enum ButtonKind { case primary, secondary, quiet, beacon }

/// Buttons (phone.md section 2): sentence-case sans 15/600, 44 tall at radius 10; `large` is the
/// 54 tall primary at radius 12 with 17 pt text. One primary per view. Secondary is the outline
/// button (`--rule-strong` border).
struct VyreButtonStyle: ButtonStyle {
    var kind: ButtonKind = .secondary
    var fill = false
    var large = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        let radius: CGFloat = large ? 12 : Radius.card
        configuration.label
            .vyre(large ? .buttonLarge : .button)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .padding(.horizontal, Space.gutter)
            .frame(minHeight: large ? 54 : Space.target)
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
        case .beacon: .beaconInk
        }
    }
    private var background: Color {
        switch kind {
        case .primary: .primaryBg
        case .secondary: .clear
        case .quiet: .clear
        case .beacon: .beaconWash
        }
    }
}

extension ButtonStyle where Self == VyreButtonStyle {
    static var primary: VyreButtonStyle { VyreButtonStyle(kind: .primary) }
    static var secondary: VyreButtonStyle { VyreButtonStyle(kind: .secondary) }
    static var quiet: VyreButtonStyle { VyreButtonStyle(kind: .quiet) }
    static func vyre(_ kind: ButtonKind, fill: Bool = false, large: Bool = false) -> VyreButtonStyle { VyreButtonStyle(kind: kind, fill: fill, large: large) }
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

/// "Something failed" as a quiet line: Bone text with an Ash `failed` label (errors are not coral).
struct FailedLine: View {
    let text: String
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
            Engraved("failed")
            Text(text).vyre(.small).foregroundStyle(Color.text)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
