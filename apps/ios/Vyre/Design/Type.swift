import SwiftUI
import UIKit

/// The type roles from docs/design/phone.md section 2, drawn with the two bundled variable fonts.
/// Sans for everything a person reads; mono only for commands, code and logs. Buttons and labels
/// are sentence-case sans on the phone (the one place it departs from TOKENS.md). A weight is set
/// on the font's `wght` axis directly, and every size scales with Dynamic Type through
/// UIFontMetrics against the view's own size category. Sizes are the default "Large" size.
enum TypeRole: CaseIterable, Sendable {
    case display, h1, h2, h3
    /// Page 22/28 600: the page labels in the header.
    case page
    /// Sheet title 26/32 600.
    case sheetTitle
    /// Section 20/25 600: section headers on Now.
    case section
    /// Group 17/22 600: group headers in Find and Agents, the chat nav title, agent names.
    case title
    /// Row title 16/21 600: rows in cards.
    case rowTitle
    /// Lead 17/24: chat messages, a question's text.
    case lead
    /// Input 17/22: search and composer text (never under 16).
    case input
    /// Body 16/23.
    case body
    /// Secondary 15/20: row second lines, fact rows.
    case secondary
    /// Meta 13/18: "kit · Harlow Legal", times, hints.
    case small
    /// Micro 12/16: the chat nav subtitle, tags.
    case micro
    /// A small label over a group: 13/18 600 sans, sentence case.
    case label
    /// Button 15/20 600 sans, sentence case (17 on the 54 tall primary).
    case button
    case buttonLarge
    /// Command 14/20 mono, in blocks.
    case code
    /// Command 13/18 mono, in rows and tool rows.
    case commandRow
    /// Log 12/19 mono: the live console, diffs.
    case codeSmall
    case hero

    static let meta = TypeRole.small
    static let group = TypeRole.title
    static let command = TypeRole.code
    static let log = TypeRole.codeSmall

    var mono: Bool { [.code, .commandRow, .codeSmall, .hero].contains(self) }
    var size: CGFloat {
        switch self {
        case .display: 44
        case .h1: 44
        case .h2: 28
        case .h3: 20
        case .page: 22
        case .sheetTitle: 26
        case .section: 20
        case .title: 17
        case .rowTitle: 16
        case .lead: 17
        case .input: 17
        case .body: 16
        case .secondary: 15
        case .small: 13
        case .micro: 12
        case .label: 13
        case .button: 15
        case .buttonLarge: 17
        case .code: 14
        case .commandRow: 13
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
        case .page: 28
        case .sheetTitle: 32
        case .section: 25
        case .title: 22
        case .rowTitle: 21
        case .lead: 24
        case .input: 22
        case .body: 23
        case .secondary: 20
        case .small: 18
        case .micro: 16
        case .label: 18
        case .button: 20
        case .buttonLarge: 22
        case .code: 20
        case .commandRow: 18
        case .codeSmall: 19
        case .hero: 28
        }
    }
    var weight: CGFloat {
        switch self {
        case .display, .h1, .h2, .h3, .page, .sheetTitle, .section, .title, .rowTitle, .label, .button, .buttonLarge: 600
        case .hero: 500
        default: 400
        }
    }
    /// Tracking in em.
    var tracking: CGFloat {
        switch self {
        case .display: -0.035
        case .h1: -0.03
        case .h2: -0.02
        case .page, .sheetTitle: -0.015
        case .h3: -0.01
        case .hero: -0.02
        default: 0
        }
    }
    var uppercase: Bool { false }
    var textStyle: UIFont.TextStyle {
        switch self {
        case .display, .h1: .largeTitle
        case .h2, .sheetTitle: .title1
        case .h3, .page, .section: .title3
        case .title, .rowTitle, .buttonLarge: .headline
        case .lead, .input, .body: .body
        case .secondary, .button: .callout
        case .small, .label, .code, .commandRow: .subheadline
        case .micro, .codeSmall: .caption1
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

/// A small label over a group: 13/600 sans, sentence case, `--label` unless told otherwise.
struct Engraved: View {
    let text: String
    var color: Color = .label
    init(_ text: String, color: Color = .label) { self.text = text; self.color = color }
    var body: some View { Text(text).vyre(.label).foregroundStyle(color).accessibilityAddTraits(.isHeader) }
}
