// LumenMotion: the Lumen lens glyph's geometry and its two moments of motion (app-design, docs/design/
// brand/README.md "Motion (Lumen)"). Pure numbers, so the timelines are tested; the views only read them.
//
// The glyph, on a 1024 grid: a ring (centre 480,548, radius 340, stroke 112) with a round gap cut where
// a bead of light (centre 716,308, radius 98) sits. One colour.
//
// Summon (every time): the bar arrives over 220 ms (opacity, and a 4 pt rise); the lens draws in it: the
// ring is stroked round over 260 ms from 60 ms, the bead fades in at 260 ms over 160 ms. Dismiss is a
// plain fade. Open (first launch): the tile eases in (320 ms, from 94%), the flare blooms from 380 ms over
// 260 ms, the "Vyre Lumen" lockup slides in 8 pt and fades in from 640 ms over 300 ms, and everything
// fades out over the last 300 ms of 1.6 s. Reduced motion: everything shown at once.

import CoreGraphics
import Foundation

public enum LumenGlyph {
    public static let grid: CGFloat = 1024
    public static let ringCentre = CGPoint(x: 480, y: 548)
    public static let ringRadius: CGFloat = 340
    public static let ringStroke: CGFloat = 112
    public static let beadCentre = CGPoint(x: 716, y: 308)
    public static let beadRadius: CGFloat = 98
    /// The round cut in the ring around the bead.
    public static let gapRadius: CGFloat = 150
}

public enum LumenMotion {
    public static func clamp(_ x: Double) -> Double { min(1, max(0, x)) }
    public static func easeOut(_ x: Double) -> Double { 1 - pow(1 - clamp(x), 3) }

    // MARK: summon (milliseconds since the bar began to appear)

    public static let arrivalMs = 220.0
    public static let riseDistance: Double = 4

    /// The bar's opacity and its rise still to go, in points (4 at the start, 0 at the end).
    public static func arrival(atMs t: Double) -> (opacity: Double, rise: Double) {
        let e = easeOut(t / arrivalMs)
        return (e, riseDistance * (1 - e))
    }

    /// How much of the ring is drawn, 0 to 1: over 260 ms from 60 ms.
    public static func ring(atMs t: Double) -> Double { easeOut((t - 60) / 260) }
    /// The bead's opacity: from 260 ms over 160 ms.
    public static func bead(atMs t: Double) -> Double { clamp((t - 260) / 160) }
    /// When the summon motion is over.
    public static let summonEndMs = 420.0

    // MARK: open (first launch)

    public static let openMs = 1600.0

    public struct Open: Equatable {
        public var tileScale: Double
        public var tileOpacity: Double
        public var flare: Double
        public var lockupOpacity: Double
        public var lockupOffset: Double
        /// Everything together, fading out over the last 300 ms.
        public var overall: Double
    }

    public static func open(atMs t: Double) -> Open {
        let tile = easeOut(t / 320)
        let fadeOut = 1 - clamp((t - (openMs - 300)) / 300)
        let lock = easeOut((t - 640) / 300)
        return Open(tileScale: 0.94 + 0.06 * tile, tileOpacity: tile, flare: easeOut((t - 380) / 260),
                    lockupOpacity: lock, lockupOffset: 8 * (1 - lock), overall: fadeOut)
    }
}
