// Hotkeys: how the Capsule is opened from anywhere, in process (no helper child any more).
//
//   - Control twice: a listen-only event tap, the gesture swift/hotkey.swift had. It needs Input
//     Monitoring, so it starts only when macOS already allows it; asking is the user's own click
//     in the menu ("Turn on Control twice"), never at launch.
//   - ⌥Space (or VYRE_CAPSULE_HOTKEY): a Carbon hot key, which needs no permission at all, so the
//     Capsule always has a way in.
//
// Two bare Control taps within 450 ms count. A Control press with any key or other modifier during
// the hold is a chord (ctrl-C, ctrl-arrow) and is discarded. The tap never reads which key.

import AppKit
import Carbon.HIToolbox

@MainActor
final class Hotkeys {
    static let doubleMs: Double = 450
    var fire: (FrontApp?) -> Void = { _ in }
    /// The hot key state changed (ok = Control twice is on; message says why not). App.swift sends
    /// it to vyred as capsule.report. Called once after start(), then only on a change.
    var onChange: (Bool, String?) -> Void = { _, _ in }
    private(set) var doubleControl = false
    private(set) var chord: String?

    private var tap: CFMachPort?
    private var tapSource: CFRunLoopSource?
    private var why: HotkeyReport.Why = .noPermission
    private var report = HotkeyReport()
    private var started = false
    private var ctrlDown = false, chordUsed = false
    private var lastBareTap: Double = 0
    private var hotKeyRef: EventHotKeyRef?
    private var handler: EventHandlerRef?

    func start() {
        startDoubleControl()
        startChord(ProcessInfo.processInfo.environment["VYRE_CAPSULE_HOTKEY"] ?? "option+space")
        started = true
        publish()
    }

    /// What capsule.report says right now.
    var state: (ok: Bool, message: String?) {
        doubleControl ? (true, nil) : (false, HotkeyReport.message(why, chord: chord.map(CapsuleApp.pretty)))
    }

    /// Tell onChange, if the state differs from the last report.
    private func publish() {
        guard started else { return }
        let s = state
        if let r = report.next(ok: s.ok, message: s.message) { onChange(r.0, r.1) }
    }

    /// The send of that report failed: send it again when vyred is back (see reportRetry).
    func reportFailed(ok: Bool, message: String?) { report.failed(ok: ok, message: message) }

    /// vyred is up again: resend a report that failed, and nothing otherwise.
    func reportRetry() {
        guard started else { return }
        let s = state
        if let r = report.retry(ok: s.ok, message: s.message) { onChange(r.0, r.1) }
    }

    var canListen: Bool { CGPreflightListenEventAccess() }

    /// The user asked for Control twice: ask macOS (a dialog, so only when dialogs are allowed).
    func requestDoubleControl() {
        guard dialogsAllowed() else { return }
        if !CGPreflightListenEventAccess() { CGRequestListenEventAccess() }
        startDoubleControl()
    }

    func startDoubleControl() {
        defer { publish() }
        guard tap == nil else { return }
        guard CGPreflightListenEventAccess() else { why = .noPermission; return }
        why = .tapFailed
        let mask = CGEventMask((1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue))
        let me = Unmanaged.passUnretained(self).toOpaque()
        guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                        eventsOfInterest: mask, callback: { _, type, event, info in
            let me = Unmanaged<Hotkeys>.fromOpaque(info!).takeUnretainedValue()
            MainActor.assumeIsolated { me.handle(type, event) }
            return Unmanaged.passUnretained(event)
        }, userInfo: me) else { return }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: t, enable: true)
        tap = t
        tapSource = source
        doubleControl = true
    }

    private func handle(_ type: CGEventType, _ event: CGEvent) {
        // macOS turns off a tap it judges slow; switch it back on or the gesture dies silently.
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let t = tap {
                CGEvent.tapEnable(tap: t, enable: true)
                if !CGEvent.tapIsEnabled(tap: t) { dropTap() }
            }
            return
        }
        switch type {
        case .keyDown:
            if ctrlDown { chordUsed = true }
        case .flagsChanged:
            let f = event.flags
            let isDown = f.contains(.maskControl)
            let others = f.contains(.maskCommand) || f.contains(.maskAlternate) || f.contains(.maskShift) || f.contains(.maskSecondaryFn)
            if isDown && !ctrlDown {
                ctrlDown = true; chordUsed = others
            } else if !isDown && ctrlDown {
                ctrlDown = false
                if chordUsed { chordUsed = false; lastBareTap = 0; return }
                let t = Date().timeIntervalSince1970 * 1000
                if t - lastBareTap < Self.doubleMs { lastBareTap = 0; fire(PanelController.frontApp()) } else { lastBareTap = t }
            } else if isDown && others {
                chordUsed = true
            }
        default: break
        }
    }

    /// The tap is off and stays off: let it go, so the menu offers Control twice again, and report.
    private func dropTap() {
        if let s = tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), s, .commonModes) }
        if let t = tap { CFMachPortInvalidate(t) }
        tap = nil; tapSource = nil
        ctrlDown = false; chordUsed = false; lastBareTap = 0
        doubleControl = false
        why = CGPreflightListenEventAccess() ? .tapDisabled : .noPermission
        publish()
    }

    // MARK: the Carbon hot key

    static func parse(_ s: String) -> (key: UInt32, mods: UInt32)? {
        var mods: UInt32 = 0, key: UInt32?
        for part in s.lowercased().split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) {
            switch part {
            case "cmd", "command": mods |= UInt32(cmdKey)
            case "option", "opt", "alt": mods |= UInt32(optionKey)
            case "ctrl", "control": mods |= UInt32(controlKey)
            case "shift": mods |= UInt32(shiftKey)
            case "space": key = UInt32(kVK_Space)
            case "return", "enter": key = UInt32(kVK_Return)
            case "k": key = UInt32(kVK_ANSI_K)
            case "j": key = UInt32(kVK_ANSI_J)
            case "v": key = UInt32(kVK_ANSI_V)
            default: return nil
            }
        }
        guard let key, mods != 0 else { return nil }
        return (key, mods)
    }

    func startChord(_ spec: String) {
        guard spec != "off", let (key, mods) = Self.parse(spec) else { return }
        var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let me = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, _, info in
            let me = Unmanaged<Hotkeys>.fromOpaque(info!).takeUnretainedValue()
            MainActor.assumeIsolated { me.fire(PanelController.frontApp()) }
            return noErr
        }, 1, &type, me, &handler)
        let id = EventHotKeyID(signature: OSType(0x5659_5245), id: 1) // "VYRE"
        if RegisterEventHotKey(key, mods, id, GetApplicationEventTarget(), 0, &hotKeyRef) == noErr { chord = spec }
    }
}
