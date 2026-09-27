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

@MainActor
enum Drive {
    static var app: CapsuleApp?
    static var timings: [[String: Any]] = []

    static func start(_ a: CapsuleApp) {
        guard ProcessInfo.processInfo.environment["VYRE_CAPSULE_DRIVE"] == "1" else { return }
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
            a.panel.showForDrive()
            DispatchQueue.main.async { timings.append(["kind": "open", "ms": ms(t0)]); say(["shown": true]) }
            return
        }
        if VJ.truthy(c["hide"]) { a.panel.hide(); say(["hidden": true]); return }
        if let t = c["text"] as? String {
            let t0 = DispatchTime.now()
            m.text = t
            // The quick rows are drawn in this frame; the rest land after. Report both.
            DispatchQueue.main.async {
                timings.append(["kind": "results", "ms": ms(t0), "n": m.flat.count])
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
        if VJ.truthy(c["timings"]) { say(["timings": timings]); return }
        if VJ.truthy(c["memory"]) { say(["memory": memory()]); return }
        say(["error": "unknown command"])
    }

    static func probe(_ a: CapsuleApp) -> [String: Any] {
        let m = a.model
        var desk = "none"
        switch m.desk.mode { case .none: desk = "none"; case .list(let i): desk = "list:\(i)"; case .card(let k): desk = "card:\(k)" }
        return ["shown": a.panel.isShown, "text": m.text, "rows": m.flat.map { ["kind": $0.kind, "title": $0.title, "sub": $0.subtitle] },
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
    func showForDrive() {
        model.willShow(front: nil)
        extensions?.willShow(front: nil)
        let f = Self.screenUnderMouse().frame
        top = f.maxY - (f.height * Theme.topFraction).rounded()
        let h = height()
        panel.setFrame(NSRect(x: (f.midX - Theme.width / 2).rounded(), y: top - h, width: Theme.width, height: h), display: false)
        panel.orderFrontRegardless()
    }
}
