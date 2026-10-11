// capsule-suite: pinnedAskSuite
// Lumen's quick question goes into the person's one pinned assistant chat (R031-94, the app's own chat), never a thread of its own: the chat is found or made and pinned once, the words go
// through stream.send, the answer is read from the chat's thread, and a follow-up goes into the same chat. A box that has no pinned chat to give keeps the old ask (IQAskTests).

import Foundation

@MainActor private func model(_ v: FakeVyred) -> CapsuleModel {
    let home = vyScratch("pinned-\(UUID().uuidString.prefix(6))")
    let m = CapsuleModel(home: home, vyred: VyredClient(socket: v.socket), providers: [])
    m.autoDelay = 3600
    return m
}

private func until(_ cond: @escaping @MainActor () -> Bool) async -> Bool {
    for _ in 0..<250 { if await MainActor.run(body: cond) { return true }; try? await Task.sleep(nanoseconds: 20_000_000) }
    return false
}

private func pinnedBox(_ v: FakeVyred, haveChat: String? = nil) {
    v.tool("work.chat.persistent") { _ in haveChat.map { ["kind": "assistant", "chat": $0, "allowed": true] } ?? ["kind": "assistant", "chat": NSNull(), "allowed": true] }
    v.tool("work.chat.create") { _ in ["chat": "chat_new1"] }
    v.tool("work.chat.pin") { _ in ["kind": "assistant", "chat": "chat_new1", "existing": false] }
    v.tool("stream.send") { _ in ["ok": true] }
    v.tool("work.chat.get") { _ in ["slots": [["thread": "t-pin", "provider": "claude"]]] }
    v.tool("threads.start") { _ in ["id": "q-old"] }
    v.tool("threads.send") { _ in ["sent": true] }
}

let pinnedAskSuite = Suite("pinned ask") { t in
    t.test("the first question makes and pins the assistant chat, says the words in it, and starts no thread of its own") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        pinnedBox(v)
        let r: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("stream.send") }
            await MainActor.run { m.text = "what is a retainer agreement?" }
            _ = await MainActor.run { m.handleReturn(command: false) }
            _ = await until { !v.callsOf("stream.send").isEmpty }
            _ = await until { m.reply?.thread == "t-pin" }
            let said = v.callsOf("stream.send").first
            let shownThread = await MainActor.run { m.reply?.thread ?? "none" }
            let out = ["\(v.callsOf("work.chat.create").count)", VJ.s(v.callsOf("work.chat.pin").first?["chat"]), VJ.s(said?["chat"]), VJ.s(said?["text"]),
                       "\(v.callsOf("threads.start").count)", shownThread]
            await MainActor.run { m.didHide() }
            return out
        }
        t.eq(r, ["1", "chat_new1", "chat_new1", "what is a retainer agreement?", "0", "t-pin"])
    }

    t.test("a pinned chat that exists is used as it is (nothing made), and a follow-up on the answer goes into the same chat") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        pinnedBox(v, haveChat: "chat_mine")
        let r: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("stream.send") }
            await MainActor.run { m.text = "what is a retainer agreement?" }
            _ = await MainActor.run { m.handleReturn(command: false) }
            _ = await until { m.reply?.thread == "t-pin" }
            await MainActor.run { m.followUp = true; m.text = "and who signs it?" }
            _ = await MainActor.run { m.handleReturn(command: false) }
            _ = await until { v.callsOf("stream.send").count >= 2 }
            let sends = v.callsOf("stream.send")
            let out = ["\(v.callsOf("work.chat.create").count)", VJ.s(sends.first?["chat"]), VJ.s(sends.last?["chat"]), VJ.s(sends.last?["text"]), "\(v.callsOf("threads.send").count)"]
            await MainActor.run { m.didHide() }
            return out
        }
        t.eq(r, ["0", "chat_mine", "chat_mine", "and who signs it?", "0"])
    }

    t.test("a box with no pinned chat to give keeps the old ask, a thread of its own") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("threads.start") { _ in ["id": "q-old"] }
        let r: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("threads.start") }
            await MainActor.run { m.text = "what is a retainer agreement?" }
            _ = await MainActor.run { m.handleReturn(command: false) }
            _ = await until { !v.callsOf("threads.start").isEmpty }
            let out = ["\(v.callsOf("threads.start").count)", VJ.s(v.callsOf("threads.start").first?["prompt"])]
            await MainActor.run { m.didHide() }
            return out
        }
        t.eq(r, ["1", "what is a retainer agreement?"])
    }
}
