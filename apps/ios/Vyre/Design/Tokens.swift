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
    static let signalDark = UIColor(hex: 0xC6F36B)
    static let recallDark = UIColor(hex: 0xEBC76B)
    static let beaconDark = UIColor(hex: 0xFF7A59)

    static let paper = UIColor(hex: 0xF4F1EA)
    static let paperRaised = UIColor(hex: 0xFBFAF6)
    static let paperRule = UIColor(hex: 0xDCD7CC)
    static let paperRuleStrong = UIColor(hex: 0xC9C3B7)
    static let ink = UIColor(hex: 0x141311)
    static let ink2 = UIColor(hex: 0x4A463F)
    static let ink3 = UIColor(hex: 0x6B665D)
    static let signalDeep = UIColor(hex: 0x46700C)
    static let recallDeep = UIColor(hex: 0x7E5B0C)
    static let beaconDeep = UIColor(hex: 0xC2411F)
    static let beaconDotPaper = UIColor(hex: 0xE5532F)

    static func pair(_ dark: UIColor, _ light: UIColor) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .light ? light : dark })
    }
}

extension Color {
    /// Page ground.
    static let ground = Tone.pair(Tone.graphite, Tone.paper)
    /// Panels, sheets, the composer. One step up from ground.
    static let panel = Tone.pair(Tone.carbon, Tone.paperRaised)
    /// Pressed rows, popovers. Rarely.
    static let raised = Tone.pair(Tone.raisedDark, Tone.paperRaised)
    static let rule = Tone.pair(Tone.ruleDark, Tone.paperRule)
    static let ruleStrong = Tone.pair(Tone.ruleStrongDark, Tone.paperRuleStrong)
    /// Engraved labels, captions, placeholders. The smallest text colour allowed.
    static let ash = Tone.pair(Tone.ashDark, Tone.ink3)
    /// Secondary text.
    static let stone = Tone.pair(Tone.stoneDark, Tone.ink2)
    /// Primary text.
    static let bone = Tone.pair(Tone.boneDark, Tone.ink)
    /// Focus and the one primary action per screen. Text and rings.
    static let signal = Tone.pair(Tone.signalDark, Tone.signalDeep)
    /// The fill of the one primary button: Signal on dark, Ink on paper.
    static let signalFill = Tone.pair(Tone.signalDark, Tone.ink)
    /// Text on the primary fill.
    static let signalInk = Tone.pair(Tone.graphite, Tone.paper)
    static let signalWash = Tone.pair(UIColor(hex: 0xC6F36B, alpha: 0.12), UIColor(hex: 0x46700C, alpha: 0.10))
    /// Came from memory; no model was used.
    static let recall = Tone.pair(Tone.recallDark, Tone.recallDeep)
    static let recallWash = Tone.pair(UIColor(hex: 0xEBC76B, alpha: 0.10), UIColor(hex: 0xEBC76B, alpha: 0.10))
    /// Needs you. Held items, asks, the badge. Nothing else.
    static let beacon = Tone.pair(Tone.beaconDark, Tone.beaconDeep)
    static let beaconDot = Tone.pair(Tone.beaconDark, Tone.beaconDotPaper)
    static let beaconWash = Tone.pair(UIColor(hex: 0xFF7A59, alpha: 0.12), UIColor(hex: 0xFF7A59, alpha: 0.12))
    /// The mark's dot: Signal on dark, Ink on paper.
    static let markDot = Tone.pair(Tone.signalDark, Tone.ink)
    /// Code blocks sit on carbon in both themes' spirit: carbon on dark, raised paper on paper.
    static let codeGround = Tone.pair(Tone.carbon, Tone.paperRaised)
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
    static let button: CGFloat = 6
    static let panel: CGFloat = 10
    static let window: CGFloat = 14
}
