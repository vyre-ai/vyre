// oversight: the floating panel that shows what an agent is doing on the Mac or in Chrome, and lets
// the person change course (capsule-02.html section 11, capsule-sight's hands.* contract).
//
// It opens when a run's plan arrives (hands.plan) and closes when the run ends or stops; with no
// plan event nothing shows and the Capsule's own "Doing" pill is all there is. It asks for nothing
// and shows no dialog: pause, stop, retexting a step and steering are the person's own calls.
// Drag it anywhere; it remembers where. It follows events only while a run is active, and Chrome's
// own "being debugged" bar is never touched or covered by design (the panel starts at the right
// edge, below the menu bar).

import AppKit
import Foundation
import SwiftUI

// capsule-extension: OversightExtension
@MainActor
final class OversightExtension: CapsuleExtension {
    static let id = "oversight"
    private static let originKey = "oversight.origin"

    private let host: CapsuleHost
    let model: OversightModel
    private var window: SessionWindow?
    private var sub: VyredSubscription?
    private var remembered: NSPoint?
    private var shownSize: CGSize = .zero
    /// For tests: the display's visible frame. Nil means the main screen's.
    var screen: (() -> NSRect?)?
    /// For tests: where the dragged position is kept. Nil means UserDefaults.
    var store: (get: () -> NSPoint?, set: (NSPoint) -> Void)?

    init(host: CapsuleHost) {
        self.host = host
        model = OversightModel(vyred: host.vyred)
        model.onPresence = { [weak self] in self?.sync() }
        // One subscription for the life of the Capsule: the event stream is already open for the
        // agent rows, and an event that is not a run's costs one string compare.
        sub = host.vyred.on("hands.*") { [weak self] e in
            self?.model.apply(e)
            self?.sync()
        }
    }

    var runsHidden: String? {
        model.isActive ? "an agent is driving the Mac and the oversight panel follows its plan until it ends" : nil
    }

    func capsuleWillShow(front: FrontApp?) {}
    func capsuleDidHide() {}

    var isOpen: Bool { window?.isOpen ?? false }

    /// Open, resize or close the window to match the model. Called on every event.
    func sync() {
        guard let r = model.active else {
            window?.close()
            shownSize = .zero
            return
        }
        let size = CGSize(width: OversightLayout.width, height: OversightLayout.height(
            r, collapsed: model.collapsed, canSteer: model.canSteer, hasLine: model.line != nil))
        let w = window ?? host.floatingWindow(owner: Self.id)
        if window == nil {
            window = w
            w.onMoved = { [weak self] f in self?.moved(f) }
        }
        let frame: NSRect
        if w.isOpen {
            // Keep the top-left where the person left it: AppKit's origin is the bottom-left.
            let top = w.frame.maxY
            frame = NSRect(x: w.frame.minX, y: top - size.height, width: size.width, height: size.height)
        } else {
            frame = NSRect(origin: startOrigin(size), size: size)
        }
        if !w.isOpen || size != shownSize {
            w.show(AnyView(OversightView(model: model)), frame: frame)
            shownSize = size
        }
    }

    private func moved(_ f: NSRect) {
        // The top-left is what the person placed; the height follows the plan.
        let p = NSPoint(x: f.minX, y: f.maxY)
        remembered = p
        if let store { store.set(p) } else {
            UserDefaults.standard.set(["x": p.x, "y": p.y], forKey: Self.originKey)
        }
    }

    /// Where a new panel opens: where the person last left it if that is still on a screen, else
    /// the top right, under the menu bar and clear of Chrome's debug bar.
    func startOrigin(_ size: CGSize) -> NSPoint {
        let visible = screen?() ?? NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let saved = remembered ?? store?.get() ?? (UserDefaults.standard.dictionary(forKey: Self.originKey).flatMap { d -> NSPoint? in
            guard let x = d["x"] as? Double, let y = d["y"] as? Double else { return nil }
            return NSPoint(x: x, y: y)
        })
        if let s = saved, visible.insetBy(dx: -40, dy: -40).contains(NSPoint(x: s.x + 40, y: s.y - 20)) {
            return NSPoint(x: s.x, y: s.y - size.height)
        }
        return NSPoint(x: visible.maxX - size.width - 24, y: visible.maxY - size.height - 24)
    }
}
