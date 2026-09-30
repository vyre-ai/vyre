// capsule-suite: lumenMotionSuite
// The Lumen lens and its two moments, as numbers: the timings are app-design's (docs/design/brand/README.md).

import CoreGraphics
import Foundation

let lumenMotionSuite = Suite("lumen motion") { t in
    t.test("summon: the bar arrives over 220 ms with a 4 pt rise, the ring draws over 260 ms from 60 ms, the bead fades in from 260 ms over 160") {
        let a0 = LumenMotion.arrival(atMs: 0), a1 = LumenMotion.arrival(atMs: 220), ah = LumenMotion.arrival(atMs: 110)
        t.near(a0.opacity, 0); t.near(a0.rise, 4); t.near(a1.opacity, 1); t.near(a1.rise, 0)
        t.ok(ah.opacity > 0.5 && ah.opacity < 1 && ah.rise > 0 && ah.rise < 2, "eased out: past half way at the midpoint")
        t.near(LumenMotion.ring(atMs: 0), 0); t.near(LumenMotion.ring(atMs: 60), 0); t.near(LumenMotion.ring(atMs: 320), 1)
        t.ok(LumenMotion.ring(atMs: 190) > 0.5 && LumenMotion.ring(atMs: 190) < 1)
        t.near(LumenMotion.bead(atMs: 260), 0); t.near(LumenMotion.bead(atMs: 340), 0.5); t.near(LumenMotion.bead(atMs: 420), 1)
        t.near(LumenMotion.arrival(atMs: 1000).opacity, 1); t.near(LumenMotion.ring(atMs: 5000), 1)
        t.near(LumenMotion.arrival(atMs: -50).opacity, 0)
    }

    t.test("open: the tile eases in over 320 ms from 94%, the flare from 380 ms over 260, the lockup from 640 ms over 300 and 8 pt, all fading out over the last 300 of 1600") {
        let s0 = LumenMotion.open(atMs: 0)
        t.near(s0.tileScale, 0.94); t.near(s0.tileOpacity, 0); t.near(s0.flare, 0); t.near(s0.lockupOpacity, 0); t.near(s0.lockupOffset, 8); t.near(s0.overall, 1)
        let s = LumenMotion.open(atMs: 1000)
        t.near(s.tileScale, 1); t.near(s.tileOpacity, 1); t.near(s.flare, 1); t.near(s.lockupOpacity, 1); t.near(s.lockupOffset, 0); t.near(s.overall, 1)
        t.ok(LumenMotion.open(atMs: 500).flare > 0 && LumenMotion.open(atMs: 500).flare < 1)
        t.ok(LumenMotion.open(atMs: 780).lockupOpacity > 0 && LumenMotion.open(atMs: 780).lockupOpacity < 1)
        t.near(LumenMotion.open(atMs: 1300).overall, 1); t.near(LumenMotion.open(atMs: 1450).overall, 0.5); t.near(LumenMotion.open(atMs: 1600).overall, 0)
        t.near(LumenMotion.open(atMs: 2000).overall, 0)
    }

    t.test("the glyph's gap sits around the bead, and the bead is inside the gap") {
        let g = LumenGlyph.self
        let d = hypot(g.beadCentre.x - g.ringCentre.x, g.beadCentre.y - g.ringCentre.y)
        // The bead is on the ring's own circle (its centre is a ring radius from the ring centre, as drawn).
        t.ok(abs(d - g.ringRadius) < 40, "\(d)")
        t.ok(g.gapRadius > g.beadRadius + g.ringStroke / 2 - 60 && g.gapRadius > g.beadRadius)
    }

    t.test("the menu bar lens is a template image; the waiting one keeps its colour") {
        MainActor.assumeIsolated {
            let plain = LumenMark.menuBarImage()
            t.ok(plain.isTemplate); t.eq(plain.size, NSSize(width: 18, height: 18))
            let waiting = LumenMark.menuBarImage(beadColor: .systemPurple, beadScale: 1.25)
            t.ok(!waiting.isTemplate)
            t.ok(plain.tiffRepresentation != nil && waiting.tiffRepresentation != nil, "both draw")
        }
    }
}
