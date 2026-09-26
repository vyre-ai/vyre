// capsule-suite: agentDirectSuite
// @agent as a conversation: its history in order, its open asks, words sent show at once and are
// reconciled when they arrive, the reply streams in, and a notice stays out of the messages.

import Foundation

@MainActor private func directModel(_ v: FakeVyred) -> CapsuleModel {
    CapsuleModel(home: vyScratch("direct-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
}

private func until(_ cond: @escaping @MainActor () -> Bool) async -> Bool {
    for _ in 0..<250 { if await MainActor.run(body: cond) { return true }; try? await Task.sleep(nanoseconds: 20_000_000) }
    return false
}

@MainActor private func said(_ m: CapsuleModel) -> [String] {
    (m.direct.dm?.messages ?? []).map { "\($0.role.rawValue)\($0.pending ? " (pending)" : ""): \($0.text)" }
}

let agentDirectSuite = Suite("agent direct") { t in
    t.test("history, asks, a send shown at once and reconciled, the reply streamed, a notice kept apart") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("projects.list") { _ in ["projects": [Any]()] }
        v.tool("projects.catalog") { _ in ["sessions": [Any]()] }
        v.tool("agents.list") { _ in [["name": "juno", "kind": "assistant", "thread": "tj"]] }
        v.tool("threads.get") { _ in ["thread": ["id": "tj", "status": "idle", "holder": NSNull()],
                                      "asks": [["id": "a1", "thread": "tj", "tool": "Bash", "summary": "run the tests", "at": 5, "state": "open"]],
                                      "events": [["id": 1, "type": "thread.sent", "payload": ["text": "morning", "surface": "deck"]],
                                                 ["id": 2, "type": "thread.text", "payload": ["message": "m1", "text": "Morning. Two things wait.", "done": true]],
                                                 ["id": 3, "type": "thread.finished", "payload": ["ok": true]]]] }
        v.tool("agents.ask") { _ in ["ok": true, "thread": "tj"] }
        let got: (history: [String], asks: [String], pending: [String], after: [String], notice: String?, sent: [String: Any]?)? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = directModel(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.catalog.assistant != nil && m.vyred.follower.isStreaming }
            await MainActor.run { m.target = VyreCandidate(kind: .agent, id: "juno", label: "juno") }
            let loaded = await until { m.direct.dm?.loading == false }
            if !loaded { let st = await MainActor.run { "dm=\(String(describing: m.direct.dm)) error=\(m.direct.error ?? "-") line=\(m.line ?? "-")" }; FileHandle.standardError.write(("direct: not loaded: " + st + "\n").data(using: .utf8)!) }
            let history = await MainActor.run { said(m) }
            let asks = await MainActor.run { m.direct.dm?.asks.map(\.title) ?? [] }
            await MainActor.run { m.text = "what is first?" }
            if !(await until { m.flat.first?.kind == "ask" }) { let f = await MainActor.run { m.flat.map(\.title) }; FileHandle.standardError.write("direct: rows \(f)\n".data(using: .utf8)!) }
            await MainActor.run { m.selected = 0; m.run() }
            _ = await until { !v.callsOf("agents.ask").isEmpty }
            let pending = await MainActor.run { said(m) }
            _ = v.emit("thread.sent", thread: "tj", ["text": "what is first?", "surface": "capsule"])
            _ = v.emit("thread.text", thread: "tj", ["message": "m2", "delta": "The Harlow "])
            _ = v.emit("thread.text", thread: "tj", ["message": "vyre", "text": "Claude's five-hour usage limit is at 85%.", "done": true, "notice": true])
            _ = v.emit("thread.text", thread: "tj", ["message": "m2", "text": "The Harlow draft.", "done": true])
            _ = v.emit("thread.finished", thread: "tj", ["ok": true])
            _ = await until { m.direct.dm?.busy == false && (m.direct.dm?.messages.count ?? 0) == 4 }
            let after = await MainActor.run { said(m) }
            let notice = await MainActor.run { m.direct.dm?.notice }
            await MainActor.run { m.didHide() }
            return (history, asks, pending, after, notice, v.callsOf("agents.ask").first)
        }
        t.eq(got?.history, ["user: morning", "agent: Morning. Two things wait."])
        t.eq(got?.asks, ["juno asks to run the tests"])
        t.eq(got?.pending, ["user: morning", "agent: Morning. Two things wait.", "user (pending): what is first?"])
        t.eq(got?.after, ["user: morning", "agent: Morning. Two things wait.", "user: what is first?", "agent: The Harlow draft."])
        t.eq(got?.notice, "Claude's five-hour usage limit is at 85%.")
        t.eq(VJ.s(got?.sent?["agent"]), "juno")
        t.eq(VJ.bool(got?.sent?["wait"]), false)
    }
}
