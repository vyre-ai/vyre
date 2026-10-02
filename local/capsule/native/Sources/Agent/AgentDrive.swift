// Drive: the native Capsule under a script (VYRE_CAPSULE_DRIVE=1), for journey tests and for
// measuring it. Like the Electron Capsule's driven mode: JSON commands on stdin, one per line, run
// in order, each answered with one JSON line on stdout.
//
//   {"show": true}            show the panel without taking the keyboard from anyone
//   {"hide": true}
//   {"text": "what is 2+2?"}  set the box; the answer says how long until the rows were there
//   {"key": "down"}           press a key in this panel only (up, down, return, escape, tab, delete,
//                             or a letter), with "cmd": true / "shift": true
//   {"probe": true}           what is on screen: the box, the rows, the selection, the reply, the
//                             waiting list, the desk and the conversation
//   {"timings": true}         the open and keystroke timings measured so far
//   {"memory": true}          this process's memory as the kernel counts it: phys_footprint (what
//                             Activity Monitor calls Memory), resident size, and malloc in use
//
// Nothing here posts an event outside this app: keys go straight to the panel's key handler.

import AppKit
import Foundation

/// When drive mode may start: the drive variable, the test marker, and a VYRE_HOME under the OS temp
/// folder, so a person's own home (or a stray process with only the variable) can never be driven.
enum DriveGuard {
    static func allowed(_ env: [String: String], temp: String = NSTemporaryDirectory()) -> Bool {
        guard env["VYRE_CAPSULE_DRIVE"] == "1", env["VYRE_CAPSULE_TEST"] == "1",
              let home = env["VYRE_HOME"], !home.isEmpty else { return false }
        func real(_ p: String) -> String { URL(fileURLWithPath: p).resolvingSymlinksInPath().standardizedFileURL.path }
        let h = real(home), t = real(temp).hasSuffix("/") ? real(temp) : real(temp) + "/"
        return h.hasPrefix(t) && h.count > t.count
    }
}

@MainActor
enum Drive {
    static var app: CapsuleApp?
    static var timings: [[String: Any]] = []

    static func start(_ a: CapsuleApp) {
        // Drive mode hands a process the panel's rows and keys, so it needs both: the drive variable and the
        // test marker (which also turns off every dialog and notification). A release run by a person has neither.
        guard DriveGuard.allowed(ProcessInfo.processInfo.environment) else { return }
        app = a
        let input = FileHandle.standardInput
        Thread.detachNewThread {
            while let line = readLine() {
                let text = line
                DispatchQueue.main.async { MainActor.assumeIsolated { run(text) } }
            }
            _ = input
        }
        say(["ready": true])
    }

    static func say(_ o: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) else { return }
        FileHandle.standardOutput.write(d + Data("\n".utf8))
    }

    static func run(_ line: String) {
        guard let a = app, let d = line.data(using: .utf8), let c = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else {
            say(["error": "not a command"]); return
        }
        let m = a.model
        if VJ.truthy(c["show"]) {
            let t0 = DispatchTime.now()
            let phases = a.panel.showForDrive()
            DispatchQueue.main.async { timings.append(["kind": "open", "ms": ms(t0), "phases": phases]); say(["shown": true]) }
            return
        }
        if VJ.truthy(c["hide"]) { a.panel.hide(); say(["hidden": true]); return }
        if let t = c["text"] as? String {
            let t0 = DispatchTime.now()
            m.text = t
            let setMs = ms(t0)
            let tok = m.token
            // No forced layout: the view updates as it does for a person typing, on the run loop.
            let idx = timings.count
            timings.append(["kind": "results", "ms": -1.0, "set": setMs, "text": t, "token": tok, "t0": t0.uptimeNanoseconds])
            // "First rows": the local rows are in this turn's publish; this is when the turn has finished and
            // the run loop is about to sleep, after the view has been updated and committed.
            let obs = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, false, 3_000_000) { _, _ in
                MainActor.assumeIsolated { if idx < timings.count { timings[idx]["first"] = ms(t0) } }
            }
            CFRunLoopAddObserver(CFRunLoopGetMain(), obs, .commonModes)
            DispatchQueue.main.async {
                if idx < timings.count { timings[idx]["ms"] = ms(t0); timings[idx]["n"] = m.flat.count }
                say(["text": t, "rows": m.flat.count])
            }
            return
        }
        if let k = c["key"] as? String {
            guard let e = event(k, cmd: VJ.truthy(c["cmd"]), shift: VJ.truthy(c["shift"])) else { say(["error": "no key \(k)"]); return }
            say(["key": k, "handled": a.panel.key(e)])
            return
        }
        if VJ.truthy(c["probe"]) { say(probe(a)); return }
        if let strokes = c["strokes"] as? [[String: Any]] {
            // Real key events through this window alone (never posted to the system): the monitor, the key handler and the
            // text field see them as they see a keyboard. {chars, ignoring?, code, shift?, option?, control?, command?}.
            let panel = a.panel.panel
            panel.makeKey()
            var typed = 0
            for k in strokes {
                var f: NSEvent.ModifierFlags = []
                if VJ.truthy(k["shift"]) { f.insert(.shift) }
                if VJ.truthy(k["option"]) { f.insert(.option) }
                if VJ.truthy(k["control"]) { f.insert(.control) }
                if VJ.truthy(k["command"]) { f.insert(.command) }
                let chars = (k["chars"] as? String) ?? ""
                let code = UInt16((k["code"] as? Int) ?? 0)
                for type in [NSEvent.EventType.keyDown, .keyUp] {
                    if let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: f, timestamp: ProcessInfo.processInfo.systemUptime,
                                                windowNumber: panel.windowNumber, context: nil, characters: chars,
                                                charactersIgnoringModifiers: (k["ignoring"] as? String) ?? chars, isARepeat: false, keyCode: code) {
                        NSApp.sendEvent(e)
                    }
                }
                typed += 1
            }
            say(["strokes": typed, "key": panel.isKeyWindow, "text": m.text]); return
        }
        if VJ.truthy(c["windowid"]) { say(["windowid": a.panel.panel.windowNumber, "visible": a.panel.panel.isVisible]); return }
        if VJ.truthy(c["views"]) {
            // What the server gave this Lumen: which tools it has, the module commands it read, the next meeting.
            let tools = ["mentions.search", "capsule.commands", "capsule.view", "capsule.act"]
            say(["tools": Dictionary(uniqueKeysWithValues: tools.map { ($0, a.vyred.has($0)) }), "up": a.vyred.isUp,
                 "commands": a.viewCommands.commands.map { "\($0.module)/\($0.id)" }, "nextMeeting": m.nextMeeting ?? NSNull(),
                 "hash": m.hashToken != nil]); return
        }
        if VJ.truthy(c["timings"]) {
            // "All rows": when the last publish of this keystroke's rows landed (Spotlight and the like append).
            let out: [[String: Any]] = timings.map { e in
                var e = e
                if let tok = e["token"] as? Int, let t0 = e["t0"] as? UInt64 {
                    let last = m.publishLog.filter { $0.token == tok }.map(\.at).max()
                    if let last, last >= t0 { e["all"] = Double(last - t0) / 1e6 }
                }
                e["t0"] = nil
                return e
            }
            let from = (c["since"] as? Int) ?? 0
            say(["timings": Array(out.dropFirst(max(0, from))), "count": out.count]); return
        }
        if VJ.truthy(c["memory"]) { say(["memory": memory()]); return }
        say(["error": "unknown command"])
    }

    static func probe(_ a: CapsuleApp) -> [String: Any] {
        let m = a.model
        var desk = "none"
        switch m.desk.mode { case .none: desk = "none"; case .list(let i): desk = "list:\(i)"; case .card(let k): desk = "card:\(k)" }
        return ["shown": a.panel.isShown, "text": m.text, "rows": m.flat.map { r -> [String: Any] in
            var row: [String: Any] = ["kind": r.kind, "title": r.title, "sub": r.subtitle]
            // A row's symbol and whether the system has it: an unknown name drew an empty tile (the # picker's connectors, #31).
            if case .symbol(let n, _) = r.icon { row["symbol"] = n; row["symbolOK"] = NSImage(systemSymbolName: n, accessibilityDescription: nil) != nil }
            return row },
                "selected": m.selected, "line": m.line ?? NSNull(), "asked": m.asked ?? NSNull(), "reply": m.replyText,
                "finished": m.reply?.finished ?? NSNull(), "waiting": m.desk.waiting.map(\.title), "desk": desk,
                "direct": m.direct.dm.map { d in d.messages.map { "\($0.role.rawValue): \($0.text)" } } ?? NSNull(),
                "offline": m.offline, "target": m.target?.label ?? NSNull()]
    }

    /// TASK_VM_INFO for this task, in bytes, and the default malloc zones' totals.
    static func memory() -> [String: Any] {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        guard kr == KERN_SUCCESS else { return ["error": Int(kr)] }
        var z = malloc_statistics_t()
        malloc_zone_statistics(nil, &z)
        return ["footprint": Int(info.phys_footprint), "resident": Int(info.resident_size), "internal": Int(info.internal),
                "compressed": Int(info.compressed), "mallocInUse": Int(z.size_in_use), "mallocAllocated": Int(z.size_allocated)]
    }

    static func ms(_ t0: DispatchTime) -> Double { Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e6 }

    static let codes: [String: UInt16] = ["return": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53, "left": 123, "right": 124, "down": 125, "up": 126]

    static func event(_ k: String, cmd: Bool, shift: Bool) -> NSEvent? {
        var flags: NSEvent.ModifierFlags = []
        if cmd { flags.insert(.command) }
        if shift { flags.insert(.shift) }
        let letters: [String: UInt16] = ["a": 0, "c": 8, "k": 40, "v": 9]
        let code = codes[k] ?? letters[k.lowercased()] ?? 0
        let chars = codes[k] != nil ? "" : k
        return NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: app?.panel.panel.windowNumber ?? 0,
                                context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)
    }
}

extension PanelController {
    /// Shown for a script: in front and drawn, but it does not take key focus from anyone.
    /// Says how long each part took, in milliseconds, for the speed check.
    @discardableResult
    func showForDrive() -> [String: Double] {
        func ms(_ t: DispatchTime) -> Double { Double(DispatchTime.now().uptimeNanoseconds - t.uptimeNanoseconds) / 1e6 }
        var out: [String: Double] = [:]
        var t = DispatchTime.now()
        model.willShow(front: nil); out["model"] = ms(t); t = .now()
        extensions?.willShow(front: nil); out["extensions"] = ms(t); t = .now()
        let f = Self.screenUnderMouse().frame
        top = f.maxY - (f.height * Theme.topFraction).rounded()
        let h = height()
        panel.setFrame(NSRect(x: (f.midX - Theme.width / 2).rounded(), y: top - h, width: Theme.width, height: h), display: false)
        out["frame"] = ms(t); t = .now()
        panel.orderFrontRegardless(); out["orderFront"] = ms(t)
        return out
    }
}
