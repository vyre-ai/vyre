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
    private(set) var doubleControl = false
    private(set) var chord: String?

    private var tap: CFMachPort?
    private var ctrlDown = false, chordUsed = false
    private var lastBareTap: Double = 0
    private var hotKeyRef: EventHotKeyRef?
    private var handler: EventHandlerRef?

    func start() {
        startDoubleControl()
        startChord(ProcessInfo.processInfo.environment["VYRE_CAPSULE_HOTKEY"] ?? "option+space")
    }

    var canListen: Bool { CGPreflightListenEventAccess() }

    /// The user asked for Control twice: ask macOS (a dialog, so only when dialogs are allowed).
    func requestDoubleControl() {
        guard dialogsAllowed() else { return }
        if !CGPreflightListenEventAccess() { CGRequestListenEventAccess() }
        startDoubleControl()
    }

    func startDoubleControl() {
        guard tap == nil, CGPreflightListenEventAccess() else { return }
        let mask = CGEventMask((1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue))
        let me = Unmanaged.passUnretained(self).toOpaque()
        guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                        eventsOfInterest: mask, callback: { _, type, event, info in
            let me = Unmanaged<Hotkeys>.fromOpaque(info!).takeUnretainedValue()
            MainActor.assumeIsolated { me.handle(type, event) }
            return Unmanaged.passUnretained(event)
        }, userInfo: me) else { return }
        CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0), .commonModes)
        CGEvent.tapEnable(tap: t, enable: true)
        tap = t
        doubleControl = true
    }

    private func handle(_ type: CGEventType, _ event: CGEvent) {
        // macOS turns off a tap it judges slow; switch it back on or the gesture dies silently.
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
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
