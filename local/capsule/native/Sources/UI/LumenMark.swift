// LumenMark: the Lumen lens glyph, drawn in the panel's own colours (Core/LumenMotion.swift has its
// geometry and timing). One ring with a round gap and a bead of light. On every summon the ring is
// stroked in and the bead fades up; with Reduce Motion it is simply there.

import AppKit
import SwiftUI

struct LumenMark: View {
    let size: CGFloat
    /// How much of the ring is drawn and how bright the bead is, 0 to 1. Both 1 at rest.
    var ring: Double = 1
    var bead: Double = 1
    var beadColor: Color = Theme.bone

    var body: some View {
        Canvas { ctx, sz in
            let k = sz.width / LumenGlyph.grid
            let c = LumenGlyph.ringCentre, r = LumenGlyph.ringRadius
            // The ring, cut where the bead sits: clip out the gap circle (even-odd over the whole square).
            var clip = Path(CGRect(x: 0, y: 0, width: sz.width, height: sz.height))
            let g = LumenGlyph.gapRadius, b = LumenGlyph.beadCentre
            clip.addEllipse(in: CGRect(x: (b.x - g) * k, y: (b.y - g) * k, width: 2 * g * k, height: 2 * g * k))
            var layer = ctx
            layer.clip(to: clip, style: FillStyle(eoFill: true))
            // Drawn from the gap round the long way: the first stroke lands where the ring ends.
            let start = Angle(radians: atan2(Double(b.y - c.y), Double(b.x - c.x)))
            var arc = Path()
            arc.addArc(center: CGPoint(x: c.x * k, y: c.y * k), radius: r * k, startAngle: start, endAngle: start + .degrees(360 * max(0.001, ring)), clockwise: false)
            layer.stroke(arc, with: .color(Theme.bone), style: StrokeStyle(lineWidth: LumenGlyph.ringStroke * k, lineCap: .round))
            let br = LumenGlyph.beadRadius * k
            ctx.fill(Path(ellipseIn: CGRect(x: b.x * k - br, y: b.y * k - br, width: 2 * br, height: 2 * br)), with: .color(beadColor.opacity(bead)))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    /// The glyph as a one-colour template image for the menu bar: the system tints it for light and dark.
    /// `bead` is painted in `beadColor` only when it is not a template (an attention mark).
    static func menuBarImage(points: CGFloat = 18, beadColor: NSColor? = nil, beadScale: CGFloat = 1) -> NSImage {
        let img = NSImage(size: NSSize(width: points, height: points), flipped: true) { r in
            let k = r.width / LumenGlyph.grid
            let c = LumenGlyph.ringCentre, rad = LumenGlyph.ringRadius, b = LumenGlyph.beadCentre
            NSGraphicsContext.saveGraphicsState()
            let clip = NSBezierPath(rect: r)
            clip.appendOval(in: NSRect(x: (b.x - LumenGlyph.gapRadius) * k, y: (b.y - LumenGlyph.gapRadius) * k,
                                       width: 2 * LumenGlyph.gapRadius * k, height: 2 * LumenGlyph.gapRadius * k))
            clip.windingRule = .evenOdd
            clip.addClip()
            let ring = NSBezierPath(ovalIn: NSRect(x: (c.x - rad) * k, y: (c.y - rad) * k, width: 2 * rad * k, height: 2 * rad * k))
            ring.lineWidth = LumenGlyph.ringStroke * k
            (beadColor == nil ? NSColor.black : NSColor.labelColor).setStroke()
            ring.stroke()
            NSGraphicsContext.restoreGraphicsState()
            let br = LumenGlyph.beadRadius * k * beadScale
            (beadColor ?? NSColor.black).setFill()
            NSBezierPath(ovalIn: NSRect(x: b.x * k - br, y: b.y * k - br, width: 2 * br, height: 2 * br)).fill()
            return true
        }
        img.isTemplate = beadColor == nil
        return img
    }
}

/// The bar's lens: drawn in on every summon (`replay` changes), at once under Reduce Motion.
struct SummonMark: View {
    let size: CGFloat
    let replay: Int
    @State private var ring = 1.0
    @State private var bead = 1.0

    var body: some View {
        LumenMark(size: size, ring: ring, bead: bead)
            .onChange(of: replay) { play() }
    }

    private func play() {
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { ring = 1; bead = 1; return }
        ring = 0; bead = 0
        withAnimation(.easeOut(duration: 0.26).delay(0.06)) { ring = 1 }
        withAnimation(.easeIn(duration: 0.16).delay(0.26)) { bead = 1 }
    }
}
