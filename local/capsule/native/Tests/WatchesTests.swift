// Watches and Glass, ported from lib/watch.test.js and lib/glass.test.js.
import Foundation

private func ev(_ id: Int, _ type: String, thread: String? = nil, at: Int = 0, _ payload: [String: Any] = [:]) -> VyredEvent {
    VyredEvent(id: id, type: type, source: "x", thread: thread, project: nil, at: at, payload: payload)
}

private let BOX = "https://alex.vyre.run"
private func glassCatalog(_ box: String? = BOX) -> VyreCatalog {
    VyreCatalog(agents: [VyreAgent(name: "harper", kind: "agent", thread: "t-cur", computer: true), VyreAgent(name: "juno", kind: "assistant"),
                         VyreAgent(name: "night owl", kind: "agent", computer: true)],
                threads: [VyreThread(id: "t-1", label: "Rebuild the intake deck", agent: "harper"), VyreThread(id: "t-cur", label: "Quarterly filings"),
                          VyreThread(id: "t-2", label: "Draft the rebuttal", agent: "juno")],
                box: box)
}

// capsule-suite: watchesSuite
let watchesSuite = Suite("watches") { t in
    t.test("fires once when the thread finishes, with the last thing it said") {
        let w = Watches()
        w.add("t1", label: "intake")
        t.ok(w.onEvent(ev(0, "thread.text", thread: "t2", ["done": true, "text": "other"])) == nil)
        t.ok(w.onEvent(ev(0, "thread.text", thread: "t1", ["done": true, "text": "All 42 tests pass."])) == nil)
        let r = w.onEvent(ev(9, "thread.finished", thread: "t1", at: 5, ["ok": true, "cost_usd": 0.01]))
        t.eq(r?.why, .finished); t.eq(r?.text, "All 42 tests pass."); t.eq(r?.cost, 0.01)
        t.eq(w.has("t1"), false, "a watch fires once")
        t.ok(w.onEvent(ev(0, "thread.finished", thread: "t1")) == nil)
        let n = Watches.notice(r!)
        t.eq(n.title, "intake is done"); t.eq(n.body, "All 42 tests pass.")
        t.eq(w.unread().count, 1)
        w.read(r!.id)
        t.eq(w.unread().count, 0)
    }

    t.test("asks, failures and stops, each by what was asked for") {
        let w = Watches()
        w.add("t1", label: "site", until: .asks)
        t.ok(w.onEvent(ev(0, "thread.finished", thread: "t1", ["ok": true])) == nil, "done is not what was asked")
        t.eq(w.onEvent(ev(0, "ask.raised", thread: "t1", ["summary": "run npm test"]))?.why, .asked)
        w.add("t2", label: "deploy")
        t.eq(w.onEvent(ev(0, "thread.finished", thread: "t2", ["ok": false, "error": "exit 1"]))?.text, "exit 1")
        w.add("t3", label: "long")
        t.eq(w.onEvent(ev(0, "thread.stopped", thread: "t3"))?.why, .stopped)
    }

    t.test("kept in a 0600 file across restarts") {
        let dir = URL(fileURLWithPath: vyScratch("watch-\(UUID().uuidString)"))
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("capsule/watches.json")
        let a = Watches(file: file)
        a.add("t1", label: "intake")
        let mode = (try? FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int) ?? -1
        t.eq(mode & 0o777, 0o600)
        let b = Watches(file: file)
        t.eq(b.list().map(\.thread), ["t1"])
        _ = b.onEvent(ev(0, "thread.finished", thread: "t1", ["ok": true]))
        t.eq(Watches(file: file).unread().count, 1)
    }

    t.test("the words that mean watch") {
        t.eq(Watches.watchWords("watch the intake thread"), "intake")
        t.eq(Watches.watchWords("watch harlow site and tell me when it's done"), "harlow site")
        t.eq(Watches.watchWords("tell me when the deploy thread is done"), "deploy")
        t.eq(Watches.watchWords("what time is it"), nil)
    }

    t.test("the switchboard's thread.watched fires the report, and raw events do not fire it twice") {
        let w = Watches()
        w.add("t1", label: "intake", until: .either, server: "w-1")
        t.ok(w.onEvent(ev(0, "thread.finished", thread: "t1", ["ok": true])) == nil, "the switchboard's watch decides")
        let r = w.onEvent(ev(3, "thread.watched", thread: "t1", ["thread": "t1", "watch": "w-1", "reason": "finished", "notify": "capsule", "summary": "Tests pass."]))
        t.eq(r?.label, "intake"); t.eq(r?.why, .finished); t.eq(r?.text, "Tests pass.")
        let a = w.onEvent(ev(4, "thread.watched", ["thread": "t9", "reason": "asked", "notify": "capsule", "note": "deploy", "summary": "May I push?"]))
        t.eq(a?.label, "deploy"); t.eq(a?.why, .asked)
        t.ok(w.onEvent(ev(5, "thread.watched", ["thread": "t8", "reason": "finished", "notify": "kit"])) == nil, "a watch another agent set for itself is not the user's")
    }
}

// capsule-suite: glassSuite
let glassSuite = Suite("glass") { t in
    t.test("the URL is the box's origin, /glass/, then the encoded agent") {
        t.eq(Glass.url(box: BOX, target: "harper"), "https://alex.vyre.run/glass/harper")
        t.eq(Glass.url(box: BOX + "/", target: "box"), "https://alex.vyre.run/glass/box")
        t.eq(Glass.url(box: "https://box.example.ts.net:8443", target: "harper"), "https://box.example.ts.net:8443/glass/harper")
        t.eq(Glass.url(box: BOX, target: "night owl"), "https://alex.vyre.run/glass/night%20owl")
        t.eq(Glass.url(box: BOX, target: "a/../b?x#y"), "https://alex.vyre.run/glass/a%2F..%2Fb%3Fx%23y", "a name stays one path segment")
    }

    t.test("no box address, or not an https one, is no URL") {
        for b in [nil, "", "alex.vyre.run", "http://alex.vyre.run", "file:///etc/passwd", "-a Terminal"] as [String?] {
            t.eq(Glass.url(box: b, target: "harper"), nil, String(describing: b))
        }
        t.eq(Glass.url(box: BOX, target: ""), nil)
    }

    t.test("the address comes from link.status, and only for a live pairing") {
        @Sendable func link(_ data: Any) -> FakeLink { FakeLink { tool, _ in tool == "link.status" ? .success(data) : .failure(code: "no_such_tool", message: "no tool \(tool)") } }
        let got = t.wait { () -> [String] in
            [await Glass.address(link(["linked": true, "box": ["address": BOX + "/"]])) ?? "nil",
             await Glass.address(link(["linked": false, "box": ["address": BOX]])) ?? "nil",
             await Glass.address(link(["linked": true, "box": NSNull()])) ?? "nil",
             await Glass.address(link(["linked": true, "box": ["address": "http://alex.vyre.run"]])) ?? "nil",
             await Glass.address(FakeLink { _, _ in .failure(code: "unknown_tool", message: "no") }) ?? "nil",
             await Glass.address(link(["linked": true, "box": ["address": BOX]]), has: false) ?? "nil"]
        }
        t.eq(got, [BOX, "nil", "nil", "nil", "nil", "nil"])
    }

    t.test("an agent with a computer gets Open Glass, one without does not") {
        let r = Glass.results("harper", glassCatalog())
        t.eq(r.map { "\($0.id)|\($0.label)|\($0.target)" }, ["glass:harper|Open Glass · harper|harper"])
        t.eq(Glass.results("juno", glassCatalog()).count, 0, "juno has no computer")
    }

    t.test("a thread offers Glass for its agent, by the thread's agent or the agent's current thread") {
        t.eq(Glass.results("intake deck", glassCatalog()).map(\.target), ["harper"])
        t.eq(Glass.results("quarterly", glassCatalog()).map(\.target), ["harper"], "t-cur is harper's current thread")
        t.eq(Glass.results("rebuttal", glassCatalog()).count, 0, "juno's thread, and juno has no computer")
    }

    t.test("hidden without a box address, whatever the words") {
        for b in [nil, "", "http://alex.vyre.run"] as [String?] {
            for q in ["harper", "intake deck", "glass", "glass harper", "glass box"] { t.eq(Glass.results(q, glassCatalog(b)).count, 0, "\(String(describing: b)) \(q)") }
        }
        t.eq(Glass.results("harper", nil).count, 0)
    }

    t.test("the typed command, for an agent, a prefix, the box, or all of them") {
        t.eq(Glass.results("glass harper", glassCatalog()).map(\.id), ["glass:harper"])
        t.eq(Glass.results("Glass HAR", glassCatalog()).map(\.id), ["glass:harper"])
        t.eq(Glass.results("glass juno", glassCatalog()).count, 0, "no computer, no row, even when asked by name")
        t.eq(Glass.results("glass box", glassCatalog()).map { "\($0.id)|\($0.label)" }, ["glass:box|Open your server's files in Glass"])
        t.eq(Glass.results("glass", glassCatalog()).map(\.id).sorted(), ["glass:box", "glass:harper", "glass:night owl"])
    }

    t.test("open calls the opener with exactly the Glass URL, and says why when it cannot") {
        var opened: [String] = []
        t.eq(Glass.open(box: BOX, target: "night owl", opener: { opened.append($0.absoluteString); return true }), .close(nil))
        t.eq(opened, ["https://alex.vyre.run/glass/night%20owl"])
        guard case .failed(let why) = Glass.open(box: nil, target: "harper", opener: { opened.append($0.absoluteString); return true }) else { t.ok(false); return }
        t.ok(why.contains("No server is paired"))
        t.eq(opened.count, 1, "no address, nothing opened")
        guard case .failed = Glass.open(box: BOX, target: "harper", opener: { _ in false }) else { t.ok(false, "a browser that failed is not success"); return }
    }
}
