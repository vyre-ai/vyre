// capsule-suite: oversightSuite
// The oversight panel against a fake vyred and a fake window: no real window, no dialog, no agent.

import AppKit
import Foundation
import SwiftUI

private final class OvLink: VyredLink, @unchecked Sendable {
    private let lock = NSLock()
    private var tools: Set<String>
    private var log: [(String, [String: Any])] = []
    var failWith: String?
    init(tools: Set<String> = ["chrome.pause", "chrome.resume", "chrome.stop", "chrome.plan.edit", "chrome.interject"]) { self.tools = tools }
    var isUp: Bool { true }
    func has(_ tool: String) -> Bool { lock.withLock { tools.contains(tool) } }
    func call(_ tool: String, _ input: [String: Any], presence: Bool) async -> VyredResult {
        lock.withLock { log.append((tool, input)) }
        if let f = failWith { return .failure(code: "refused", message: f) }
        return .success(["ok": true])
    }
    func calls(_ tool: String) -> [[String: Any]] { lock.withLock { log.filter { $0.0 == tool }.map(\.1) } }
    var all: [String] { lock.withLock { log.map(\.0) } }
    func on(_ pattern: String, _ handler: @escaping @MainActor (VyredEvent) -> Void) -> VyredSubscription {
        lock.withLock { handlers.append(handler) }
        return Sub()
    }
    private var handlers: [@MainActor (VyredEvent) -> Void] = []
    @MainActor func emit(_ e: VyredEvent) { lock.withLock { handlers }.forEach { $0(e) } }
    func stream(_ path: String, onMessage: @escaping @Sendable ([String: Any]) -> Void,
                onClose: @escaping @Sendable () -> Void) async -> Result<VyredStream, VyredStreamFailure> {
        .failure(VyredStreamFailure(code: "refused", message: "no stream in this test"))
    }
    final class Sub: VyredSubscription { func cancel() {} }
}

@MainActor
private final class OvWindow: SessionWindow {
    var isOpen = false
    var frame: NSRect = .zero
    var shows = 0, closes = 0
    var onMoved: ((NSRect) -> Void)?
    func show(_ content: AnyView, frame: NSRect) { shows += 1; isOpen = true; self.frame = frame }
    func setFrame(_ frame: NSRect, duration: TimeInterval) { self.frame = frame }
    func close() { closes += 1; isOpen = false }
    /// What the person's drag does: the window moves and says so.
    func drag(to origin: NSPoint) { frame.origin = origin; onMoved?(frame) }
}

@MainActor
private final class OvHost: CapsuleHost {
    let vyred: VyredLink
    var front: FrontApp? = nil
    var isShown = false
    let window = OvWindow()
    var floats = 0, sessions = 0
    init(_ link: VyredLink) { vyred = link }
    func permission(_ p: Permission) -> PermissionState { .notAsked }
    func request(_ p: Permission, reason: String) async -> Bool { false }
    func showPanel(_ extensionID: String) {}
    func hidePanel() {}
    func setQuery(_ text: String) {}
    func say(_ line: String) {}
    func stepAside() async -> Bool { false }
    func notify(title: String, body: String) {}
    func log(_ message: String) {}
    func floatingWindow(owner: String) -> SessionWindow { floats += 1; return window }
    func sessionWindow(owner: String) -> SessionWindow { sessions += 1; return NoSessionWindow() }
}

private func ev(_ type: String, _ payload: [String: Any], thread: String? = nil) -> VyredEvent {
    VyredEvent(id: 1, type: type, source: "hands", thread: thread, project: nil, at: 1_700_000_000_000, payload: payload)
}

private func plan(_ run: String = "r1", _ states: [String] = ["done", "done", "current", "todo", "todo"]) -> VyredEvent {
    let texts = ["Create the workflow", "Add a trigger", "Add a 10-minute delay, then an SMS step", "Add the owner filter", "Publish and test"]
    return ev("chrome.plan", ["run": run, "title": "Building the automation",
        "steps": states.enumerated().map { ["id": "s\($0.offset + 1)", "text": texts[$0.offset % texts.count], "state": $0.element] as [String: Any] }])
}

private let SCREEN = NSRect(x: 0, y: 30, width: 1600, height: 900)

@MainActor
private func make(_ link: OvLink = OvLink()) -> (OvHost, OversightExtension, OvLink) {
    let host = OvHost(link)
    let ext = OversightExtension(host: host)
    ext.screen = { SCREEN }
    var saved: NSPoint?
    ext.store = (get: { saved }, set: { saved = $0 })
    ext.model.linger = .milliseconds(30)
    return (host, ext, link)
}

/// Spin the main loop until cond holds (up to 3 s).
@MainActor private func settle(_ cond: () -> Bool) -> Bool {
    let until = Date().addingTimeInterval(3)
    while !cond() {
        if Date() > until { return false }
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
    }
    return true
}

let oversightSuite = Suite("oversight") { t in
    t.test("nothing shows and no window is made until a plan arrives") {
        MainActor.assumeIsolated {
            let (host, ext, link) = make()
            link.emit(ev("chrome.acted", ["run": "r1"]))
            link.emit(ev("chrome.voice", ["run": "r1", "text": "hello"]))
            t.ok(!ext.isOpen); t.eq(host.floats, 0); t.eq(host.sessions, 0)
            t.eq(ext.runsHidden, nil)
        }
    }

    t.test("a plan opens the panel at the top right with the run's steps and current step") {
        MainActor.assumeIsolated {
            let (host, ext, link) = make()
            link.emit(plan())
            t.ok(ext.isOpen); t.eq(host.floats, 1); t.eq(host.sessions, 0)
            let r = ext.model.active
            t.eq(r?.title, "Building the automation"); t.eq(r?.steps.count, 5)
            t.eq(r?.currentIndex, 2); t.eq(r?.done, 2)
            let f = host.window.frame
            t.eq(f.width, OversightLayout.width)
            t.eq(f.maxX, SCREEN.maxX - 24); t.eq(f.maxY, SCREEN.maxY - 24)
            t.ok(ext.runsHidden != nil)
        }
    }

    t.test("chrome.step moves one step; an unknown step or run is ignored") {
        MainActor.assumeIsolated {
            let (_, ext, link) = make()
            link.emit(plan())
            link.emit(ev("chrome.step", ["run": "r1", "step": "s3", "state": "done"]))
            link.emit(ev("chrome.step", ["run": "r1", "step": "s4", "state": "current"]))
            link.emit(ev("chrome.step", ["run": "r1", "step": "nope", "state": "done"]))
            link.emit(ev("chrome.step", ["run": "other", "step": "s1", "state": "todo"]))
            link.emit(ev("chrome.step", ["run": "r1", "step": "s5", "state": "bogus"]))
            let r = ext.model.active
            t.eq(r?.steps.map(\.state), [.done, .done, .done, .current, .todo])
            t.eq(ext.model.runs.count, 1)
        }
    }

    t.test("a run found only by its thread is followed") {
        MainActor.assumeIsolated {
            let (_, ext, link) = make()
            var e = plan(); e.payload["run"] = nil; e.thread = "t9"
            link.emit(e)
            t.eq(ext.model.active?.id, "t9")
        }
    }

    t.test("the person's words show until the plan answers them") {
        MainActor.assumeIsolated {
            let (_, ext, link) = make()
            link.emit(plan())
            link.emit(ev("chrome.voice", ["run": "r1", "text": "...and skip weekends", "final": false]))
            t.eq(ext.model.active?.voice, "...and skip weekends")
            link.emit(ev("chrome.voice", ["run": "r1", "text": "...and skip weekends.", "final": true]))
            t.eq(ext.model.active?.voice, "...and skip weekends.")
            link.emit(plan())
            t.eq(ext.model.active?.voice, nil)
        }
    }

    t.test("finishing lingers, then lets go; stopping closes at once") {
        MainActor.assumeIsolated {
            let (host, ext, link) = make()
            link.emit(plan("r1", ["done", "done", "done", "done", "done"]))
            t.ok(ext.isOpen)
            t.ok(settle { !ext.isOpen }, "closed after the linger")
            t.eq(ext.model.runs.count, 0)
            link.emit(plan("r2"))
            t.ok(ext.isOpen)
            link.emit(ev("chrome.stopped", ["run": "r2", "by": "person"]))
            t.ok(!ext.isOpen); t.eq(host.window.closes, 2); t.eq(ext.runsHidden, nil)
        }
    }

    t.test("a new plan for a finished run cancels its linger") {
        MainActor.assumeIsolated {
            let (_, ext, link) = make()
            link.emit(plan("r1", ["done", "done"]))
            link.emit(plan("r1", ["done", "done", "todo"]))
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.15))
            t.ok(ext.isOpen); t.eq(ext.model.runs.count, 1)
        }
    }

    t.test("the most recently changed run leads; stopping it shows the other") {
        MainActor.assumeIsolated {
            let (_, ext, link) = make()
            link.emit(plan("a")); link.emit(plan("b"))
            t.eq(ext.model.active?.id, "b")
            link.emit(ev("chrome.step", ["run": "a", "step": "s4", "state": "current"]))
            t.eq(ext.model.active?.id, "a")
            link.emit(ev("chrome.stopped", ["run": "a"]))
            t.eq(ext.model.active?.id, "b"); t.ok(ext.isOpen)
        }
    }

    t.test("pause, resume and stop are the person's own calls, keyed by run, no presence prompt") {
        let link = OvLink()
        let ok: Bool? = MainActor.assumeIsolated { () -> Bool in
            let (_, ext, _) = make(link)
            link.emit(plan())
            ext.model.pause()
            _ = settle { link.calls("chrome.pause").count == 1 }
            link.emit(ev("chrome.paused", ["run": "r1"]))
            let paused = ext.model.active?.paused == true
            ext.model.pause()
            _ = settle { link.calls("chrome.resume").count == 1 }
            link.emit(ev("chrome.resumed", ["run": "r1"]))
            ext.model.stop()
            _ = settle { link.calls("chrome.stop").count == 1 }
            return paused && ext.model.active?.paused == false
        }
        t.eq(ok, true)
        t.eq(link.calls("chrome.pause").first?["run"] as? String, "r1")
        t.eq(link.calls("chrome.resume").count, 1)
        t.eq(link.calls("chrome.stop").count, 1)
    }

    t.test("a failed step ends and shows; a run whose hands.* events named it is paused through hands.*") {
        let link = OvLink(tools: ["chrome.pause", "chrome.resume", "chrome.stop", "hands.pause", "hands.resume", "hands.stop"])
        let ok: Bool? = MainActor.assumeIsolated { () -> Bool in
            let (_, ext, _) = make(link)
            link.emit(plan())
            link.emit(ev("chrome.step", ["run": "r1", "id": "s2", "status": "failed", "state": "failed"]))
            let failed = ext.model.active?.steps.first(where: { $0.id == "s2" })?.state == .failed
            link.emit(ev("hands.resumed", ["run": "r1"]))
            ext.model.pause()
            _ = settle { link.calls("hands.pause").count == 1 }
            return failed
        }
        t.eq(ok, true)
        t.eq(link.calls("hands.pause").first?["run"] as? String, "r1")
        t.eq(link.calls("chrome.pause").count, 0)
    }

    t.test("chrome.finished closes a run: a bad finish at once, a good one after the linger") {
        MainActor.assumeIsolated {
            let (_, ext, link) = make()
            link.emit(plan("r1")); link.emit(plan("r2"))
            link.emit(ev("chrome.finished", ["run": "r1", "ok": false]))
            t.eq(ext.model.runs.map { $0.id }, ["r2"])
            link.emit(ev("chrome.finished", ["run": "r2", "ok": true]))
            t.ok(ext.isOpen)
            t.ok(settle { !ext.isOpen }, "closed after the linger")
        }
    }

    t.test("only a step that has not started can be retexted; empty or unchanged text sends nothing") {
        let link = OvLink()
        _ = MainActor.assumeIsolated { () -> Bool in
            let (_, ext, _) = make(link)
            link.emit(plan())
            ext.model.edit(step: "s3", to: "Something else")      // running: refused
            ext.model.edit(step: "s1", to: "Something else")      // done: refused
            ext.model.edit(step: "s4", to: "   ")                 // empty
            ext.model.edit(step: "s4", to: "Add the owner filter") // unchanged
            ext.model.edit(step: "s5", to: "  Publish, then test with two leads  ")
            _ = settle { link.calls("chrome.plan.edit").count == 1 }
            return true
        }
        let edits = link.calls("chrome.plan.edit")
        t.eq(edits.count, 1)
        t.eq(edits.first?["step"] as? String, "s5")
        t.eq(edits.first?["text"] as? String, "Publish, then test with two leads")
        t.eq(edits.first?["run"] as? String, "r1")
    }

    t.test("steering sends the words trimmed; the plan the agent resends is what changes") {
        let link = OvLink()
        _ = MainActor.assumeIsolated { () -> Bool in
            let (_, ext, _) = make(link)
            link.emit(plan())
            ext.model.steer("   "); ext.model.steer(" skip weekends ")
            _ = settle { link.calls("chrome.interject").count == 1 }
            t.eq(ext.model.active?.steps.count, 5)
            return true
        }
        t.eq(link.calls("chrome.interject").map { $0["text"] as? String }, ["skip weekends"])
    }

    t.test("a refused call is said in words under the controls, then the window grows to fit it") {
        let link = OvLink()
        link.failWith = "That step already started."
        let ok: Bool? = MainActor.assumeIsolated { () -> Bool in
            let (host, ext, _) = make(link)
            link.emit(plan())
            let before = host.window.frame.height
            ext.model.stop()
            let said = settle { ext.model.line == "That step already started." }
            return said && host.window.frame.height > before
        }
        t.eq(ok, true)
    }

    t.test("controls this vyred cannot honour are not offered") {
        MainActor.assumeIsolated {
            let (_, ext, _) = make(OvLink(tools: ["chrome.stop"]))
            t.ok(!ext.model.canPause); t.ok(!ext.model.canEdit); t.ok(!ext.model.canSteer)
            let (_, ext2, _) = make()
            t.ok(ext2.model.canPause); t.ok(ext2.model.canEdit); t.ok(ext2.model.canSteer)
        }
    }

    t.test("making it small and back changes the height and keeps the top-left") {
        MainActor.assumeIsolated {
            let (host, ext, link) = make()
            link.emit(plan())
            let top = host.window.frame.maxY, left = host.window.frame.minX
            let full = host.window.frame.height
            ext.model.collapsed = true
            t.ok(host.window.frame.height < full - 100, "small \(host.window.frame.height) vs \(full)")
            t.eq(host.window.frame.maxY, top); t.eq(host.window.frame.minX, left)
            ext.model.collapsed = false
            t.eq(host.window.frame.height, full)
        }
    }

    t.test("a step event that adds no height does not redraw the window") {
        MainActor.assumeIsolated {
            let (host, _, link) = make()
            link.emit(plan())
            let shows = host.window.shows
            link.emit(ev("chrome.step", ["run": "r1", "step": "s3", "state": "done"]))
            link.emit(ev("chrome.step", ["run": "r1", "step": "s4", "state": "current"]))
            t.eq(host.window.shows, shows)
        }
    }

    t.test("layout: at most six steps, a window around the current one, with counts either side") {
        let steps = (1...12).map { OversightStep(id: "s\($0)", text: "Step \($0)", state: $0 < 8 ? .done : ($0 == 8 ? .current : .todo)) }
        let r = OversightRun(id: "r", title: "T", steps: steps)
        let v = OversightLayout.visible(r)
        t.eq(v.steps.map(\.id), ["s6", "s7", "s8", "s9", "s10", "s11"])
        t.eq(v.before, 5); t.eq(v.after, 1)
        let short = OversightRun(id: "r", title: "T", steps: Array(steps.prefix(4)))
        t.eq(OversightLayout.visible(short).steps.count, 4); t.eq(OversightLayout.visible(short).before, 0)
        // A long step takes two lines, never more.
        t.eq(OversightLayout.lines(String(repeating: "x", count: 200)), 2)
        t.eq(OversightLayout.lines("Short"), 1)
    }

    t.test("the last place the person dragged it is where it opens next, top-left kept") {
        MainActor.assumeIsolated {
            let (host, ext, link) = make()
            link.emit(plan())
            let h = host.window.frame.height
            host.window.drag(to: NSPoint(x: 300, y: 400))
            link.emit(ev("chrome.stopped", ["run": "r1"]))
            link.emit(plan("r2"))
            t.eq(host.window.frame.minX, 300)
            t.eq(host.window.frame.maxY, 400 + h)
            _ = ext
        }
    }

    t.test("a remembered place that is no longer on a screen is forgotten") {
        MainActor.assumeIsolated {
            let (host, ext, link) = make()
            link.emit(plan())
            host.window.drag(to: NSPoint(x: 9000, y: 9000))
            link.emit(ev("chrome.stopped", ["run": "r1"]))
            link.emit(plan("r2"))
            t.eq(host.window.frame.maxX, SCREEN.maxX - 24)
            _ = ext
        }
    }

    t.test("the window is as tall as the view, full, paused and small") {
        MainActor.assumeIsolated {
            let (host, ext, link) = make()
            link.emit(plan())
            link.emit(ev("chrome.voice", ["run": "r1", "text": "skip weekends"]))
            let full = NSHostingView(rootView: OversightView(model: ext.model)).fittingSize
            t.eq(full.width, OversightLayout.width)
            t.eq(host.window.frame.height, full.height)
            link.emit(ev("chrome.paused", ["run": "r1"]))
            ext.model.collapsed = true
            let small = NSHostingView(rootView: OversightView(model: ext.model)).fittingSize
            t.eq(host.window.frame.height, small.height)
            t.ok(small.height < 50 && small.height > 20, "small \(small.height)")
        }
    }
}
