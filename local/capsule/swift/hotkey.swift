// hotkey — press Control twice, anywhere on the Mac, and the Capsule opens.
//
//   hotkey              listen; print one JSON line per gesture on stdout
//   hotkey --check      print what macOS allows this process: listening, posting, accessibility
//   hotkey --simulate   post a double-Control, for testing the whole path without a hand
//
// The Capsule's main process runs this as a child and reads its stdout. Nothing goes through
// vyred: the gesture must work when vyred is down (floor rule 9), and a push down a pipe is
// instant where a poll never is. The prototype rode a 1200ms poll first, and a hotkey that
// answers a second later reads as broken.
//
// Control rather than Fn: Fn already opens the emoji picker. The hard part is that Control is a
// chord modifier used all day (ctrl-C, ctrl-arrow for Spaces), so a Control press with any key
// or other modifier during the hold is discarded. Only two BARE taps within 450ms count.
//
// The tap watches keyDown only to know THAT a key was pressed during a Control hold. It never
// reads which key, and it is listen-only, so it cannot change anything anyone types.
//
// macOS asks for Input Monitoring before a listen-only tap works. The grant belongs to the app
// macOS holds responsible for this process: the Capsule's app, or the terminal it was started
// from. --check reports it so the Capsule can say exactly what to allow.
//
// build: local/capsule/build.sh

import Cocoa

let DOUBLE_MS: Double = 450

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) {
        print(s)
        fflush(stdout)
    }
}
func now() -> Double { Date().timeIntervalSince1970 * 1000 }

let args = CommandLine.arguments.dropFirst()

if args.contains("--check") {
    emit(["listen": CGPreflightListenEventAccess(), "post": CGPreflightPostEventAccess(), "accessibility": AXIsProcessTrusted()])
    exit(0)
}

if args.contains("--simulate") {
    // Control is key code 59. A modifier press arrives as flagsChanged, not keyDown, so the
    // event is made as a key event and then retyped; its flags say whether Control is now down.
    guard CGPreflightPostEventAccess() else {
        emit(["error": "post", "message": "macOS does not let this process post keyboard events. Allow its app under Privacy & Security > Accessibility."])
        exit(3)
    }
    let src = CGEventSource(stateID: .hidSystemState)
    func control(_ down: Bool) {
        guard let e = CGEvent(keyboardEventSource: src, virtualKey: 59, keyDown: down) else { return }
        e.type = .flagsChanged
        e.flags = down ? .maskControl : []
        e.post(tap: .cghidEventTap)
    }
    for i in 0..<2 {
        control(true); usleep(40_000); control(false)
        if i == 0 { usleep(120_000) }
    }
    emit(["simulated": "double-control"])
    exit(0)
}

var ctrlDown = false
var chordUsed = false          // a key or another modifier was pressed during this Control hold
var lastBareTap: Double = 0

var tapRef: CFMachPort? = nil
let callback: CGEventTapCallBack = { _, type, event, _ in
    // macOS turns off a tap it judges slow, or after some user input. Without switching it back
    // on here the process stays alive and never fires again: "the hotkey stopped working".
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let t = tapRef { CGEvent.tapEnable(tap: t, enable: true) }
        emit(["rearmed": Int(type.rawValue)])
        return Unmanaged.passUnretained(event)
    }
    switch type {
    case .keyDown:
        if ctrlDown { chordUsed = true }
    case .flagsChanged:
        let isDown = event.flags.contains(.maskControl)
        let others = event.flags.contains(.maskCommand) || event.flags.contains(.maskAlternate)
            || event.flags.contains(.maskShift) || event.flags.contains(.maskSecondaryFn)
        if isDown && !ctrlDown {
            ctrlDown = true
            chordUsed = others
        } else if !isDown && ctrlDown {
            ctrlDown = false
            if chordUsed { chordUsed = false; lastBareTap = 0; break }
            let t = now()
            if t - lastBareTap < DOUBLE_MS { emit(["gesture": "double-control", "at": Int(t)]); lastBareTap = 0 } else { lastBareTap = t }
        } else if isDown && others {
            chordUsed = true
        }
    default: break
    }
    return Unmanaged.passUnretained(event)
}

let mask = CGEventMask((1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue))
guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                  options: .listenOnly, eventsOfInterest: mask,
                                  callback: callback, userInfo: nil) else {
    emit(["error": "listen", "message": "macOS did not allow a keyboard listener. Allow the Capsule's app (or the terminal that started it) under Privacy & Security > Input Monitoring."])
    exit(2)
}
CFRunLoopAddSource(CFRunLoopGetCurrent(), CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0), .commonModes)
tapRef = tap
CGEvent.tapEnable(tap: tap, enable: true)
emit(["ready": true])
// The disable notice itself can be dropped, so check every few seconds as well.
Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
    if !CGEvent.tapIsEnabled(tap: tap) { CGEvent.tapEnable(tap: tap, enable: true); emit(["rearmed": 0]) }
}
// The parent going away closes our stdin. Exit then, so a crashed Capsule never leaves a
// keyboard listener running with no one reading it.
FileHandle.standardInput.readabilityHandler = { h in if h.availableData.isEmpty { exit(0) } }
CFRunLoopRun()
