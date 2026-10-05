import SwiftUI
import UIKit

/// The colours from docs/design/TOKENS.md, verbatim. Each token resolves to the dark value or the
/// paper value by the trait collection, so the whole app follows the system (or the Settings
/// override, applied as a preferred colour scheme at the root). No colour outside this file.
enum Tone {
    static let graphite = UIColor(hex: 0x0E0D0C)
    static let carbon = UIColor(hex: 0x161513)
    static let raisedDark = UIColor(hex: 0x1E1C1A)
    static let ruleDark = UIColor(hex: 0x2B2926)
    static let ruleStrongDark = UIColor(hex: 0x3A3733)
    static let ashDark = UIColor(hex: 0x8C877D)
    static let stoneDark = UIColor(hex: 0xB3AEA4)
    static let boneDark = UIColor(hex: 0xF1EEE6)
    static let signalDark = UIColor(hex: 0xF1EEE6)
    static let recallDark = UIColor(hex: 0xEBC76B)
    /// Attention ("needs you"), violet since 27 Sep 2026. The one place it is set: every beacon
    /// role below derives from this pair, so a different pick is a two-line change.
    static let attentionDark: UInt32 = 0xB8A4FF
    static let attentionPaper: UInt32 = 0x5B3FC4

    static let paper = UIColor(hex: 0xF4F1EA)
    static let paperRaised = UIColor(hex: 0xFBFAF6)
    static let paperRule = UIColor(hex: 0xDCD7CC)
    static let paperRuleStrong = UIColor(hex: 0xC9C3B7)
    static let ink = UIColor(hex: 0x141311)
    static let ink2 = UIColor(hex: 0x4A463F)
    static let ink3 = UIColor(hex: 0x6B665D)
    static let signalDeep = UIColor(hex: 0x141311)
    static let recallDeep = UIColor(hex: 0x7E5B0C)

    static func pair(_ dark: UIColor, _ light: UIColor) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .light ? light : dark })
    }
}

/// The colour roles, named as the Deck names them (deck/css/deck.css; docs/design/phone.md
/// section 2), so a phone view and a Deck view read the same variables. Values verbatim.
extension Color {
    /// `--bg`: page ground.
    static let bg = Tone.pair(Tone.graphite, Tone.paper)
    /// `--panel`: cards, sheets, the Capsule.
    static let panel = Tone.pair(Tone.carbon, Tone.paperRaised)
    /// `--hover`: agent tiles, pressed rows, the Deny reveal.
    static let hover = Tone.pair(Tone.raisedDark, UIColor(hex: 0x141311, alpha: 0.045))
    /// `--rule`: hairlines between rows.
    static let rule = Tone.pair(Tone.ruleDark, Tone.paperRule)
    /// `--rule-strong`: card and input borders, outline buttons.
    static let ruleStrong = Tone.pair(Tone.ruleStrongDark, Tone.paperRuleStrong)
    /// `--text`: primary text.
    static let text = Tone.pair(Tone.boneDark, Tone.ink)
    /// `--text-2`: secondary text.
    static let text2 = Tone.pair(Tone.stoneDark, Tone.ink2)
    /// `--label`: labels, meta, placeholders. The smallest text colour allowed.
    static let label = Tone.pair(Tone.ashDark, Tone.ink3)
    /// `--primary-bg`: the fill of the one primary button per view.
    static let primaryBg = Tone.pair(Tone.signalDark, Tone.ink)
    /// `--primary-ink`: text on the primary fill.
    static let primaryInk = Tone.pair(Tone.graphite, Tone.paper)
    /// `--focus`: the focus ring, and Signal where the design system uses it as text.
    static let focus = Tone.pair(Tone.signalDark, Tone.signalDeep)
    /// `--signal-wash`: the Ask row in Find, added diff lines.
    static let signalWash = Tone.pair(UIColor(hex: 0xF1EEE6, alpha: 0.12), UIColor(hex: 0x141311, alpha: 0.10))
    /// `--match` (phone): search match highlight, the Open session flash.
    static let match = Tone.pair(UIColor(hex: 0xF1EEE6, alpha: 0.20), UIColor(hex: 0x141311, alpha: 0.16))
    /// `--beacon-ink`: needs you, as a label. Nothing else.
    static let beaconInk = Tone.pair(UIColor(hex: Tone.attentionDark), UIColor(hex: Tone.attentionPaper))
    /// `--beacon-dot`: needs you, as a dot or a badge.
    static let beaconDot = beaconInk
    /// `--beacon-wash`: not used on the phone (held, ask and question cards are neutral).
    static let beaconWash = Tone.pair(UIColor(hex: Tone.attentionDark, alpha: 0.12), UIColor(hex: Tone.attentionPaper, alpha: 0.08))
    /// `--recall`: came from memory; no model was used.
    static let recall = Tone.pair(Tone.recallDark, Tone.recallDeep)
    /// `--recall-wash`: behind a recalled block.
    static let recallWash = Tone.pair(UIColor(hex: 0xEBC76B, alpha: 0.10), UIColor(hex: 0x7E5B0C, alpha: 0.08))
    /// `--del-wash`: deleted diff lines, with `--text-2` text (`--label` is 4.49:1 there).
    static let delWash = Tone.pair(UIColor(hex: 0x8C877D, alpha: 0.14), UIColor(hex: 0x6B665D, alpha: 0.10))
    /// `--code-bg`: command blocks, the live console.
    static let codeBg = Tone.pair(UIColor(hex: 0x0E0D0C, alpha: 0.55), UIColor(hex: 0x141311, alpha: 0.04))
    /// A command block in a sheet or card: `--code-bg` on dark, `--bg` on paper (phone.md sections 5, 6).
    static let blockBg = Tone.pair(UIColor(hex: 0x0E0D0C, alpha: 0.55), Tone.paper)
    /// `--mark-wire` / `--mark-dot`.
    static let markWire = Tone.pair(Tone.boneDark, Tone.ink)
    static let markDot = Tone.pair(Tone.signalDark, Tone.ink)
    /// `--scrim` (phone): behind a sheet.
    static let scrim = Tone.pair(UIColor(hex: 0x000000, alpha: 0.62), UIColor(hex: 0x141311, alpha: 0.34))
}

extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }
}

/// Spacing on a 4 px base, and the four radii.
enum Space {
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let gutter: CGFloat = 16
    static let l: CGFloat = 24
    static let xl: CGFloat = 32
    static let xxl: CGFloat = 48
    /// The smallest tap target.
    static let target: CGFloat = 44
}

enum Radius {
    static let chip: CGFloat = 4
    /// Filter chips, agent tiles at 32 px, code blocks in sheets.
    static let tile: CGFloat = 8
    static let button: CGFloat = 6
    static let card: CGFloat = 10
    static let panel: CGFloat = 10
    static let window: CGFloat = 14
    static let sheet: CGFloat = 14
    static let bubble: CGFloat = 18
}
