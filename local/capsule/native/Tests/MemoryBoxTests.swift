// capsule-suite: memoryBoxSuite
// The memory box: memory.answer's result as shown, the lines a quick question is sent with, and
// notices and queued sends on a reply. The Capsule ranks nothing itself: no local path may turn a
// transcript line into a fact about the user (the "Jordan" bug, 2026-09-27).

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
    t.test("a fact from memory.answer comes first with its age, and says From memory") {
        let now = 1_800_000_000_000.0
        let m = Memo.fromAnswer(text: "what is Dana's email ", [
            "answer": "Dana's email is dana@harlowlegal.example", "confidence": 0.8, "kind": "fact", "from": 2, "via": "fact",
            "sources": [["session": "f1", "seq": 2, "name": "Harlow intake", "quote": "Dana's email is dana@harlowlegal.example", "ts": now - 21 * 86_400_000]],
        ], now: now)
        t.eq(m.text, "what is Dana's email")
        t.eq(m.answer, "Dana's email is dana@harlowlegal.example")
        t.eq(m.answerKind, .memory)
        t.eq(m.answerAge, "3 weeks")
        t.eq(m.label, "From memory")
        t.eq(m.conversationCount, 2)
        t.eq(Memo.lines(m).count, 1)
        t.ok(Memo.append(m).hasPrefix("What the user's own notes say:\n- Dana's email is dana@harlowlegal.example"), Memo.append(m))
    }

    t.test("the user's own words: said, labelled From your sessions, and only the quote is sent") {
        let now = 1_800_000_000_000.0
        let m = Memo.fromAnswer(text: "which car do I own", [
            "answer": "You own a blue Volvo XC40.", "confidence": 0.7, "kind": "said", "from": 1, "via": "keyword",
            "sources": [["session": "a1", "seq": 4, "name": "Insurance renewal", "quote": "I own a blue Volvo XC40, bought in 2022.", "ts": now - 14 * 86_400_000]],
        ], now: now)
        t.eq(m.answerKind, .said)
        t.eq(m.label, "From your sessions")
        t.eq(Memo.items(m).map(\.kind), [.fact, .quote])
        t.eq(Memo.lines(m).count, 1, "the said line is shown, never sent; the quote is")
        t.ok(Memo.lines(m).first?.contains("I own a blue Volvo XC40") == true)
    }

    t.test("memory does not know: no answer, no box, and nothing extra sent") {
        let m = Memo.fromAnswer(text: "what is my wife's name", ["answer": NSNull(), "confidence": NSNull(), "kind": NSNull(), "from": 0, "sources": [Any]()])
        t.eq(m.answer, nil)
        t.ok(m.isEmpty)
        t.eq(Memo.append(m), "")
        t.eq(Memo.append(nil), "")
    }

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
            let shown = await MainActor.run { [m.memory?.answer ?? "none", m.askedMemory?.answer ?? "none", "\(m.showsMemory)"] }
            let append = VJ.s(v.callsOf("threads.start").first?["append"])
            await MainActor.run { m.didHide() }
            return shown + [append.contains("Jordan") ? "sent Jordan" : "sent nothing personal",
                            "\(v.callsOf("recall.search").count) \(v.callsOf("memory.relevant").count)"]
        }
        t.eq(r, ["none", "none", "false", "sent nothing personal", "0 0"])
    }

    t.test("memory.answer is the one source: its answer shows and goes with the question") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("memory.answer") { _ in ["answer": "You drive a blue Volvo XC40.", "confidence": 0.9, "kind": "fact", "from": 1, "via": "fact",
                                        "sources": [["session": "a1", "seq": 4, "name": "Insurance renewal", "quote": "I own a blue Volvo XC40.", "ts": NSNull()]]] }
        v.tool("threads.start") { _ in ["id": "q1"] }
        let r: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = boxModel(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("memory.answer") }
            await MainActor.run { m.text = "which car do I own" }
            _ = await until { m.memory != nil }
            let shown = await MainActor.run { m.memory?.answer ?? "none" }
            _ = await until { !v.callsOf("threads.start").isEmpty }
            let input = v.callsOf("threads.start").first
            await MainActor.run { m.didHide() }
            return [shown, VJ.s(input?["prompt"]), VJ.s(input?["append"]).contains("You drive a blue Volvo XC40.") ? "told" : "not told"]
        }
        t.eq(r, ["You drive a blue Volvo XC40.", "which car do I own", "told"])
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
