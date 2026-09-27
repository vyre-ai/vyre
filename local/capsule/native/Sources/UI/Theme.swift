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

    // Spotlight's geometry: 680 wide, a 56 px bar, results below, the top edge about 22% down.
    public static let width: CGFloat = 680
    public static let barHeight: CGFloat = 56
    public static let rowHeight: CGFloat = 40
    public static let headerHeight: CGFloat = 26
    public static let maxRows = 9
    public static let topFraction: CGFloat = 0.22
    public static let radius: CGFloat = Tokens.Radius.card
    public static let iconSize: CGFloat = 24

    // Type: SF for words, SF Mono for labels and keys.
    public static let query = Font.system(size: 22, weight: .regular)
    public static let title = Font.system(size: 14, weight: .regular)
    public static let subtitle = Font.system(size: 12, weight: .regular)
    public static let label = Font.system(size: 10.5, weight: .medium, design: .monospaced)
    public static let reply = Font.system(size: 14, weight: .regular)
    /// One line of an answer (the reply font and its spacing), for scrolling by lines.
    public static let readLine: CGFloat = 20
}
