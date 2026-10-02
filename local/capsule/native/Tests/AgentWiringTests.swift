// capsule-suite: agentWiringSuite
// The providers put into the running Capsule: watch and drive rows on the catalog's threads,
// Glass for an agent with a computer once a box is paired, and a watched thread's report.

import Foundation

private func until(_ cond: @escaping @MainActor () -> Bool) async -> Bool {
    for _ in 0..<250 { if await MainActor.run(body: cond) { return true }; try? await Task.sleep(nanoseconds: 20_000_000) }
    return false
}

private func world(_ v: FakeVyred) {
    v.tool("projects.list") { _ in ["projects": [Any]()] }
    v.tool("projects.catalog") { _ in ["sessions": [Any]()] }
    v.tool("agents.list") { _ in [["name": "kit", "kind": "agent", "computer": true, "thread": "tk"]] }
    v.tool("threads.list") { _ in [["id": "th1", "name": "Harlow intake", "cwd": "/home/alex/Work/harlow"]] }
    v.tool("link.status") { _ in ["linked": true, "box": ["address": "https://box.example.ts.net"]] }
    // A linked Mac asks its server for the agents (BoxLink.swift): the fake server answers through link.call.
    v.tool("link.call") { i in
        switch (i["tool"] as? String) ?? "" {
        case "agents.list": return [["name": "kit", "kind": "agent", "computer": true, "thread": "tk"]] as [Any]
        case "agents.ask": return ["ok": true, "thread": "tk"] as [String: Any]
        default: return FakeError(code: "no_such_tool", message: "no tool")
        }
    }
    v.tool("threads.watch") { _ in ["watch": "w1"] }
    v.tool("threads.send") { _ in ["sent": true, "thread": "th1"] }
}

/// The app holds the wiring for its life; a test must too (AgentRows holds it weakly).
@MainActor private func wired(_ v: FakeVyred) -> (CapsuleModel, AgentWiring) {
    let home = vyScratch("wiring-\(UUID().uuidString.prefix(6))")
    let vy = VyredClient(socket: v.socket)
    let w = AgentWiring(home: home, vyred: vy)
    let m = CapsuleModel(home: home, vyred: vy, providers: [AgentRows(wiring: w)])
    w.attach(m)
    return (m, w)
}

let agentWiringSuite = Suite("agent wiring") { t in
    t.test("watch the intake thread: a row, threads.watch, and its report when it finishes") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        world(v)
        let got: (row: String?, watch: [String: Any]?, report: String?)? = t.wait {
            let (m, w) = await MainActor.run { () -> (CapsuleModel, AgentWiring) in let x = wired(v); x.0.willShow(front: nil); return x }
            _ = await until { !m.catalog.threads.isEmpty && m.vyred.follower.isStreaming }
            await MainActor.run { m.text = "watch the harlow intake thread" }
            if !(await until { m.flat.contains { $0.kind == "watch" } }) {
                let f = await MainActor.run { m.flat.map { "\($0.kind):\($0.title)" } + ["threads=\(m.catalog.threads.map(\.label))"] }
                FileHandle.standardError.write("wiring: no watch row: \(f)\n".data(using: .utf8)!)
                return (nil, nil, nil)
            }
            let row = await MainActor.run { () -> String? in
                let i = m.flat.firstIndex { $0.kind == "watch" } ?? 0
                m.selected = i; m.run(); return m.flat[i].title
            }
            _ = await until { !v.callsOf("threads.watch").isEmpty }
            _ = await until { w.watches.has("th1") }
            _ = v.emit("thread.watched", thread: "th1", ["watch": "w1", "reason": "finished", "notify": "capsule", "summary": "Intake form is live."])
            _ = await until { !w.watches.reports.isEmpty }
            let rep = await MainActor.run { w.watches.reports.first.map { Watches.notice($0).title + " / " + Watches.notice($0).body } }
            await MainActor.run { m.didHide() }
            return (row, v.callsOf("threads.watch").first, rep)
        }
        t.eq(got?.row, "Watch Harlow intake")
        t.eq(VJ.s(got?.watch?["thread"]), "th1")
        t.eq(VJ.s(got?.watch?["notify"]), "capsule")
        t.eq(got?.report, "Harlow intake is done / Intake form is live.")
    }

    t.test("tell the intake thread to run the tests: sent as the user, then watched") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        world(v)
        let got: ([String: Any]?, Int)? = t.wait {
            let (m, w) = await MainActor.run { () -> (CapsuleModel, AgentWiring) in let x = wired(v); x.0.willShow(front: nil); return x }
            _ = await until { !m.catalog.threads.isEmpty }
            await MainActor.run { m.text = "tell the harlow intake thread to run the tests" }
            if !(await until { m.flat.contains { $0.kind == "drive" } }) {
                let f = await MainActor.run { m.flat.map { "\($0.kind):\($0.title)" } + ["threads=\(m.catalog.threads.map(\.label))"] }
                FileHandle.standardError.write("wiring: no drive row: \(f)\n".data(using: .utf8)!)
                return (nil, 0)
            }
            await MainActor.run { m.selected = m.flat.firstIndex { $0.kind == "drive" } ?? 0; m.run() }
            _ = await until { !v.callsOf("threads.watch").isEmpty }
            await MainActor.run { m.didHide(); withExtendedLifetime(w) {} }
            return (v.callsOf("threads.send").first, v.callsOf("threads.watch").count)
        }
        t.eq(VJ.s(got?.0?["text"]), "run the tests")
        t.eq(VJ.s(got?.0?["thread"]), "th1")
        t.eq(got?.1, 1)
    }

    t.test("Glass: a row for an agent with a computer once the box is paired, and ⌘K lists a row's verbs") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        world(v)
        let got: (String?, String?, Int)? = t.wait {
            let (m, w) = await MainActor.run { () -> (CapsuleModel, AgentWiring) in let x = wired(v); x.0.willShow(front: nil); return x }
            _ = await until { m.catalog.box != nil }
            await MainActor.run { m.text = "glass" }
            _ = await until { m.flat.contains { $0.kind == "glass" } }
            let row = await MainActor.run { m.flat.first { $0.kind == "glass" }?.title }
            let box = await MainActor.run { m.catalog.box }
            let menu = await MainActor.run { () -> Int in
                let r = ResultItem(id: "x", kind: "file", title: "notes.md", actions: [
                    ResultAction(id: "a", title: "Open") { _, _ in .said("") }, ResultAction(id: "b", title: "Show in Finder") { _, _ in .said("") }])
                m.actionMenu.open(r); m.actionMenu.move(1); m.actionMenu.move(1)
                defer { m.actionMenu.close() }
                return m.actionMenu.index
            }
            await MainActor.run { m.didHide(); withExtendedLifetime(w) {} }
            return (row, box, menu)
        }
        t.eq(got?.0, "Open Glass · kit")
        t.eq(got?.1, "https://box.example.ts.net")
        t.eq(got?.2, 0, "↓ wraps round the verbs")
    }
}
