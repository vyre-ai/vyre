// Theme: the design tokens as SwiftUI values. Colours, status and radius come from
// Tokens.generated.swift, which scripts/gen-tokens writes from docs/design/one-app/tokens.json, the
// one source the app and the Deck read too (Direction A). Views use these, never a literal colour
// or size. The geometry below is the Capsule's own (Spotlight's), and so is recall.

import AppKit
import SwiftUI

public enum Theme {
    static func hex(_ v: Int) -> Color {
        Color(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }

    // Colours, dark (the Capsule is always dark, like Spotlight over a dark desktop).
    static let c = Tokens.dark
    public static let graphite = c.bg
    public static let carbon = c.panel
    public static let raised = c.hover
    public static let rule = c.rule
    public static let ruleStrong = c.ruleStrong
    public static let ash = c.label
    public static let stone = c.text2
    public static let bone = c.text
    public static let signal = c.focus
    /// Memory's colour, the Capsule's own: tokens.json has no recall key.
    public static let recall = hex(0xEBC76B)
    /// The "needs you" colour: beacon (violet), the same as the Deck and the phone.
    public static let attention = c.beacon

    /// A status row's word and colour from the shared status model, most urgent first.
    public static func status(_ key: String) -> (word: String, color: Color)? {
        guard let s = Tokens.status.first(where: { $0.key == key }) else { return nil }
        return (s.word, color(s.color))
    }

    /// A colour by its tokens.json key (the status model names them).
    public static func color(_ key: String) -> Color {
        switch key {
        case "beacon": return c.beacon
        case "focus": return c.focus
        case "text": return c.text
        case "text2": return c.text2
        case "label": return c.label
        default: return c.text2
        }
    }

    public static func tint(_ t: Tint) -> Color {
        switch t {
        case .bone: return bone
        case .stone: return stone
        case .ash: return ash
        case .signal: return signal
        case .recall: return recall
        case .attention: return attention
        }
    }

    // The panel (docs/design/system/capsule.md, "The panel"): 680 wide, 560 at most, a 56 bar,
    // rows 44 (the touch size), group headers 28, the footer 32, the top edge about 22% down.
    public static let width: CGFloat = 680
    public static let maxHeight: CGFloat = 560
    public static let barHeight: CGFloat = 56
    public static let rowHeight: CGFloat = Tokens.Control.touch
    public static let headerHeight: CGFloat = Tokens.Control.xs
    public static let footerHeight: CGFloat = Tokens.Control.sm
    public static let maxRows = 9
    public static let topFraction: CGFloat = 0.22
    public static let radius: CGFloat = Tokens.Radius.sheet
    public static let iconSize: CGFloat = 24
    /// The side padding of the bar, headers, rows and footer.
    public static let inset: CGFloat = Tokens.space[5]

    // Type: the scale in tokens.json (meta 12/16, base 13/18, read 15/22, title 20/26). SF for
    // words, SF Mono for names that are code.
    static func type(_ s: (size: CGFloat, line: CGFloat), _ weight: Font.Weight = .regular, design: Font.Design = .default) -> Font {
        Font.system(size: s.size, weight: weight, design: design)
    }
    /// The gap SwiftUI adds between lines so a size sits on its token's line height.
    static func lineGap(_ s: (size: CGFloat, line: CGFloat)) -> CGFloat {
        let f = NSFont.systemFont(ofSize: s.size)
        return max(0, s.line - (f.ascender - f.descender + f.leading).rounded(.up))
    }
    /// The field: read, 15/22.
    public static let query = type(Tokens.TypeScale.read)
    /// A row's title: base, 13/18.
    public static let title = type(Tokens.TypeScale.base)
    /// Meta: 12/16.
    public static let subtitle = type(Tokens.TypeScale.meta)
    /// A group header and small labels: 12/16 semibold, drawn as written (sentence case).
    public static let label = type(Tokens.TypeScale.meta, .semibold)
    /// Answer prose: read, 15/22.
    public static let reply = type(Tokens.TypeScale.read)
    /// A name that is code (an address, a tool): base in mono.
    public static let mono = type(Tokens.TypeScale.base, design: .monospaced)
    /// One line of an answer (the reply font and its line height), for scrolling by lines.
    public static let readLine: CGFloat = Tokens.TypeScale.read.line
}
