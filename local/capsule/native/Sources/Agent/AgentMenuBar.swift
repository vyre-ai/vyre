// The menu-bar mark says when something waits: the mark carries the Beacon dot while anything
// held or asking waits (proposed lessons are quiet and do not count), and the menu names how many.
// The small corner dot stays capsule-pro's health dot (Host/MenuBar.swift); Beacon is this one.

import AppKit
import Combine

extension CapsuleApp {
    /// Repaint the mark whenever the waiting list changes. Once, at launch.
    func followWaiting() {
        agentSink = model.desk.$waiting.receive(on: RunLoop.main).sink { [weak self] _ in self?.paintStatus() }
        paintStatus()
        // vyred coming and going: the mark, the offline line, and the list read again (what was
        // raised while it was down is not in the stream).
        let before = vyred.follower.onState
        vyred.follower.onState = { [weak self] st in
            before?(st)
            guard let self else { return }
            self.health.set(up: st == .open)
            self.paintStatus()
            self.model.objectWillChange.send()
            if case .open = st { Task { @MainActor in self.model.desk.follow(); await self.model.desk.load() } }
        }
        // The dot is for a Capsule that is hidden: follow the list from launch, not first open.
        Task { @MainActor [model, vyred] in
            _ = await vyred.refreshTools()
            guard vyred.isUp else { return }
            model.desk.follow()
            await model.desk.load()
        }
    }

    func paintStatus() {
        let loud = model.desk.loud
        guard let bar = menuBar else { return }
        bar.item.button?.image = loud > 0 ? Self.menuBarMarkWaiting() : Self.menuBarMark()
        bar.item.button?.toolTip = "Vyre · \(health.summary)" + (loud > 0 ? " · \(loud) waiting on you" : "")
    }

    /// "Waiting on you · N", which opens the list; "Nothing waiting" when nothing does.
    func addWaitingItem(_ menu: NSMenu) {
        let n = model.desk.waiting.count
        let item = NSMenuItem(title: n > 0 ? "Waiting on you · \(n)" : "Nothing waiting", action: n > 0 ? #selector(openWaiting) : nil, keyEquivalent: "")
        item.target = self
        item.isEnabled = n > 0
        menu.addItem(item)
    }

    @objc func openWaiting() {
        panel.show(front: PanelController.frontApp())
        model.desk.openList()
    }

    /// The mark with the Beacon dot. Not a template (the dot keeps its colour), so the wire is drawn
    /// in the label colour of the menu bar's appearance at draw time.
    static func menuBarMarkWaiting() -> NSImage {
        NSImage(size: NSSize(width: 18, height: 18), flipped: true) { r in
            let k = r.width / 16
            let p = NSBezierPath()
            p.move(to: NSPoint(x: 2.5 * k, y: 4 * k))
            p.line(to: NSPoint(x: 8 * k, y: 13 * k))
            p.line(to: NSPoint(x: 11.52 * k, y: 7.24 * k))
            p.lineWidth = 1.8 * k
            p.lineCapStyle = .round
            p.lineJoinStyle = .round
            NSColor.labelColor.setStroke()
            p.stroke()
            NSColor(srgbRed: 1, green: 0x7A / 255, blue: 0x59 / 255, alpha: 1).setFill()
            NSBezierPath(ovalIn: NSRect(x: (13.5 - 2.2) * k, y: (4 - 2.2) * k, width: 4.4 * k, height: 4.4 * k)).fill()
            return true
        }
    }
}
