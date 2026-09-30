// Panel: the Capsule's window. Spotlight's size and place, over whatever is in front.
//
// An NSPanel that never activates the app: it takes key focus so the box can be typed in, but the
// app behind stays the active app, so a full-screen app keeps its Space and nothing switches to
// the desktop. It joins every Space (and full-screen Spaces as an auxiliary), and sits above
// full-screen windows. Spotlight does the same.

import AppKit
import Combine
import SwiftUI
import UserNotifications

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

    /// The standard shortcuts (MainMenu.swift). The Capsule's app is never active, so AppKit may
    /// not consult the main menu for this window: look the item up and send its action to the
    /// field (or the item's own target) here.
    override func performKeyEquivalent(with e: NSEvent) -> Bool {
        if super.performKeyEquivalent(with: e) { return true }
        guard let item = MainMenu.item(for: e, in: NSApplication.shared.mainMenu), let action = item.action else { return false }
        if let target = item.target { return NSApplication.shared.sendAction(action, to: target, from: item) }
        // Up the responder chain from the field: the field editor selects and pastes, the window
        // above it undoes.
        return firstResponder?.tryToPerform(action, with: item) ?? false
    }
}

@MainActor
final class PanelController: NSObject, NSWindowDelegate {
    let panel = CapsulePanel()
    let model: CapsuleModel
    let focus = FocusTicket()
    private(set) var host: CountingHostingView!
    private var keys: Any?
    private var clickAway: Any?
    private var observe: AnyCancellable?
    /// The panel's top edge, which stays put while it grows downward.
    var top: CGFloat = 0
    private var hiddenAt = Date.distantPast
    var onShownChange: ((Bool) -> Void)?
    var extensions: ExtensionHost?
    /// How many times the panel changed size while shown (the typing check counts jumps with it).
    private(set) var frameChanges = 0

    init(model: CapsuleModel) {
        self.model = model
        super.init()
        host = CountingHostingView(rootView: CapsuleView(model: model, focus: focus))
        host.sizingOptions = []
        panel.contentView = host
        panel.delegate = self
        // A note on close ("Copied 87") needs no banner: the user just did it and saw it.
        model.onClose = { [weak self] _ in self?.hide() }
        model.isShown = { [weak self] in self?.isShown ?? false }
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
        extensions?.willShow(front: front)
        let screen = Self.screenUnderMouse()
        let f = screen.frame
        top = f.maxY - (f.height * Theme.topFraction).rounded()
        let h = height()
        panel.setFrame(NSRect(x: (f.midX - Theme.width / 2).rounded(), y: top - h, width: Theme.width, height: h), display: false)
        // Set again before every show (capsule-now rule 6): macOS can drop it after a Space change.
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        // In quickly: a fade over two frames' worth, so it arrives rather than blinks.
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        panel.makeKey()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.11
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
        }
        focus.count += 1
        startKeys()
        onShownChange?(true)
    }

    /// Build and draw the panel's view once while it is hidden, so the first summon after launch does
    /// not pay for the first layout, first fonts and first render. Nothing is shown, no key is taken.
    func prewarm() {
        guard !panel.isVisible else { return }
        let size = NSSize(width: Theme.width, height: height())
        host.frame = NSRect(origin: .zero, size: size)
        host.layoutSubtreeIfNeeded()
        if let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) { host.cacheDisplay(in: host.bounds, to: rep) }
    }

    /// For the typing check: shown far off screen, never key, no global monitors, so a test types
    /// into its own window and nothing on the user's screen changes.
    func showOffscreen() {
        model.willShow(front: nil)
        top = -10_000
        let h = height()
        panel.setFrame(NSRect(x: -10_000, y: top - h, width: Theme.width, height: h), display: false)
        panel.orderFrontRegardless()
    }

    func hide() {
        guard panel.isVisible else { return }
        panel.orderOut(nil)
        stopKeys()
        hiddenAt = Date()
        model.didHide()
        extensions?.didHide()
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

    func height() -> CGFloat { CapsuleLayout.panelHeight(model) }
    /// The height the open step is easing to, while it eases.
    private var easingTo: CGFloat?

    /// Keep the top edge where it is and grow or shrink downwards.
    func fit() {
        guard panel.isVisible else { return }
        let h = height()
        var f = panel.frame
        // Mid-step the frame is still easing: the height it is easing to is what counts.
        if let to = easingTo, abs(to - h) < 0.5 { return }
        if easingTo == nil, abs(f.height - h) < 0.5 { return }
        easingTo = nil
        let grows = h > f.height
        f.origin.y = top - h
        f.size.height = h
        frameChanges += 1
        // Opening from the compact bar to the full panel is one 150 ms step (capsule.md); every
        // other change, and any under Reduce Motion, is at once. Nothing resizes while text streams
        // (the open panel's height is fixed).
        if grows, h >= CapsuleLayout.openHeight - 0.5, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            easingTo = h
            NSAnimationContext.runAnimationGroup { c in
                c.duration = Tokens.Motion.reveal / 1000
                c.timingFunction = CAMediaTimingFunction(controlPoints: Float(Tokens.Motion.ease[0]), Float(Tokens.Motion.ease[1]), Float(Tokens.Motion.ease[2]), Float(Tokens.Motion.ease[3]))
                panel.animator().setFrame(f, display: true)
            } completionHandler: { [weak self] in MainActor.assumeIsolated {
                if self?.easingTo == h { self?.easingTo = nil }
                self?.panel.invalidateShadow()
            } }
            return
        }
        panel.setFrame(f, display: true)
        panel.invalidateShadow()
    }

    // MARK: keys, while shown only

    private func startKeys() {
        stopKeys()
        keys = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp]) { [weak self] e in
            guard let self, self.panel.isKeyWindow else { return e }
            if e.type == .keyUp {
                // Return coming up ends a held talk (hold-to-talk); nothing else listens to key-ups.
                if e.keyCode == 36 || e.keyCode == 76, self.extensions?.handleUp(key: "return") == true { return nil }
                return e
            }
            return self.key(e) ? nil : e
        }
        // A click in another app closes the Capsule, as Spotlight does.
        clickAway = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            // Not while a reply streams or a card is open: the user is reading or editing (pinned).
            MainActor.assumeIsolated { if self?.model.pinned == true { return }; self?.hide() }
        }
    }

    private func stopKeys() {
        if let k = keys { NSEvent.removeMonitor(k) }
        if let c = clickAway { NSEvent.removeMonitor(c) }
        keys = nil; clickAway = nil
    }

    static func chord(_ e: NSEvent) -> KeyShortcut? {
        let key: String
        switch e.keyCode {
        case 36, 76: key = "return"
        case 49: key = "space"
        case 48: key = "tab"
        case 51: key = "delete"
        default: guard let c = e.charactersIgnoringModifiers?.lowercased(), !c.isEmpty else { return nil }; key = c
        }
        let f = e.modifierFlags
        return KeyShortcut(key, command: f.contains(.command), option: f.contains(.option), shift: f.contains(.shift), control: f.contains(.control))
    }

    /// One key while shown. Internal so the driven mode (Agent/AgentDrive.swift) can press keys in this
    /// window alone, never system-wide.
    func key(_ e: NSEvent) -> Bool {
        // Setting a hotkey: the shortcut pressed is the answer (Esc leaves).
        if model.bindingEdit?.field == .hotkey {
            let f = e.modifierFlags
            return model.captureHotkey(keyCode: e.keyCode, command: f.contains(.command), option: f.contains(.option), control: f.contains(.control), shift: f.contains(.shift))
        }
        // The waiting list and its cards take their keys first (Agent/AgentPanelKeys.swift).
        if agentKey(e) { return true }
        let cmd = e.modifierFlags.contains(.command), shift = e.modifierFlags.contains(.shift)
        // Chords with Option or Control are the extensions' (Option-Return talks). The Capsule's own
        // keys use Command and Shift only, so they win a clash by never reaching here.
        if e.modifierFlags.contains(.option) || e.modifierFlags.contains(.control), let c = Self.chord(e),
           extensions?.handle(chord: c) == true { return true }
        switch e.keyCode {
        case 53: // escape
            // Listening (like goal mode and the rewind picker) closes first: Esc cancels the
            // recording AND removes exactly what this dictation added -- anything typed before or
            // after it stays (the user's spec, 28 Sep, matching chat's tap-to-talk).
            if extensions?.cancelTalking() == true { return true }
            if model.bindingEdit != nil { model.cancelBinding(); return true }
            if model.presenceAsk != nil { model.cancelPresence(); return true }
            if model.credentialAsk != nil { model.cancelCredential(); return true }
            if model.escCommand() { return true }
            if model.viewBack() { return true }
            if model.confirming != nil { model.confirming = nil; model.line = nil; return true }
            if let r = model.reply, !r.finished { model.stopReply(); return true }
            // An answer on screen, or the follow-up box: back to plain search. The next Esc hides.
            if model.followUp || model.asked != nil { model.clearAnswer(); return true }
            if !model.text.isEmpty { model.text = ""; return true }
            hide(); return true
        case 51 where e.modifierFlags.contains(.command) && !model.attachments.isEmpty: // ⌘⌫ takes the last attachment off
            model.removeAttachment(); return true
        case 51 where model.text.isEmpty && model.target != nil: // delete on an empty box drops the chip (a child first)
            model.dropChip(); return true
        case 48 where model.viewSession != nil: // Tab: the row's detail, in a module command
            return model.viewOpenDetail()
        case 48 where model.current?.kind == "mention": // tab picks the @ row
            model.run(); return true
        case 124 where cmd && !shift && (model.showsMemory || model.askedMemory != nil) && caretAtEnd: // ⌘→ at the end of the box shows or folds memory's sources
            model.memoryExpanded.toggle(); return true
        case 2 where cmd && !shift && model.canGoDeeper: // ⌘D: the same question to the deeper model
            model.deeper(); return true
        case 31 where cmd && !shift && model.reply.map({ !$0.thread.isEmpty }) == true: // ⌘O: the thread in Vyre chat
            model.openInChat(); return true
        case 18, 19, 20 where cmd && !shift && (model.askedMemory?.sources.isEmpty == false): // ⌘1 ⌘2 ⌘3: a Vyre IQ source
            model.openSource(e.keyCode == 18 ? 0 : e.keyCode == 19 ? 1 : 2); return true
        // An answer that runs past its card scrolls from the keyboard; the focus stays in the box.
        // ⌘↑ ⌘↓ are the card's only while it has more to show, else the box's (start, end).
        case 126 where cmd && !shift && model.asked != nil && model.answerScroll.overflows: model.answerScroll.toTop(); return true
        case 125 where cmd && !shift && model.asked != nil && model.answerScroll.overflows: model.answerScroll.toEnd(); return true
        case 126 where e.modifierFlags.contains(.option) && !cmd && !shift && model.asked != nil && model.answerScroll.overflows: model.answerScroll.lines(-1); return true
        case 125 where e.modifierFlags.contains(.option) && !cmd && !shift && model.asked != nil && model.answerScroll.overflows: model.answerScroll.lines(1); return true
        case 116 where model.asked != nil: model.answerScroll.page(-1); return true // PageUp
        case 121 where model.asked != nil: model.answerScroll.page(1); return true // PageDown
        case 115 where model.asked != nil && !cmd: model.answerScroll.toTop(); return true // Home
        case 119 where model.asked != nil && !cmd: model.answerScroll.toEnd(); return true // End
        // ↑↓ move in the results; with ⌘, ⇧ or ⌥ they are the box's (start, end, select).
        case 125 where !e.modifierFlags.contains(.command) && !shift && !e.modifierFlags.contains(.option): model.move(1); return true
        case 126 where !e.modifierFlags.contains(.command) && !shift && !e.modifierFlags.contains(.option): model.move(-1); return true
        case 36, 76: // return; a held key is one press, so a held Enter never confirms what it showed
            if e.isARepeat { return true }
            // A module command's form, or a previewed send: ⏎ submits (a second ⏎ on a preview sends it).
            if let vs = model.viewSession, vs.isFormOrPreview { Task { await model.viewSubmit() }; return true }
            if model.viewRunDetailAction() { return true }
            // A key being added: ⏎ saves it (the field's own submit does the same).
            if model.credentialAsk != nil { Task { await model.saveCredential() }; return true }
            // Plain ⏎ while listening: stop the mic (keeping the words already heard) and send,
            // same as chat's tap-to-talk. ⌘⏎/⇧⏎ are left alone -- only a plain ⏎ means "send".
            if !shift, !cmd { _ = extensions?.stopTalking() }
            // Offline with an empty box: ⏎ is the Offline line's "Start Vyre".
            if !shift, !cmd, model.returnStartsVyre() { return true }
            // A question: ⏎ asks (or keeps the answer and opens the follow-up box), ⌘⏎ thinks deeper.
            if !shift, model.handleReturn(command: cmd) { return true }
            if cmd || shift { return model.run(shortcut: KeyShortcut("return", command: cmd, shift: shift)) }
            model.run(); return true
        case 8 where cmd && !shift: // ⌘C with nothing selected in the box copies the row
            if let editor = panel.firstResponder as? NSTextView, editor.selectedRange().length > 0 { return false }
            return model.copyCurrent()
        default:
            // A row's own ⌘ shortcut, unless the key is a standard one (MainMenu.swift) or moves the caret.
            if cmd, !e.modifierFlags.contains(.control), let ch = e.charactersIgnoringModifiers?.lowercased(), !Self.standard.contains(ch),
               !(123...126).contains(Int(e.keyCode)) {
                return model.run(shortcut: KeyShortcut(ch, command: true, shift: shift))
            }
            return false
        }
    }

    /// Keys the Edit, app and Window menus own, never a row's: ⌘A C V X Z F W , Q and ⌘⌫.
    static let standard: Set<String> = ["a", "v", "x", "z", "f", "w", ",", "q", "o", "\u{7f}"]

    /// The caret is at the end of the box with nothing selected: ⌘→ has nothing to move.
    var caretAtEnd: Bool {
        guard let editor = panel.firstResponder as? NSTextView else { return true }
        let r = editor.selectedRange()
        return r.length == 0 && r.location >= (editor.string as NSString).length
    }

    func windowDidResignKey(_ notification: Notification) {
        // Losing key to another app's window is the user moving on.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.panel.isVisible, !self.panel.isKeyWindow, NSApp.keyWindow == nil, !self.model.pinned else { return }
            self.hide()
        }
    }
}

/// Top-right banners, through the Notification Center (UNUserNotificationCenter), only while the
/// Capsule is hidden; while it is shown a note is said in its footer instead. macOS asks the
/// person once whether Vyre may show banners, the first time there is one to show, and never
/// under tests (dialogsAllowed()).
@MainActor final class Notifier {
    static let shared = Notifier()
    private var asked = false

    func post(title: String, body: String) {
        guard dialogsAllowed(), Bundle.main.bundleIdentifier != nil else { return }
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            let status = settings.authorizationStatus
            Task { @MainActor in
                switch status {
                case .authorized, .provisional: Self.deliver(title: title, body: body)
                case .notDetermined:
                    guard !self.asked else { return }
                    self.asked = true
                    center.requestAuthorization(options: [.alert, .sound]) { ok, _ in
                        if ok { Task { @MainActor in Self.deliver(title: title, body: body) } }
                    }
                default: break
                }
            }
        }
    }

    private static func deliver(title: String, body: String) {
        let c = UNMutableNotificationContent()
        c.title = title
        c.body = body
        c.threadIdentifier = "vyre.capsule"
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
    }
}

/// The hosting view, counting its layout passes (the typing check reads it).
final class CountingHostingView: NSHostingView<CapsuleView> {
    private(set) var layouts = 0
    override func layout() { layouts += 1; super.layout() }
}
