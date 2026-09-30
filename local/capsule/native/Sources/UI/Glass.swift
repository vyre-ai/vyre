// Glass: the Capsule's Deep glass skin (team/0.2/capsule-02.html, Option B). It changes only the
// ground and the edge of the panel; the width, the rows and every feature are untouched, and the
// colours of text and the call to action still come from Theme (the tokens).
//
// Recipe: the system HUD material (blur and saturation come from the material, since
// NSVisualEffectView takes no radius) under a fixed-alpha carbon tint at 0.62, a 14% light border,
// a light top edge and a soft outer shadow. Under Reduce Transparency the ground is the plain opaque
// panel token, with no material.

import AppKit
import SwiftUI

enum Glass {
    /// The tint laid over the blur. Fixed, so text contrast does not depend on the wallpaper.
    static let tintAlpha: CGFloat = 0.62
    /// The opaque tint of the fallback (today's `panel` token at 1.0).
    static let opaqueAlpha: CGFloat = 1.0
    static let borderAlpha: Double = 0.14
    static let topEdgeAlpha: Double = 0.10

    /// Test seam: nil reads the system setting.
    nonisolated(unsafe) static var reduceTransparencyOverride: Bool?

    static var reduceTransparency: Bool {
        reduceTransparencyOverride ?? NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
    }

    /// The tint's alpha for the current setting.
    static var groundAlpha: CGFloat { reduceTransparency ? opaqueAlpha : tintAlpha }

    /// The panel's border: the glass border, or the plain rule when transparency is reduced.
    static var border: Color { reduceTransparency ? Theme.ruleStrong.opacity(0.9) : Theme.bone.opacity(borderAlpha) }
}

/// The panel's ground: the HUD material under the carbon tint. Reduced transparency drops the
/// material and paints the tint opaque.
struct Backdrop: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = .hudWindow
        v.blendingMode = .behindWindow
        v.state = .active
        v.appearance = NSAppearance(named: .darkAqua)
        let wash = NSView()
        wash.wantsLayer = true
        wash.autoresizingMask = [.width, .height]
        v.addSubview(wash)
        apply(v)
        return v
    }

    func updateNSView(_ v: NSVisualEffectView, context: Context) { apply(v) }

    private func apply(_ v: NSVisualEffectView) {
        let reduced = Glass.reduceTransparency
        v.state = reduced ? .inactive : .active
        v.isHidden = false
        v.subviews.first?.layer?.backgroundColor =
            NSColor(srgbRed: 0x16 / 255, green: 0x15 / 255, blue: 0x13 / 255, alpha: Glass.groundAlpha).cgColor
    }
}
