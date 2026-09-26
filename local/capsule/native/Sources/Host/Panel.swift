// Panel: the Capsule's window. Spotlight's size and place, over whatever is in front.
//
// An NSPanel that never activates the app: it takes key focus so the box can be typed in, but the
// app behind stays the active app, so a full-screen app keeps its Space and nothing switches to
// the desktop. It joins every Space (and full-screen Spaces as an auxiliary), and sits above
// full-screen windows. Spotlight does the same.

import AppKit
import Combine
import SwiftUI

final class CapsulePanel: NSPanel {
    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: Theme.width, height: Theme.barHeight),
                   styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView], backing: .buffered, defer: true)
        isFloatingPanel = true
        level = .popUpMenu
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = false
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isMovable = false
        isReleasedWhenClosed = false
        animationBehavior = .utilityWindow
    }
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class PanelController: NSObject, NSWindowDelegate {
    let panel = CapsulePanel()
    let model: CapsuleModel
    let focus = FocusTicket()
    private var host: NSHostingView<CapsuleView>!
    private var keys: Any?
    private var clickAway: Any?
    private var observe: AnyCancellable?
    private var top: CGFloat = 0
    private var hiddenAt = Date.distantPast
    var onShownChange: ((Bool) -> Void)?

    init(model: CapsuleModel) {
        self.model = model
        super.init()
        host = NSHostingView(rootView: CapsuleView(model: model, focus: focus))
        host.sizingOptions = []
        panel.contentView = host
        panel.delegate = self
        model.onClose = { [weak self] note in self?.hide(); if let note { Notifier.shared.post(title: "Vyre", body: note) } }
        model.onStepAside = { [weak self] in await self?.stepAside() ?? false }
        observe = model.objectWillChange.sink { [weak self] in DispatchQueue.main.async { self?.fit() } }
    }

    var isShown: Bool { panel.isVisible }

    func toggle(front: FrontApp? = nil) {
        if isShown { hide() } else { show(front: front ?? Self.frontApp()) }
    }

    static func frontApp() -> FrontApp? {
        guard let a = NSWorkspace.shared.frontmostApplication, a.processIdentifier != getpid() else { return nil }
        return FrontApp(bundle: a.bundleIdentifier ?? "", pid: a.processIdentifier, name: a.localizedName ?? "")
    }

    func show(front: FrontApp?) {
        // A second open within a moment of closing is the same gesture landing twice.
        if Date().timeIntervalSince(hiddenAt) > 30 { model.reset() }
        model.willShow(front: front)
        let screen = Self.screenUnderMouse()
        let f = screen.frame
        top = f.maxY - (f.height * Theme.topFraction).rounded()
        let h = height()
        panel.setFrame(NSRect(x: (f.midX - Theme.width / 2).rounded(), y: top - h, width: Theme.width, height: h), display: false)
        // Set again before every show (capsule-now rule 6): macOS can drop it after a Space change.
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        panel.orderFrontRegardless()
        panel.makeKey()
        focus.count += 1
        startKeys()
        onShownChange?(true)
    }

    func hide() {
        guard panel.isVisible else { return }
        panel.orderOut(nil)
        stopKeys()
        hiddenAt = Date()
        model.didHide()
        onShownChange?(false)
    }

    /// Hide and wait for the app that was in front to be frontmost again (up to 800 ms).
    func stepAside() async -> Bool {
        hide()
        guard let pid = model.front?.pid else { return false }
        NSRunningApplication(processIdentifier: pid)?.activate()
        for _ in 0..<16 {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return true }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return false
    }

    static func screenUnderMouse() -> NSScreen {
        let p = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(p, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0]
    }

    func height() -> CGFloat {
        var h = Theme.barHeight
        if model.asked != nil { h += 1 + (model.replyText.isEmpty ? 64 : min(300, 64 + CGFloat(model.replyText.count / 80 + 1) * 19)) }
        if !model.groups.isEmpty { h += 1 + CapsuleLayout.resultsHeight(model.groups) }
        if let l = model.line, !l.isEmpty { h += 31 }
        return h
    }

    /// Keep the top edge where it is and grow or shrink downwards.
    func fit() {
        guard panel.isVisible else { return }
        let h = height()
        var f = panel.frame
        if abs(f.height - h) < 0.5 { return }
        f.origin.y = top - h
        f.size.height = h
        panel.setFrame(f, display: true)
        panel.invalidateShadow()
    }

    // MARK: keys, while shown only

    private func startKeys() {
        stopKeys()
        keys = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self, self.panel.isKeyWindow else { return e }
            return self.key(e) ? nil : e
        }
        // A click in another app closes the Capsule, as Spotlight does.
        clickAway = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            MainActor.assumeIsolated { self?.hide() }
        }
    }

    private func stopKeys() {
        if let k = keys { NSEvent.removeMonitor(k) }
        if let c = clickAway { NSEvent.removeMonitor(c) }
        keys = nil; clickAway = nil
    }

    private func key(_ e: NSEvent) -> Bool {
        let cmd = e.modifierFlags.contains(.command), shift = e.modifierFlags.contains(.shift)
        switch e.keyCode {
        case 53: // escape
            if model.confirming != nil { model.confirming = nil; model.line = nil; return true }
            if let r = model.reply, !r.finished { model.stopReply(); return true }
            if !model.text.isEmpty { model.text = ""; return true }
            hide(); return true
        case 125: model.move(1); return true   // down
        case 126: model.move(-1); return true  // up
        case 36, 76: // return
            if cmd || shift { return model.run(shortcut: KeyShortcut("return", command: cmd, shift: shift)) }
            model.run(); return true
        case 8 where cmd && !shift: // ⌘C with nothing selected in the box copies the row
            if let editor = panel.firstResponder as? NSTextView, editor.selectedRange().length > 0 { return false }
            return model.copyCurrent()
        default:
            if cmd, let ch = e.charactersIgnoringModifiers?.lowercased(), ch != "a", ch != "v", ch != "x", ch != "z" {
                return model.run(shortcut: KeyShortcut(ch, command: true, shift: shift))
            }
            return false
        }
    }

    func windowDidResignKey(_ notification: Notification) {
        // Losing key to another app's window is the user moving on.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.panel.isVisible, !self.panel.isKeyWindow, NSApp.keyWindow == nil else { return }
            self.hide()
        }
    }
}

/// Top-right banners, through the Notification Center. Only when the Capsule is hidden; while it
/// is shown a note is said under the box instead.
@MainActor final class Notifier {
    static let shared = Notifier()
    func post(title: String, body: String) {
        guard dialogsAllowed() else { return }
        let n = NSUserNotification()
        n.title = title
        n.informativeText = body
        NSUserNotificationCenter.default.deliver(n)
    }
}
