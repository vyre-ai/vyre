import SwiftUI

/// A 1 px hairline. The default separator; rules, not nested boxes.
struct Hairline: View {
    var strong = false
    var body: some View {
        Rectangle().fill(strong ? Color.ruleStrong : Color.rule).frame(height: 1).accessibilityHidden(true)
    }
}

enum ButtonKind { case primary, secondary, quiet, beacon }

/// Buttons are mono 12 uppercase +0.12em. One primary (Signal) per screen.
struct VyreButtonStyle: ButtonStyle {
    var kind: ButtonKind = .secondary
    var fill = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .vyre(.button)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .padding(.horizontal, Space.gutter)
            .frame(minHeight: Space.target)
            .frame(maxWidth: fill ? .infinity : nil)
            .foregroundStyle(foreground)
            .background(background.opacity(configuration.isPressed ? 0.85 : 1), in: RoundedRectangle(cornerRadius: Radius.button))
            .overlay {
                if kind == .secondary { RoundedRectangle(cornerRadius: Radius.button).strokeBorder(Color.ruleStrong, lineWidth: 1) }
            }
            .opacity(enabled ? 1 : 0.45)
            .contentShape(Rectangle())
    }

    private var foreground: Color {
        switch kind {
        case .primary: .signalInk
        case .secondary, .quiet: .bone
        case .beacon: .beacon
        }
    }
    private var background: Color {
        switch kind {
        case .primary: .signalFill
        case .secondary: .panel
        case .quiet: .clear
        case .beacon: .beaconWash
        }
    }
}

extension ButtonStyle where Self == VyreButtonStyle {
    static var primary: VyreButtonStyle { VyreButtonStyle(kind: .primary) }
    static var secondary: VyreButtonStyle { VyreButtonStyle(kind: .secondary) }
    static var quiet: VyreButtonStyle { VyreButtonStyle(kind: .quiet) }
    static func vyre(_ kind: ButtonKind, fill: Bool = false) -> VyreButtonStyle { VyreButtonStyle(kind: kind, fill: fill) }
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
    var color: Color = .ash
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
        content.background(Color.ground.ignoresSafeArea())
    }
}

extension View {
    func vyreGround() -> some View { modifier(Ground()) }

    /// Standard navigation bar look: ground-coloured, hairline below.
    func vyreNavBar() -> some View {
        self.toolbarBackground(Color.ground, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
    }
}

/// "Something failed" as a quiet line: Bone text with an Ash `failed` label (errors are not coral).
struct FailedLine: View {
    let text: String
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
            Engraved("failed")
            Text(text).vyre(.small).foregroundStyle(Color.bone)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// An empty state: one plain sentence, ash.
struct EmptyLine: View {
    let text: String
    var body: some View {
        Text(text).vyre(.small).foregroundStyle(Color.ash).frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, Space.m)
    }
}
