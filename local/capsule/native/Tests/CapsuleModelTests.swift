// capsule-suite: capsuleModelSuite
// CapsuleModel against FakeVyred: the memory box goes with a quick question and nothing else does,
// and a message to a session busy in a terminal is queued, said so, and marked handed over.

import Foundation

@MainActor private func model(_ v: FakeVyred) -> CapsuleModel {
    let home = vyScratch("model-\(UUID().uuidString.prefix(6))")
    return CapsuleModel(home: home, vyred: VyredClient(socket: v.socket), providers: [])
}

/// Poll a main-actor condition for up to 5 s.
private func until(_ cond: @escaping @MainActor () -> Bool) async -> Bool {
    for _ in 0..<250 { if await MainActor.run(body: cond) { return true }; try? await Task.sleep(nanoseconds: 20_000_000) }
    return false
}

let capsuleModelSuite = Suite("capsule model") { t in
    t.test("memory on screen goes with the quick question; the prompt stays the user's words") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        let now = Date().timeIntervalSince1970 * 1000
        v.tool("memory.relevant") { _ in [Any]() }
        v.tool("recall.search") { _ in [["session": "a1", "role": "user", "name": "Insurance renewal",
                                          "text": "I own a blue Volvo XC40, bought in 2022.", "ts": now - 14 * 86_400_000]] }
        v.tool("threads.start") { _ in ["id": "q1"] }
        let r: (String?, String?, String?)? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp }
            await MainActor.run { m.text = "which car do I own" }
            _ = await until { m.memory != nil }
            let answer = await MainActor.run { m.memory?.answer }
            await MainActor.run { m.selected = m.flat.firstIndex { $0.kind == "ask" } ?? 0; m.run() }
            _ = await until { !v.callsOf("threads.start").isEmpty }
            let input = v.callsOf("threads.start").first
            await MainActor.run { m.didHide() }
            return (answer, VJ.str(input?["append"]), VJ.str(input?["prompt"]))
        }
        t.eq(r?.0, "You own a blue Volvo XC40, bought in 2022.")
        t.ok(r?.1?.contains("- The user said, 2 weeks ago: \"I own a blue Volvo XC40, bought in 2022.\"") == true, r?.1 ?? "no append")
        t.ok(r?.1?.hasPrefix(Memo.quickAppend) == true)
        t.eq(r?.2, "which car do I own")
    }

    t.test("@ a session busy in a terminal: queued, said so, then handed over") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("projects.list") { _ in ["projects": [Any]()] }
        v.tool("projects.catalog") { _ in ["sessions": [Any]()] }
        v.tool("threads.list") { _ in [["id": "s1", "name": "juno", "cwd": "/home/alex/Work/northwind"]] }
        v.tool("threads.send") { _ in ["sent": false, "queued": true, "open_elsewhere": true, "thread": "s1", "name": "juno",
                                       "note": "juno is busy in your terminal. I'll hand it your message when this turn ends."] }
        let r: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.willShow(front: nil); return m }
            _ = await until { !m.catalog.threads.isEmpty }
            await MainActor.run { m.text = "@ju" }
            let row = await MainActor.run { m.current?.title }
            await MainActor.run { m.run() }
            _ = await until { m.target != nil }
            await MainActor.run { m.text = "rebuild the bakery menu" }
            await MainActor.run { m.run() }
            _ = await until { m.reply?.queued != nil }
            let line = await MainActor.run { m.line }
            let sent = v.callsOf("threads.send").first
            _ = await until { m.vyred.follower.isStreaming }
            _ = v.emit("thread.sent", thread: "s1", ["text": "rebuild the bakery menu", "queued": true, "via": "harness"])
            let delivered = await until { m.reply?.queued?.delivered == true }
            await MainActor.run { m.didHide() }
            return [row ?? "", VJ.s(sent?["thread"]), VJ.s(sent?["text"]), line ?? "", delivered ? "delivered" : "not delivered"]
        }
        t.eq(r, ["juno", "s1", "rebuild the bakery menu", "juno is busy in your terminal. I'll hand it your message when this turn ends.", "delivered"])
    }
}
