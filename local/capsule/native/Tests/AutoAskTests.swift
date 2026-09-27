// capsule-suite: autoAskSuite
// A question answers itself (AutoAsk.swift): what counts as a question, the pause before asking,
// typing on cancelling the answer, the same words never asking twice (and coming back from the
// cache), ⏎ turning the box into the follow-up box that continues the same thread, ⌘⏎ asking the
// deeper model with the conversation, and Esc back to plain search. FakeVyred stands in for vyred.

import Foundation

@MainActor private func askModel(_ v: FakeVyred) -> CapsuleModel {
    let m = CapsuleModel(home: vyScratch("auto-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
    m.autoDelay = 0.08
    return m
}

private func until(_ cond: @escaping @MainActor () -> Bool) async -> Bool {
    for _ in 0..<250 { if await MainActor.run(body: cond) { return true }; try? await Task.sleep(nanoseconds: 20_000_000) }
    return false
}

private func quietVyred() -> FakeVyred {
    let v = FakeVyred(); v.start()
    var n = 0
    let lock = NSLock()
    v.tool("threads.start") { _ in lock.lock(); n += 1; let id = "q\(n)"; lock.unlock(); return ["id": id] }
    v.tool("threads.send") { i in ["sent": true, "thread": VJ.s(i["thread"])] }
    v.tool("threads.interrupt") { _ in ["interrupted": true] }
    v.tool("threads.stop") { _ in ["stopped": true] }
    v.tool("projects.list") { _ in ["projects": [Any]()] }
    return v
}

let autoAskSuite = Suite("auto ask") { t in
    t.test("what reads as a question: two words or more, not an exact local match") {
        t.eq(CapsuleModel.wantsAnswer("archipelago", topKind: nil, topScore: 0), false, "a single word never asks")
        t.eq(CapsuleModel.wantsAnswer("what is archipelago", topKind: nil, topScore: 0), true)
        t.eq(CapsuleModel.wantsAnswer("archipelago meaning?", topKind: nil, topScore: 0), true)
        t.eq(CapsuleModel.wantsAnswer("northwind bakery rye sourdough price", topKind: nil, topScore: 0), true, "several words, nothing here matches")
        t.eq(CapsuleModel.wantsAnswer("system settings", topKind: "setting", topScore: 0.97), false, "an exact local match opens")
        t.eq(CapsuleModel.wantsAnswer("activity monitor", topKind: "app", topScore: 0.85), false, "two words with a strong match")
    }

    t.test("the pause: typing on waits, and only the words at rest are asked, once") {
        let v = quietVyred(); defer { v.stop() }
        let r: [String]? = t.wait {
            // A pause long enough that a slow CI machine's 30 ms between keys never counts as rest.
            let m = await MainActor.run { () -> CapsuleModel in let m = askModel(v); m.autoDelay = 0.4; m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp }
            await MainActor.run { m.text = "what is arch" }
            try? await Task.sleep(nanoseconds: 30_000_000)
            await MainActor.run { m.text = "what is archipelago" }
            _ = await until { !v.callsOf("threads.start").isEmpty }
            try? await Task.sleep(nanoseconds: 200_000_000)
            // The same words again ask nothing.
            await MainActor.run { m.search() }
            try? await Task.sleep(nanoseconds: 200_000_000)
            let top = await MainActor.run { (m.answerOnTop, m.selected) }
            return v.callsOf("threads.start").map { "\(VJ.s($0["prompt"])) · \(VJ.s($0["model"])) · \(VJ.s($0["purpose"]))" } + ["\(top.0) \(top.1)"]
        }
        t.eq(r, ["what is archipelago · haiku · capsule", "true -1"])
    }

    t.test("typing on lets a streaming answer go and asks again after the next pause") {
        let v = quietVyred(); defer { v.stop() }
        let r: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = askModel(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("threads.interrupt") }
            await MainActor.run { m.text = "what is archipelago" }
            _ = await until { m.reply?.thread == "q1" }
            await MainActor.run { m.text = "what is an atoll" }
            let gone = await MainActor.run { m.reply == nil && m.asked == nil }
            _ = await until { m.reply?.thread == "q2" }
            return ["gone \(gone)"] + v.callsOf("threads.interrupt").map { VJ.s($0["thread"]) } + v.callsOf("threads.start").map { VJ.s($0["prompt"]) }
        }
        t.eq(r, ["gone true", "q1", "what is archipelago", "what is an atoll"])
    }

    t.test("⏎ keeps the answer and opens the follow-up box; ⏎ there continues the same thread; the cache answers again") {
        let v = quietVyred(); defer { v.stop() }
        let r: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = askModel(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.follower.isStreaming }
            await MainActor.run { m.text = "what is archipelago" }
            _ = await until { m.reply?.thread == "q1" }
            _ = v.emit("thread.text", thread: "q1", ["message": "m1", "text": "A group of islands.", "done": true])
            _ = v.emit("thread.finished", thread: "q1", ["ok": true])
            _ = await until { m.reply?.finished == true }
            let took = await MainActor.run { m.handleReturn(command: false) }
            let box = await MainActor.run { "\(m.followUp) [\(m.text)] \(m.replyText)" }
            await MainActor.run { m.text = "how many in Greece" }
            _ = await MainActor.run { m.handleReturn(command: false) }
            _ = await until { !v.callsOf("threads.send").isEmpty }
            let sent = v.callsOf("threads.send").map { "\(VJ.s($0["thread"])): \(VJ.s($0["text"]))" }
            // Esc: back to plain search; the same question again comes from the cache.
            await MainActor.run { m.clearAnswer(); m.text = "what is archipelago" }
            _ = await until { m.replyText == "A group of islands." }
            try? await Task.sleep(nanoseconds: 150_000_000)
            return ["took \(took)", box] + sent + ["starts \(v.callsOf("threads.start").count)"]
        }
        t.eq(r, ["took true", "true [] A group of islands.", "q1: how many in Greece", "starts 1"])
    }

    t.test("⌘⏎ asks the deeper model with the conversation so far; Esc clears back to search") {
        let v = quietVyred(); defer { v.stop() }
        let r: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = askModel(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.follower.isStreaming }
            await MainActor.run { m.text = "what is archipelago" }
            _ = await until { m.reply?.thread == "q1" }
            _ = v.emit("thread.text", thread: "q1", ["message": "m1", "text": "A group of islands.", "done": true])
            _ = v.emit("thread.finished", thread: "q1", ["ok": true])
            _ = await until { m.reply?.finished == true }
            _ = await MainActor.run { m.handleReturn(command: true) }
            _ = await until { v.callsOf("threads.start").count == 2 }
            let deep = v.callsOf("threads.start")[1]
            let state = await MainActor.run { "\(m.followUp)" }
            _ = await until { m.reply?.thread == "q2" }
            await MainActor.run { m.clearAnswer() }
            let after = await MainActor.run { "\(m.followUp) \(m.asked == nil) [\(m.text)]" }
            return [VJ.s(deep["prompt"]), VJ.s(deep["model"]), VJ.s(deep["append"]).contains("Q: what is archipelago\nA: A group of islands.") ? "told" : "not told", state, after]
        }
        t.eq(r, ["what is archipelago", "sonnet", "told", "true", "false true []"])
    }

    t.test("⌘⏎ switches the SAME thread to the deeper model with thinking on") {
        let v = quietVyred(); defer { v.stop() }
        v.tool("threads.model") { i in ["thread": VJ.s(i["thread"]), "model": VJ.s(i["model"])] }
        let lock = NSLock(); var thinks = 0
        // The quick thread went idle: thinking waits until the send wakes it.
        v.tool("threads.thinking") { i in
            lock.lock(); thinks += 1; let n = thinks; lock.unlock()
            return n == 1 ? ["thread": VJ.s(i["thread"]), "thinking": NSNull(), "note": "not running"] : ["thread": VJ.s(i["thread"]), "thinking": true]
        }
        let r: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = askModel(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.follower.isStreaming && m.vyred.has("threads.model") }
            await MainActor.run { m.text = "what is archipelago" }
            _ = await until { m.reply?.thread == "q1" }
            _ = v.emit("thread.text", thread: "q1", ["message": "m1", "text": "A group of islands.", "done": true])
            _ = v.emit("thread.finished", thread: "q1", ["ok": true])
            _ = await until { m.reply?.finished == true }
            _ = await MainActor.run { m.handleReturn(command: true) }
            if !(await until { v.callsOf("threads.thinking").count == 2 }) {
                return ["stuck: model \(v.callsOf("threads.model").count) thinking \(v.callsOf("threads.thinking").count) send \(v.callsOf("threads.send").count) start \(v.callsOf("threads.start").count)"]
            }
            let model = v.callsOf("threads.model").first
            let sent = v.callsOf("threads.send").first
            let shown = await MainActor.run { "\(m.reply?.thread ?? "") \(m.reply?.model ?? "") \(m.asked ?? "") \(m.followUp)" }
            // A follow-up typed after it, with ⌘⏎: sent as it is, same thread.
            await MainActor.run { m.text = "and in Greece?"; _ = m.handleReturn(command: true) }
            _ = await until { v.callsOf("threads.send").count == 2 }
            return [VJ.s(model?["thread"]), VJ.s(model?["model"]), VJ.s(sent?["thread"]), VJ.s(sent?["text"]), shown,
                    VJ.s(v.callsOf("threads.send")[1]["text"]), "starts \(v.callsOf("threads.start").count)",
                    v.callsOf("threads.thinking").allSatisfy { VJ.s($0["thread"]) == "q1" && ($0["on"] as? Bool) == true } ? "thinking on q1" : "thinking elsewhere"]
        }
        t.eq(r, ["q1", "sonnet", "q1", "Think this through more carefully and answer again: what is archipelago", "q1 sonnet what is archipelago true",
                 "and in Greece?", "starts 1", "thinking on q1"])
    }

    t.test("⌘⏎ has one meaning: words that are not a question think deeper, never computer use") {
        let v = quietVyred(); defer { v.stop() }
        v.tool("hands.stop") { _ in ["stopped": true] }
        let r: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = askModel(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp }
            await MainActor.run { m.text = "open Notes and add milk"; _ = m.handleReturn(command: true) }
            _ = await until { !v.callsOf("threads.start").isEmpty }
            let s = v.callsOf("threads.start").first
            let doing = await MainActor.run { m.doing }
            return [VJ.s(s?["prompt"]), VJ.s(s?["model"]), VJ.s(s?["purpose"]), "\(doing)"]
        }
        t.eq(r, ["open Notes and add milk", CapsuleModel.deeperModel, "capsule", "false"])
    }

    t.test("voice: partial words ask nothing; the final words are asked at once, as ⏎ would") {
        let v = quietVyred(); defer { v.stop() }
        let r: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = askModel(v); m.autoDelay = 0.05; m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp }
            await MainActor.run { m.dictate("what is", final: false) }
            try? await Task.sleep(nanoseconds: 150_000_000)
            await MainActor.run { m.dictate("what is an archipelago", final: false) }
            try? await Task.sleep(nanoseconds: 200_000_000)
            let before = v.callsOf("threads.start").count
            await MainActor.run { m.dictate("what is an archipelago", final: true) }
            _ = await until { !v.callsOf("threads.start").isEmpty }
            let state = await MainActor.run { "\(m.followUp) \(m.voiceTurn)" }
            return ["\(before)"] + v.callsOf("threads.start").map { VJ.s($0["prompt"]) } + [state]
        }
        t.eq(r, ["0", "what is an archipelago", "true true"])
    }

    t.test("computer use: \"do …\" starts a full session told how to act; Esc stops the hands too") {
        t.eq(CapsuleModel.doRequest("do open Notes and add milk"), "open Notes and add milk")
        t.eq(CapsuleModel.doRequest("Do: "), nil)
        t.eq(CapsuleModel.doRequest("what do you do"), nil)
        let v = quietVyred(); defer { v.stop() }
        v.tool("hands.stop") { _ in ["stopped": true] }
        let r: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = askModel(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("hands.stop") }
            await MainActor.run { m.text = "do open Notes and add milk"; _ = m.handleReturn(command: false) }
            _ = await until { m.reply?.thread == "q1" }
            await MainActor.run { m.stopReply() }
            _ = await until { !v.callsOf("hands.stop").isEmpty }
            let s = v.callsOf("threads.start").first
            return [VJ.s(s?["prompt"]), VJ.s(s?["purpose"]), s?["lean"] == nil ? "full" : "lean",
                    VJ.s(s?["append"]).contains("hands.*") ? "told" : "not told", "\(v.callsOf("hands.stop").count)"]
        }
        t.eq(r, ["open Notes and add milk", "agent", "full", "told", "1"])
    }
}
