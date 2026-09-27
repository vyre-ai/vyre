// capsule-suite: agentKeeperSuite
// Stop stops the thread (threads.stop takes {thread}), and hiding lets go: the lease goes back and
// quick threads stop, a busy one only after its turn ends.

import Foundation

@MainActor private func keeperModel(_ v: FakeVyred) -> CapsuleModel {
    CapsuleModel(home: vyScratch("keeper-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
}

private func until(_ cond: @escaping @MainActor () -> Bool) async -> Bool {
    for _ in 0..<250 { if await MainActor.run(body: cond) { return true }; try? await Task.sleep(nanoseconds: 20_000_000) }
    return false
}

let agentKeeperSuite = Suite("agent keeper") { t in
    t.test("Esc on a streaming quick answer calls threads.stop with {thread}") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("threads.start") { _ in ["id": "q1"] }
        v.tool("threads.stop") { _ in ["stopped": true] }
        let got: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = keeperModel(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp }
            await MainActor.run { m.text = "what is 2+2"; m.selected = m.flat.firstIndex { $0.kind == "ask" } ?? 0; m.run() }
            _ = await until { m.reply?.thread == "q1" }
            await MainActor.run { m.stopReply() }
            _ = await until { !v.callsOf("threads.stop").isEmpty }
            return v.callsOf("threads.stop").map { VJ.s($0["thread"]) }
        }
        t.eq(got, ["q1"])
    }

    t.test("Esc on an answer from a Vyre-owned session interrupts the turn and keeps the session") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("threads.start") { _ in ["id": "q2"] }
        v.tool("threads.interrupt") { _ in ["interrupted": true] }
        v.tool("threads.stop") { _ in ["stopped": true] }
        let got: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = keeperModel(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("threads.interrupt") }
            await MainActor.run { m.text = "what is 2+2"; m.selected = m.flat.firstIndex { $0.kind == "ask" } ?? 0; m.run() }
            _ = await until { m.reply?.thread == "q2" }
            await MainActor.run { m.stopReply() }
            _ = await until { !v.callsOf("threads.interrupt").isEmpty }
            return v.callsOf("threads.interrupt").map { VJ.s($0["thread"]) } + ["stops \(v.callsOf("threads.stop").count)"]
        }
        t.eq(got, ["q2", "stops 0"])
    }

    t.test("hiding releases the lease and stops idle quick threads; a busy one stops when its turn ends") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        var n = 0
        v.tool("threads.start") { _ in n += 1; return ["id": "q\(n)"] }
        v.tool("threads.stop") { _ in ["stopped": true] }
        v.tool("threads.release") { _ in ["released": true] }
        let got: (idle: [String], release: [String], busy: [String])? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = keeperModel(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp }
            _ = await until { m.vyred.follower.isStreaming }
            // q1 answers and finishes; q2 is still answering when the Capsule hides.
            await MainActor.run { m.text = "what is first?"; m.selected = m.flat.firstIndex { $0.kind == "ask" } ?? 0; m.run() }
            _ = await until { m.reply?.thread == "q1" }
            _ = v.emit("thread.finished", thread: "q1", ["ok": true])
            _ = await until { m.reply?.finished == true }
            // Under an answer the first row follows up; this one is a new question.
            await MainActor.run { m.text = "what is second?"; m.selected = m.flat.firstIndex { $0.title == "Quick answer" } ?? 0; m.run() }
            _ = await until { m.reply?.thread == "q2" }
            await MainActor.run { m.didHide() }
            _ = await until { !v.callsOf("threads.stop").isEmpty && !v.callsOf("threads.release").isEmpty }
            let idle = v.callsOf("threads.stop").map { VJ.s($0["thread"]) }
            let release = v.callsOf("threads.release").map { VJ.s($0["thread"]) }
            _ = v.emit("thread.finished", thread: "q2", ["ok": true])
            _ = await until { v.callsOf("threads.stop").count == 2 }
            return (idle, release, v.callsOf("threads.stop").map { VJ.s($0["thread"]) })
        }
        t.eq(got?.idle, ["q1"], "the finished one stops at once")
        t.eq(got?.release, ["q2"], "the keyboard of the last thread goes back")
        t.eq(got?.busy, ["q1", "q2"], "the busy one stops after its turn")
    }
}
