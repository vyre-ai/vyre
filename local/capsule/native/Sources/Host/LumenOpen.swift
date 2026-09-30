// LumenOpen: the first-launch moment (app-design's "open", Core/LumenMotion.swift): the Lumen tile eases
// in, the lens catches its point of light, "Vyre Lumen" slides in, and everything fades out over 1.6 s.
// Shown once, the first time Lumen runs; never under tests, never with Reduce Motion, never takes focus
// or a click. The tile is the app's own icon (Lumen.icns in the bundle).

import AppKit
import SwiftUI

struct LumenOpenView: View {
    let start: Date
    /// For a picture of one instant (the speed check's stills): the time to show, instead of the clock.
    var fixedMs: Double?
    var icon: NSImage = NSApp.applicationIconImage

    var body: some View {
        TimelineView(.animation(paused: fixedMs != nil)) { tl in
            let ms = fixedMs ?? tl.date.timeIntervalSince(start) * 1000
            let s = LumenMotion.open(atMs: ms)
            VStack(spacing: 18) {
                ZStack {
                    Image(nsImage: icon).resizable().interpolation(.high)
                        .frame(width: 144, height: 144)
                        .scaleEffect(s.tileScale).opacity(s.tileOpacity)
                    // The flare: a warm point on the lens's rim, upper left to right, blooming once.
                    Circle().fill(RadialGradient(colors: [Color(red: 1, green: 0.875, blue: 0.66).opacity(0.55 * s.flare), .clear],
                                                 center: .center, startRadius: 0, endRadius: 26))
                        .frame(width: 52, height: 52).offset(x: 26, y: -30).blendMode(.plusLighter)
                }
                HStack(spacing: 7) {
                    Text("Vyre").fontWeight(.regular).opacity(0.62)
                    Text("Lumen").fontWeight(.semibold)
                }
                .font(.system(size: 28)).foregroundColor(Theme.bone)
                .opacity(s.lockupOpacity).offset(y: s.lockupOffset)
            }
            .padding(36)
            .opacity(s.overall)
        }
    }
}

@MainActor
enum LumenOpen {
    private static var panel: NSPanel?

    /// Show it once. `force` for a try-out.
    static func showIfFirst(force: Bool = false) {
        guard force || (!Paster.flag("openedLumen") && dialogsAllowed()) else { return }
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, let screen = NSScreen.main else { return }
        Paster.setFlag("openedLumen")
        let size = NSSize(width: 320, height: 300)
        let f = screen.frame
        let p = NSPanel(contentRect: NSRect(x: f.midX - size.width / 2, y: f.maxY - f.height * 0.36 - size.height / 2, width: size.width, height: size.height),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = false
        p.level = .floating; p.ignoresMouseEvents = true; p.collectionBehavior = [.canJoinAllSpaces, .transient, .ignoresCycle]
        p.isReleasedWhenClosed = false
        p.contentView = NSHostingView(rootView: LumenOpenView(start: Date()))
        p.orderFrontRegardless()
        panel = p
        DispatchQueue.main.asyncAfter(deadline: .now() + LumenMotion.openMs / 1000 + 0.1) {
            MainActor.assumeIsolated { p.orderOut(nil); if panel === p { panel = nil } }
        }
    }
}
