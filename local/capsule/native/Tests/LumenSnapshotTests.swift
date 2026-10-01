// capsule-suite: lumenSnapshotSuite
// Stills of the Lumen icon and its two moments, drawn off screen (no window, no screen capture). With
// VYRE_CAPSULE_SNAP set to a folder, they are written there for the CI artifact; otherwise each only
// has to draw. The summon frames show the lens drawing itself in; the open frames show the tile, the
// point of light and the lockup; the menu bar mark is shown light and dark at its real sizes.

import AppKit
import SwiftUI

@MainActor private func still<V: View>(_ v: V, size: CGSize, dark: Bool, _ name: String, dir: String?) -> Bool {
    let host = NSHostingView(rootView: v.frame(width: size.width, height: size.height)
        .background(dark ? Color(red: 0.094, green: 0.086, blue: 0.075) : Color(red: 0.98, green: 0.976, blue: 0.96)))
    host.frame = NSRect(origin: .zero, size: size)
    host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    host.layoutSubtreeIfNeeded()
    guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return false }
    host.cacheDisplay(in: host.bounds, to: rep)
    if let dir, let png = rep.representation(using: .png, properties: [:]) {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name + ".png"))
    }
    return rep.pixelsWide > 0
}

let lumenSnapshotSuite = Suite("lumen stills") { t in
    let dir = ProcessInfo.processInfo.environment["VYRE_CAPSULE_SNAP"].flatMap { $0.isEmpty ? nil : $0 }

    t.test("the summon: the lens draws in over 420 ms (five stills, dark and light)") {
        MainActor.assumeIsolated {
            for ms in [0.0, 100, 200, 300, 420] {
                for dark in [true, false] {
                    t.ok(still(LumenMark(size: 96, ring: LumenMotion.ring(atMs: ms), bead: LumenMotion.bead(atMs: ms)), size: CGSize(width: 120, height: 120), dark: dark,
                               "lumen-summon-\(Int(ms))ms-\(dark ? "dark" : "light")", dir: dir), "\(ms)")
                }
            }
        }
    }

    t.test("the first-launch open: the tile, the point of light and the lockup at six moments") {
        MainActor.assumeIsolated {
            let icns = "docs/design/brand/export/lumen/macos/Lumen.icns"
            let icon = NSImage(contentsOfFile: icns) ?? NSApp.applicationIconImage ?? NSImage()
            for ms in [0.0, 300, 500, 800, 1200, 1500] {
                t.ok(still(LumenOpenView(start: Date(), fixedMs: ms, icon: icon), size: CGSize(width: 320, height: 300), dark: true, "lumen-open-\(Int(ms))ms", dir: dir), "\(ms)")
            }
        }
    }

    t.test("the menu bar lens, resting and with something waiting, on a light and a dark bar, at 18 pt scaled up") {
        MainActor.assumeIsolated {
            for dark in [true, false] {
                let rest = LumenMark.menuBarImage(), waiting = LumenMark.menuBarImage(beadColor: NSColor(srgbRed: 0xB8 / 255, green: 0xA4 / 255, blue: 0xFF / 255, alpha: 1), beadScale: 1.25)
                let row = HStack(spacing: 24) {
                    Image(nsImage: rest).renderingMode(.template).resizable().frame(width: 72, height: 72).foregroundColor(dark ? .white : .black)
                    Image(nsImage: waiting).resizable().frame(width: 72, height: 72)
                }
                t.ok(still(row, size: CGSize(width: 240, height: 110), dark: dark, "lumen-menubar-\(dark ? "dark" : "light")", dir: dir))
            }
        }
    }
}
