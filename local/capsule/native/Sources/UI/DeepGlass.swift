// DeepGlass: the Capsule's Deep glass skin (team/0.2/capsule-02.html, Option B). It changes only the
// ground and the edge of the panel; the width, the rows and every feature are untouched, and the
// colours of text and the call to action still come from Theme (the tokens).
//
// Recipe: a system material (blur and saturation come from the material, since
// NSVisualEffectView takes no radius) under a fixed-alpha tint of the panel token: dark 0.62 with a
// 14% light border, light (paper) 0.66 with a 10% dark border, a light top edge and a soft outer
// shadow. It follows the system appearance. Under Reduce Transparency the ground is the plain
// opaque panel token, with no material.

import AppKit
import SwiftUI

enum DeepGlass {
    /// The tint laid over the blur. Fixed, so text contrast does not depend on the wallpaper.
    static let tintAlpha: CGFloat = 0.62
    static let tintAlphaLight: CGFloat = 0.66
    /// The opaque tint of the fallback (today's `panel` token at 1.0).
    static let opaqueAlpha: CGFloat = 1.0
    static let borderAlpha: Double = 0.14
    static let borderAlphaLight: Double = 0.10
    static let topEdgeAlpha: Double = 0.10
    static let topEdgeAlphaLight: Double = 0.60

    /// Test seam: nil reads the system setting.
    nonisolated(unsafe) static var reduceTransparencyOverride: Bool?

    static var reduceTransparency: Bool {
        reduceTransparencyOverride ?? NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
    }

    /// The tint's alpha for the setting and the scheme.
    static func groundAlpha(dark: Bool) -> CGFloat { reduceTransparency ? opaqueAlpha : (dark ? tintAlpha : tintAlphaLight) }

    /// The panel's border: the glass border, or the plain rule when transparency is reduced.
    static func border(dark: Bool) -> Color {
        if reduceTransparency { return Theme.ruleStrong.opacity(0.9) }
        return Theme.bone.opacity(dark ? borderAlpha : borderAlphaLight)
    }

    /// The light along the top edge: white glass in the light scheme, bone in the dark.
    static func topEdge(dark: Bool) -> Color { dark ? Theme.bone.opacity(topEdgeAlpha) : Color.white.opacity(topEdgeAlphaLight) }

    /// The material under the tint.
    static func material(dark: Bool) -> NSVisualEffectView.Material { dark ? .hudWindow : .popover }
}

/// The panel's ground: a system material under the panel token's tint. Reduced transparency drops
/// the material and paints the tint opaque.
struct Backdrop: NSViewRepresentable {
    @Environment(\.colorScheme) private var scheme

    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.blendingMode = .behindWindow
        let wash = NSView()
        wash.wantsLayer = true
        wash.autoresizingMask = [.width, .height]
        v.addSubview(wash)
        apply(v)
        return v
    }

    func updateNSView(_ v: NSVisualEffectView, context: Context) { apply(v) }

    private func apply(_ v: NSVisualEffectView) {
        let dark = scheme == .dark
        v.material = DeepGlass.material(dark: dark)
        v.state = DeepGlass.reduceTransparency ? .inactive : .active
        let tint = NSColor(dark ? Tokens.dark.panel : Tokens.paper.panel)
        // Set the layer's colour under this view's own appearance, so it does not lag a switch.
        v.subviews.first?.layer?.backgroundColor = tint.withAlphaComponent(DeepGlass.groundAlpha(dark: dark)).cgColor
    }
}
