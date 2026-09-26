// capsule-suite: sessionPanelSuite
// The session panel against a fake vyred, a fake host and a fake window: no real window, mic or
// dialog. Events are handed to the panel the way the host's SSE follower would.

import AppKit
import SwiftUI

private final class PanelLink: VyredLink, @unchecked Sendable {
    private let lock = NSLock()
    private var answers: [String: ([String: Any]) -> VyredResult] = [:]
    private var log: [(String, [String: Any])] = []
    @MainActor var handlers: [(String, (VyredEvent) -> Void)] = []
    var isUp: Bool { true }
    func answer(_ tool: String, _ fn: @escaping ([String: Any]) -> VyredResult) { lock.lock(); answers[tool] = fn; lock.unlock() }
    func has(_ tool: String) -> Bool { lock.lock(); defer { lock.unlock() }; return answers[tool] != nil }
    func call(_ tool: String, _ input: [String: Any], presence: Bool) async -> VyredResult {
        let fn = lock.withLock { log.append((tool, input)); return answers[tool] }
        return fn?(input) ?? .failure(code: "no_such_tool", message: "no such tool: \(tool)")
    }
    func calls(_ tool: String) -> [[String: Any]] { lock.lock(); defer { lock.unlock() }; return log.filter { $0.0 == tool }.map(\.1) }
    func on(_ pattern: String, _ handler: @escaping @MainActor (VyredEvent) -> Void) -> VyredSubscription {
        let sub = Sub()
        MainActor.assumeIsolated {
            handlers.append((pattern, handler))
            let i = handlers.count - 1
            sub.cancelled = { [weak self] in MainActor.assumeIsolated { self?.handlers[i].1 = { _ in }; self?.live -= 1 } }
            live += 1
        }
        return sub
    }
    @MainActor var live = 0
    @MainActor func emit(_ e: VyredEvent) { for (_, h) in handlers { h(e) } }
    final class Sub: VyredSubscription { var cancelled: () -> Void = {}; func cancel() { cancelled(); cancelled = {} } }
}

@MainActor
private final class FakeWindow: SessionWindow {
    var isOpen = false
    var frame: NSRect = .zero
    var moves: [(NSRect, TimeInterval)] = []
    var curves: [SessionWindowCurve] = []
    var shows = 0
    func show(_ content: AnyView, frame: NSRect) { shows += 1; isOpen = true; self.frame = frame }
    func setFrame(_ frame: NSRect, duration: TimeInterval) { moves.append((frame, duration)); self.frame = frame }
    func setFrame(_ frame: NSRect, duration: TimeInterval, curve: SessionWindowCurve) { curves.append(curve); setFrame(frame, duration: duration) }
    func close() { isOpen = false }
}

@MainActor
private final class PanelHost: CapsuleHost {
    let vyred: VyredLink
    var front: FrontApp? = nil
    var isShown = true
    var said: [String] = []
    var changed = 0
    let window = FakeWindow()
    init(_ link: VyredLink) { vyred = link }
    func permission(_ p: Permission) -> PermissionState { .notAsked }
    func request(_ p: Permission, reason: String) async -> Bool { false }
    func showPanel(_ extensionID: String) {}
    func hidePanel() {}
    func setQuery(_ text: String) {}
    func say(_ line: String) { said.append(line) }
    func stepAside() async -> Bool { false }
    func notify(title: String, body: String) {}
    func log(_ message: String) {}
    func sessionWindow(owner: String) -> SessionWindow { window }
    func commandsChanged() { changed += 1 }
}

/// The threads.list answer, changed by a test while the extension reads it.
private final class Names: @unchecked Sendable {
    private let lock = NSLock()
    private var rows: [[String: String]]
    init(_ rows: [[String: String]]) { self.rows = rows }
    var list: [[String: String]] { lock.withLock { rows } }
    func add(_ row: [String: String]) { lock.withLock { rows.append(row) } }
}

private let VISIBLE = NSRect(x: 0, y: 80, width: 1800, height: 1057)

private func ev(_ id: Int, _ type: String, _ thread: String, _ payload: [String: Any]) -> VyredEvent {
    VyredEvent(id: id, type: type, source: "switchboard", thread: thread, project: nil, at: 1_700_000_000_000 + id, payload: payload)
}

/// A vyred with juno (the assistant, thread t1), a Harlow Legal session (t2), and a history.
private func world() -> PanelLink {
    let link = PanelLink()
    link.answer("agents.list") { _ in .success([["name": "juno", "kind": "assistant", "thread": "t1"], ["name": "kit", "kind": "agent"]]) }
    link.answer("threads.list") { _ in .success([["id": "t1", "name": "juno"], ["id": "t2", "name": "Harlow Legal", "status": "idle"]]) }
    link.answer("threads.get") { input in
        let t = input["thread"] as? String ?? ""
        return .success(["thread": ["id": t, "status": "idle"], "asks": [], "events": [
            ["id": 5, "type": "thread.sent", "at": 1, "payload": ["text": "When does Northwind Bakery open?", "surface": "deck"]],
            ["id": 6, "type": "thread.text", "at": 2, "payload": ["message": "m1", "text": "At seven.", "done": true]],
            ["id": 7, "type": "thread.finished", "at": 3, "payload": ["ok": true]],
        ]])
    }
    link.answer("sideview.open") { input in .success(["open": true, "exact": true, "left": ["app": "Vyre"], "right": ["app": input["browser"] == nil ? "Google Chrome" : "Glass"]]) }
    link.answer("sideview.close") { _ in .success(["open": false, "restored": 1]) }
    link.answer("agents.ask") { _ in .success(["ok": true, "thread": "t1"]) }
    link.answer("threads.send") { _ in .success(["queued": true, "name": "Harlow Legal"]) }
    return link
}

@MainActor private func panelExt(_ link: PanelLink) -> (PanelHost, SightExtension) {
    let host = PanelHost(link)
    let ext = SightExtension(host: host)
    ext.screen = { (VISIBLE, 1170) }
    ext.settle = .zero
    return (host, ext)
}

let sessionPanelSuite = Suite("session panel") { t in
    t.test("sessions: the assistant first, its own thread not listed twice") {
        let s = PanelSession.load(agents: [["name": "juno", "kind": "assistant", "thread": "t1"]],
                                  threads: [["id": "t1"], ["id": "t2", "name": "Harlow Legal"], ["id": "t3", "cwd": "/work/northwind"]])
        t.eq(s.map(\.label), ["juno", "Harlow Legal", "northwind"])
        t.ok(s[0].isAssistant); t.eq(s[0].thread, "t1"); t.eq(s[2].thread, "t3")
        t.eq(PanelSession.load(agents: nil, threads: nil), [])
    }

    t.test("geometry: 29% of the visible frame, slides from past the left edge, AX points for sideview") {
        let p = SideGeometry.panel(VISIBLE)
        t.eq(p, NSRect(x: 0, y: 80, width: 522, height: 1057))
        t.eq(SideGeometry.offscreen(p).minX, -522)
        let ax = SideGeometry.axFrame(p, primaryMaxY: 1170)
        t.eq(ax["x"] as? Int, 0); t.eq(ax["y"] as? Int, 33); t.eq(ax["w"] as? Int, 522); t.eq(ax["h"] as? Int, 1057)
    }

    t.test("open: slides in, fits Chrome beside the panel's frame, shows the assistant's history, follows events") {
        let link = world()
        let r = t.wait { @MainActor () -> [String] in
            let (host, ext) = panelExt(link)
            let out = await ext.openPanel(nil, glass: false)
            let w = host.window
            var got = ["\(out)", "shows \(w.shows)", "moves \(w.moves.map { "\(Int($0.0.minX)) \($0.1)" })",
                       "hidden \(ext.runsHidden != nil)", "msgs \(ext.panel.view.messages.map(\.text))", "live \(link.live)"]
            // A live reply on this thread lands; one on another thread does not.
            link.emit(ev(8, "thread.sent", "t1", ["text": "And on Sunday?", "surface": "deck"]))
            link.emit(ev(9, "thread.text", "t1", ["message": "m2", "delta": "Nine "]))
            link.emit(ev(10, "thread.text", "t2", ["message": "mx", "delta": "not this"]))
            link.emit(ev(11, "thread.text", "t1", ["message": "m2", "delta": "on Sundays."]))
            got.append("after \(ext.panel.view.messages.map(\.text)) busy \(ext.panel.dm.busy)")
            got.append("rows \(ext.commands.map(\.title).filter { $0.hasPrefix("Side view:") })")
            return got
        }
        t.eq(r?[0], "\(ActionOutcome.close("juno on the left, Google Chrome on the right"))")
        t.eq(r?[1], "shows 1")
        t.eq(r?[2], "moves [\"0 0.25\"]", "shown past the edge, then one 0.25 s slide to x 0")
        t.eq(r?[3], "hidden true")
        t.eq(r?[4], "msgs [\"When does Northwind Bakery open?\", \"At seven.\"]")
        t.eq(r?[5], "live 3", "its thread, plus session starts and stops for the tabs")
        t.eq(r?[6], "after [\"When does Northwind Bakery open?\", \"At seven.\", \"And on Sunday?\", \"Nine on Sundays.\"] busy true")
        t.eq(r?[7], "rows [\"Side view: Harlow Legal\"]")
        let open = link.calls("sideview.open").first ?? [:]
        let panel = open["panel"] as? [String: Any] ?? [:]
        t.eq(panel["y"] as? Int, 33); t.eq(panel["w"] as? Int, 522)
        t.ok(open["session"] == nil, "the panel is not moved by AX")
        t.eq(link.calls("threads.get").first?["thread"] as? String, "t1")
    }

    t.test("send: to the assistant through agents.ask, shown at once; to a busy terminal session, queued in words") {
        let link = world()
        let r = t.wait { @MainActor () -> [String] in
            let (_, ext) = panelExt(link)
            _ = await ext.openPanel(nil, glass: true)
            ext.panel.draft = "two dozen rolls for kit"
            await ext.panel.send()
            var got = ["\(ext.panel.view.messages.last?.text ?? "") pending \(ext.panel.view.messages.last?.pending ?? false)", "draft \(ext.panel.draft)"]
            let harlow = ext.panel.sessions.first { $0.label == "Harlow Legal" }!
            await ext.panel.show(harlow)
            ext.panel.draft = "file the Harlow Legal notes"
            await ext.panel.send()
            got.append(ext.panel.line ?? "no line")
            return got
        }
        t.eq(r?[0], "two dozen rolls for kit pending true")
        t.eq(r?[1], "draft ")
        t.eq(r?[2], "Harlow Legal is busy in your terminal. Your words go in when this turn ends.")
        let ask = link.calls("agents.ask").first ?? [:]
        t.eq(ask["agent"] as? String, "juno"); t.eq(ask["surface"] as? String, "capsule"); t.eq(ask["wait"] as? Bool, false)
        t.eq(link.calls("threads.send").first?["thread"] as? String, "t2")
        t.eq(link.calls("sideview.open").first?["browser"] as? String, "glass")
    }

    t.test("send: a refusal takes the pending words back out and returns them to the box") {
        let link = world()
        link.answer("agents.ask") { _ in .failure(code: "denied", message: "juno is paused") }
        let r = t.wait { @MainActor () -> [String] in
            let (_, ext) = panelExt(link)
            _ = await ext.openPanel(nil, glass: false)
            ext.panel.draft = "hello"
            await ext.panel.send()
            return ["\(ext.panel.view.messages.count)", ext.panel.draft, ext.panel.line ?? ""]
        }
        t.eq(r?[0], "2"); t.eq(r?[1], "hello"); t.ok((r?[2] ?? "").contains("paused"))
    }

    t.test("close: slides out, closes, puts Chrome back, and stops following") {
        let link = world()
        let r = t.wait { @MainActor () -> [String] in
            let (host, ext) = panelExt(link)
            _ = await ext.openPanel(nil, glass: false)
            let out = await ext.closeSideView()
            ext.capsuleDidHide()
            return ["\(out)", "open \(host.window.isOpen)", "last \(Int(host.window.moves.last?.0.minX ?? 0)) \(host.window.curves.map { $0 == .easeOut ? "out" : $0 == .easeIn ? "in" : "other" })",
                    "hidden \(ext.runsHidden == nil ? "nil" : "set")", "live \(link.live)"]
        }
        t.eq(r?[0], "\(ActionOutcome.close("Put 1 window back"))")
        t.eq(r?[1], "open false"); t.eq(r?[2], "last -522 [\"out\", \"in\"]"); t.eq(r?[3], "hidden nil"); t.eq(r?[4], "live 0")
        t.eq(link.calls("sideview.close").count, 1)
    }

    t.test("open: Chrome that cannot be fitted is said, and no session at all is a failure") {
        let link = world()
        link.answer("sideview.open") { _ in .failure(code: "no_browser", message: "Chrome did not show a window in time") }
        let r = t.wait { @MainActor () -> [String] in
            let (_, ext) = panelExt(link)
            let a = await ext.openPanel(nil, glass: false)
            let empty = PanelLink()
            let (_, ext2) = panelExt(empty)
            let b = await ext2.openPanel(nil, glass: false)
            return ["\(a)", "\(b)"]
        }
        t.eq(r?[0], "\(ActionOutcome.failed("juno is on the left; Chrome could not be fitted: Chrome did not show a window in time"))")
        t.eq(r?[1], "\(ActionOutcome.failed("No session to show yet: make your assistant in Vyre, or start a session"))")
    }

    t.test("sessions: live terminal sessions from the catalog after the assistant, stale ones and switchboard duplicates left out") {
        let now: Double = 1_700_000_000_000
        let catalog: [String: Any] = ["sessions": [
            ["id": "s-live", "label": "northwind menu", "cwd": "/work/northwind", "last": now - 60_000],
            ["id": "s-old", "label": "last week", "last": now - 3_600_000],
            ["id": "t2", "label": "Harlow Legal", "last": now - 1000],
            ["id": "s-cwd", "cwd": "/work/harlow-legal", "last": now - 5000],
        ]]
        let s = PanelSession.load(agents: [["name": "juno", "kind": "assistant", "thread": "t1"]],
                                  threads: [["id": "t1"], ["id": "t2", "name": "Harlow Legal"]], catalog: catalog, now: now)
        t.eq(s.map(\.label), ["juno", "northwind menu", "harlow-legal", "Harlow Legal"])
        t.ok(s[1].isTerminal); t.eq(s[1].thread, "s-live"); t.eq(s[1].id, "terminal:s-live")
        t.ok(!s[3].isTerminal, "a session the switchboard runs stays a thread tab")
    }

    t.test("terminal tab: newest turns from the index, marked as lagging, words still go through threads.send") {
        let link = world()
        let now = vyNowMs()
        link.answer("projects.catalog") { _ in .success(["sessions": [["id": "s-live", "label": "northwind menu", "last": now - 1000]]]) }
        link.answer("recall.thread") { input in
            let from = input["from"] as? Int ?? 0
            let all: [[String: Any]] = (0..<70).map { i in ["seq": i, "role": i % 2 == 0 ? "user" : "assistant", "ts": 1_700_000_000_000 + Double(i), "text": "turn \(i)"] }
            let limit = input["limit"] as? Int ?? 200
            return .success(["session": ["id": "s-live", "turns": 70], "turns": Array(all[min(from, 70)..<min(from + limit, 70)])])
        }
        let r = t.wait { @MainActor () -> [String] in
            let (_, ext) = panelExt(link)
            _ = await ext.openPanel(nil, glass: false)
            let tab = ext.panel.sessions.first { $0.isTerminal }!
            await ext.panel.show(tab)
            var got = ["note \(ext.panel.note ?? "nil")", "count \(ext.panel.dm.messages.count)",
                       "first \(ext.panel.dm.messages.first?.text ?? "") \(ext.panel.dm.messages.first?.role == .user)",
                       "last \(ext.panel.dm.messages.last?.text ?? "")"]
            ext.panel.draft = "add rye to the northwind menu"
            await ext.panel.send()
            got.append(ext.panel.line ?? "no line")
            // Back on the assistant, the lag note goes.
            await ext.panel.show(ext.panel.sessions[0])
            got.append("note \(ext.panel.note ?? "nil")")
            return got
        }
        t.eq(r?[0], "note \(SessionPanelModel.lagNote)")
        t.eq(r?[1], "count 60")
        t.eq(r?[2], "first turn 10 true")
        t.eq(r?[3], "last turn 69")
        t.ok((r?[4] ?? "").contains("busy in your terminal"), r?[4] ?? "")
        t.eq(r?[5], "note nil")
        let reads = link.calls("recall.thread")
        t.eq(reads.count, 2); t.eq(reads[0]["limit"] as? Int, 1); t.eq(reads[1]["from"] as? Int, 10)
        t.eq(link.calls("threads.send").first?["thread"] as? String, "s-live")
    }

    t.test("terminal tab: a session not indexed yet says so, with no error") {
        let link = world()
        link.answer("recall.thread") { _ in .failure(code: "failed", message: "no session s-new") }
        let r = t.wait { @MainActor () -> [String] in
            let (_, ext) = panelExt(link)
            _ = await ext.openPanel(nil, glass: false)
            await ext.panel.show(PanelSession(id: "terminal:s-new", label: "kit", kind: .terminal, thread: "s-new"))
            return [ext.panel.note ?? "nil", ext.panel.line ?? "nil", "\(ext.panel.dm.messages.count) \(ext.panel.dm.loading)"]
        }
        t.eq(r?[0], "Not in the index yet; new words show here as they come"); t.eq(r?[1], "nil"); t.eq(r?[2], "0 false")
    }

    t.test("rows: a session starting or stopping re-reads the list and tells the Capsule once per change; hide stops following") {
        let link = world()
        let names = Names([["id": "t1", "name": "juno"], ["id": "t2", "name": "Harlow Legal"]])
        link.answer("threads.list") { _ in .success(names.list) }
        let r = t.wait { @MainActor () -> [String] in
            let (host, ext) = panelExt(link)
            ext.capsuleWillShow(front: nil)
            await ext.sessionsSettled()
            var got = ["first \(host.changed) \(ext.commands.map(\.title).filter { $0.hasPrefix("Side view:") })", "following \(ext.followingSessions)"]
            names.add(["id": "t3", "name": "kit"])
            link.emit(ev(20, "thread.started", "t3", [:]))
            await ext.sessionsSettled()
            got.append("started \(host.changed) \(ext.commands.map(\.title).filter { $0.hasPrefix("Side view:") })")
            link.emit(ev(21, "thread.stopped", "t1", [:]))
            await ext.sessionsSettled()
            got.append("same list \(host.changed)")
            ext.capsuleDidHide()
            got.append("hidden following \(ext.followingSessions) live \(link.live)")
            return got
        }
        t.eq(r?[0], "first 1 [\"Side view: Harlow Legal\"]")
        t.eq(r?[1], "following true")
        t.eq(r?[2], "started 2 [\"Side view: Harlow Legal\", \"Side view: kit\"]")
        t.eq(r?[3], "same list 2")
        t.eq(r?[4], "hidden following false live 0")
    }

    t.test("rows: with the panel open, hiding the Capsule keeps following and the tabs follow the list") {
        let link = world()
        let names = Names([["id": "t1", "name": "juno"], ["id": "t2", "name": "Harlow Legal"]])
        link.answer("threads.list") { _ in .success(names.list) }
        let r = t.wait { @MainActor () -> [String] in
            let (host, ext) = panelExt(link)
            ext.capsuleWillShow(front: nil)
            _ = await ext.openPanel(nil, glass: false)
            host.isShown = false
            ext.capsuleDidHide()
            names.add(["id": "t4", "name": "Northwind Bakery"])
            link.emit(ev(30, "thread.started", "t4", [:]))
            await ext.sessionsSettled()
            var got = ["following \(ext.followingSessions) tabs \(ext.panel.sessions.map(\.label))"]
            _ = await ext.closeSideView()
            got.append("after close \(ext.followingSessions)")
            return got
        }
        t.eq(r?[0], "following true tabs [\"juno\", \"Harlow Legal\", \"Northwind Bakery\"]")
        t.eq(r?[1], "after close false")
    }
}
