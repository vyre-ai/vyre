import SwiftUI
import UIKit

/// The type scale from TOKENS.md, drawn with the two bundled variable fonts. A weight is set on
/// the font's `wght` axis directly, so it never depends on how the system maps weight traits, and
/// every size scales with Dynamic Type through UIFontMetrics against the view's own size category.
enum TypeRole: CaseIterable, Sendable {
    case display, h1, h2, h3, title, body, small, label, button, code, codeSmall, hero

    var mono: Bool { [.label, .button, .code, .codeSmall, .hero].contains(self) }
    var size: CGFloat {
        switch self {
        case .display: 44 // 72 on desktop; a phone's display is H1 size.
        case .h1: 44 // TOKENS.md H1 44/48, as the PWA and the Android app set it
        case .h2: 28
        case .h3: 20
        case .title: 16
        case .body: 15
        case .small: 13
        case .label: 11
        case .button: 12
        case .code: 13
        case .codeSmall: 12
        case .hero: 22
        }
    }
    var lineHeight: CGFloat {
        switch self {
        case .display: 48
        case .h1: 48
        case .h2: 34
        case .h3: 26
        case .title: 22
        case .body: 22
        case .small: 18
        case .label: 14
        case .button: 16
        case .code: 20
        case .codeSmall: 16
        case .hero: 28
        }
    }
    var weight: CGFloat {
        switch self {
        case .display, .h1, .h2, .h3: 600
        case .title: 500
        case .label, .button, .hero: 500
        default: 400
        }
    }
    /// Tracking in em.
    var tracking: CGFloat {
        switch self {
        case .display: -0.035
        case .h1: -0.03
        case .h2: -0.02
        case .h3: -0.01
        case .label: 0.16
        case .button: 0.12
        case .hero: -0.02
        default: 0
        }
    }
    var uppercase: Bool { self == .label || self == .button }
    var textStyle: UIFont.TextStyle {
        switch self {
        case .display, .h1: .largeTitle
        case .h2: .title1
        case .h3: .title3
        case .title: .headline
        case .body: .body
        case .small, .code: .subheadline
        case .label, .button, .codeSmall: .caption1
        case .hero: .title2
        }
    }
}

enum VyreFonts {
    static let sansFile = "InstrumentSans"
    static let monoFile = "JetBrainsMono"
    private static let wghtAxis = 0x77676874 // 'wght'
    private static let wdthAxis = 0x77647468 // 'wdth'

    /// The unscaled font for a role, at an optional weight override.
    static func base(_ role: TypeRole, weight: CGFloat? = nil) -> UIFont {
        let family = role.mono ? "JetBrains Mono" : "Instrument Sans"
        var axes: [Int: CGFloat] = [wghtAxis: weight ?? role.weight]
        if !role.mono { axes[wdthAxis] = 100 }
        let desc = UIFontDescriptor(fontAttributes: [
            .family: family,
            UIFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String): axes,
        ])
        let font = UIFont(descriptor: desc, size: role.size)
        if font.familyName == family { return font }
        // The bundled fonts failed to register: fall back to the system's, same sizes.
        return role.mono ? .monospacedSystemFont(ofSize: role.size, weight: uiWeight(weight ?? role.weight))
            : .systemFont(ofSize: role.size, weight: uiWeight(weight ?? role.weight))
    }

    static func scaled(_ role: TypeRole, category: UIContentSizeCategory, weight: CGFloat? = nil) -> UIFont {
        let traits = UITraitCollection(preferredContentSizeCategory: category)
        return UIFontMetrics(forTextStyle: role.textStyle).scaledFont(for: base(role, weight: weight), compatibleWith: traits)
    }

    static func scale(_ value: CGFloat, _ role: TypeRole, category: UIContentSizeCategory) -> CGFloat {
        UIFontMetrics(forTextStyle: role.textStyle).scaledValue(for: value, compatibleWith: UITraitCollection(preferredContentSizeCategory: category))
    }

    private static func uiWeight(_ w: CGFloat) -> UIFont.Weight {
        switch w { case ..<450: .regular; case ..<550: .medium; default: .semibold }
    }
}

extension DynamicTypeSize {
    var category: UIContentSizeCategory {
        switch self {
        case .xSmall: .extraSmall
        case .small: .small
        case .medium: .medium
        case .large: .large
        case .xLarge: .extraLarge
        case .xxLarge: .extraExtraLarge
        case .xxxLarge: .extraExtraExtraLarge
        case .accessibility1: .accessibilityMedium
        case .accessibility2: .accessibilityLarge
        case .accessibility3: .accessibilityExtraLarge
        case .accessibility4: .accessibilityExtraExtraLarge
        case .accessibility5: .accessibilityExtraExtraExtraLarge
        @unknown default: .large
        }
    }
}

/// `.vyre(.body)`: the role's family, weight, size, line height and tracking, scaled with Dynamic Type.
struct VyreType: ViewModifier {
    @Environment(\.dynamicTypeSize) private var dts
    let role: TypeRole
    var weight: CGFloat?

    func body(content: Content) -> some View {
        let font = VyreFonts.scaled(role, category: dts.category, weight: weight)
        let line = VyreFonts.scale(role.lineHeight, role, category: dts.category)
        content
            .font(Font(font))
            .tracking(role.tracking * font.pointSize)
            .lineSpacing(max(0, line - font.lineHeight))
            .textCase(role.uppercase ? .uppercase : nil)
    }
}

extension View {
    func vyre(_ role: TypeRole, weight: CGFloat? = nil) -> some View { modifier(VyreType(role: role, weight: weight)) }
}

/// The engraved label: mono 11, uppercase, +0.16em, ash unless told otherwise.
struct Engraved: View {
    let text: String
    var color: Color = .ash
    init(_ text: String, color: Color = .ash) { self.text = text; self.color = color }
    var body: some View { Text(text).vyre(.label).foregroundStyle(color).accessibilityAddTraits(.isHeader) }
}
