// Theme: the design tokens (docs/design/TOKENS.md) as SwiftUI values. Views use these, never a
// literal colour or size, so the Capsule, the menu-bar popover and mobile read as one thing.

import AppKit
import SwiftUI

public enum Theme {
    static func hex(_ v: Int) -> Color {
        Color(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }

    // Colours, dark (the Capsule is always dark, like Spotlight over a dark desktop).
    public static let graphite = hex(0x0E0D0C)
    public static let carbon = hex(0x161513)
    public static let raised = hex(0x1E1C1A)
    public static let rule = hex(0x2B2926)
    public static let ruleStrong = hex(0x3A3733)
    public static let ash = hex(0x8C877D)
    public static let stone = hex(0xB3AEA4)
    public static let bone = hex(0xF1EEE6)
    public static let signal = hex(0xC6F36B)
    public static let recall = hex(0xEBC76B)
    public static let beacon = hex(0xFF7A59)

    public static func tint(_ t: Tint) -> Color {
        switch t {
        case .bone: return bone
        case .stone: return stone
        case .ash: return ash
        case .signal: return signal
        case .recall: return recall
        case .beacon: return beacon
        }
    }

    // Spotlight's geometry: 680 wide, a 56 px bar, results below, the top edge about 22% down.
    public static let width: CGFloat = 680
    public static let barHeight: CGFloat = 56
    public static let rowHeight: CGFloat = 40
    public static let headerHeight: CGFloat = 26
    public static let maxRows = 9
    public static let topFraction: CGFloat = 0.22
    public static let radius: CGFloat = 12
    public static let iconSize: CGFloat = 24

    // Type: SF for words, SF Mono for labels and keys.
    public static let query = Font.system(size: 22, weight: .regular)
    public static let title = Font.system(size: 14, weight: .regular)
    public static let subtitle = Font.system(size: 12, weight: .regular)
    public static let label = Font.system(size: 10.5, weight: .medium, design: .monospaced)
    public static let reply = Font.system(size: 14, weight: .regular)
}
