// capsule-suite: memoryBoxSuite
// Memory and the box: no local path may turn a transcript line into a fact about the user (the "Jordan" bug, 2026-09-27), nothing
// from memory is sent with a typed question (#46: the assistant has its own context on the server), and notices and queued sends
// on a reply.

import Foundation

private func ev(_ type: String, _ payload: [String: Any], thread: String = "t1") -> VyredEvent {
    VyredEvent(id: 1, type: type, source: "x", thread: thread, project: nil, at: 1000, payload: payload)
}

@MainActor private func boxModel(_ v: FakeVyred) -> CapsuleModel {
    let m = CapsuleModel(home: vyScratch("memo-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
    m.autoDelay = 0.08
    return m
}

private func until(_ cond: @escaping @MainActor () -> Bool) async -> Bool {
    for _ in 0..<150 { if await MainActor.run(body: cond) { return true }; try? await Task.sleep(nanoseconds: 20_000_000) }
    return false
}

let memoryBoxSuite = Suite("memory box") { t in
    t.test("no local path produces a personal fact: transcripts and loose facts are never read as answers") {
        // A dev session's test text and a loose fact, as the old ranker would have answered from.
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("recall.search") { _ in [["session": "dev1", "role": "user", "name": "memory-iq test", "text": "My wife is Jordan."]] }
        v.tool("memory.relevant") { _ in [["text": "Your wife is Jordan", "score": 0.95, "confidence": 0.9]] }
        v.tool("threads.start") { _ in ["id": "q1"] }
        let r: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = boxModel(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("threads.start") }
            await MainActor.run { m.text = "what is my wife's name" }
            _ = await until { !v.callsOf("threads.start").isEmpty }
            try? await Task.sleep(nanoseconds: 300_000_000)
            let shown = await MainActor.run { [m.askedMemory?.answer ?? "none"] }
            let append = VJ.s(v.callsOf("threads.start").first?["append"])
            await MainActor.run { m.didHide() }
            return shown + [append.contains("Jordan") ? "sent Jordan" : "sent nothing personal",
                            "\(v.callsOf("recall.search").count) \(v.callsOf("memory.relevant").count)"]
        }
        t.eq(r, ["none", "sent nothing personal", "0 0"])
    }

    t.test("a notice is status, never the answer; a queued send is marked handed over") {
        var r = VyState.reply("t1")
        r = VyState.applyReply(r, ev("thread.text", ["message": "vyre", "text": "You are at 85% of your limit.", "done": true, "notice": true]))
        t.eq(VyState.replyText(r), "")
        t.eq(r.notice, "You are at 85% of your limit.")
        r.queued = QueuedSend(name: "juno", note: "juno is busy in your terminal.")
        r = VyState.applyReply(r, ev("thread.sent", ["text": "hi", "queued": true, "via": "harness"]))
        t.eq(r.queued?.delivered, true)
        r = VyState.applyReply(r, ev("thread.text", ["message": "m1", "text": "Done.", "done": true]))
        t.eq(VyState.replyText(r), "Done.")
    }
}
