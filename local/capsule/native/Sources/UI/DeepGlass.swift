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

    /// Under an answer or its draft: a denser plate, so the words read on any wallpaper (WCAG AA,
    /// measured against the worst backdrop, pure white or black, before the material helps).
    static let plateAlpha: CGFloat = 0.85

    /// Test seams: nil reads the system setting.
    nonisolated(unsafe) static var reduceTransparencyOverride: Bool?
    nonisolated(unsafe) static var increaseContrastOverride: Bool?

    static var increaseContrast: Bool {
        increaseContrastOverride ?? NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast
    }

    /// The border's width: heavier under Increase Contrast.
    static var borderWidth: CGFloat { increaseContrast ? 2 : 1 }

    /// The plate under answer text, alpha for the setting.
    static var plateGroundAlpha: CGFloat { reduceTransparency ? opaqueAlpha : plateAlpha }

    /// WCAG contrast ratio of two sRGB colours (components 0...1).
    static func contrast(_ a: [Double], _ b: [Double]) -> Double {
        func lin(_ c: Double) -> Double { c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        func lum(_ x: [Double]) -> Double { 0.2126 * lin(x[0]) + 0.7152 * lin(x[1]) + 0.0722 * lin(x[2]) }
        let (hi, lo) = (max(lum(a), lum(b)), min(lum(a), lum(b)))
        return (hi + 0.05) / (lo + 0.05)
    }

    static var reduceTransparency: Bool {
        reduceTransparencyOverride ?? NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
    }

    /// The tint's alpha for the setting and the scheme.
    static func groundAlpha(dark: Bool) -> CGFloat { reduceTransparency ? opaqueAlpha : (dark ? tintAlpha : tintAlphaLight) }

    /// The panel's border: the glass border, or the plain rule when transparency is reduced.
    static func border(dark: Bool) -> Color {
        // Increase Contrast: a strong edge, in the text colour (3:1 against either ground).
        if increaseContrast { return Theme.bone.opacity(0.7) }
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
    /// Taken from the view's own state, so a change in System Settings redraws it at once
    /// (DisplayPrefs publishes it); the static setting is read when this is built.
    var reduced = DeepGlass.reduceTransparency

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
        v.state = reduced ? .inactive : .active
        let tint = NSColor(dark ? Tokens.dark.panel : Tokens.paper.panel)
        // Set the layer's colour under this view's own appearance, so it does not lag a switch.
        v.subviews.first?.layer?.backgroundColor = tint.withAlphaComponent(reduced ? DeepGlass.opaqueAlpha : (dark ? DeepGlass.tintAlpha : DeepGlass.tintAlphaLight)).cgColor
    }
}

/// The display settings the skin follows, live: Reduce Transparency and Increase Contrast. Views
/// observe this so a change in System Settings redraws the open panel without a relaunch.
@MainActor
final class DisplayPrefs: ObservableObject {
    static let shared = DisplayPrefs()
    @Published private(set) var reduceTransparency = DeepGlass.reduceTransparency
    @Published private(set) var increaseContrast = DeepGlass.increaseContrast
    private var token: NSObjectProtocol?

    init() {
        token = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    deinit { if let token { NSWorkspace.shared.notificationCenter.removeObserver(token) } }

    func refresh() {
        reduceTransparency = DeepGlass.reduceTransparency
        increaseContrast = DeepGlass.increaseContrast
    }
}

/// The plate under an answer or a draft: the panel tint at a fixed dense alpha, behind the text and
/// out past its edges without moving it.
struct AnswerPlate: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    func body(content: Content) -> some View {
        let tint = scheme == .dark ? Tokens.dark.panel : Tokens.paper.panel
        content.background {
            RoundedRectangle(cornerRadius: 8, style: .continuous).fill(tint.opacity(Double(DeepGlass.plateGroundAlpha)))
                .padding(EdgeInsets(top: -4, leading: -8, bottom: -4, trailing: -8))
        }
    }
}

extension View { func answerPlate() -> some View { modifier(AnswerPlate()) } }
