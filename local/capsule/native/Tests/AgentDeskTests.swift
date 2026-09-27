// capsule-suite: agentDeskSuite
// The waiting list against FakeVyred: holds, asks and proposed lessons are read on open, oldest
// first; the stream keeps the list true; a mail card sends exactly what it shows; nothing leaves
// the list until vyred says it was answered; a refusal is said in words.

import Foundation

@MainActor private func deskModel(_ v: FakeVyred) -> CapsuleModel {
    CapsuleModel(home: vyScratch("desk-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
}

private func until(_ cond: @escaping @MainActor () -> Bool) async -> Bool {
    for _ in 0..<250 { if await MainActor.run(body: cond) { return true }; try? await Task.sleep(nanoseconds: 20_000_000) }
    return false
}

/// A vyred with one hold (newest), one ask (oldest) and one proposed lesson.
private func seeded() -> FakeVyred {
    let v = FakeVyred(); v.start()
    v.tool("projects.list") { _ in ["projects": [["slug": "harlow", "name": "Harlow Legal"]]] }
    v.tool("projects.catalog") { _ in ["sessions": [Any]()] }
    v.tool("projects.threads") { _ in [Any]() }
    v.tool("agents.list") { _ in [["name": "juno", "kind": "assistant", "thread": "tj"]] }
    v.tool("gate.held") { _ in [["id": "h1", "kind": "send", "via": "gmail", "to": ["dana@harlowlegal.com"], "summary": "Intake follow-up",
                                  "agent": "juno", "thread": "tj", "project": "harlow", "at": 3000]] }
    v.tool("threads.asks") { _ in [["id": "a1", "thread": "tj", "tool": "Bash", "summary": "run npm test", "at": 1000, "state": "open"],
                                   ["id": "a0", "thread": "tj", "tool": "Bash", "summary": "old", "at": 500, "state": "answered", "decision": "allow"]] }
    v.tool("learn.lessons") { _ in [["id": 7, "rule": "Sign emails as Alex", "scope": "all", "source": ["kind": "edited"], "created": 2000, "status": "proposed"]] }
    v.tool("gate.get") { _ in ["id": "h1", "to": ["dana@harlowlegal.com"], "summary": "Intake follow-up", "via": "gmail",
                               "draft": ["subject": "Your intake", "body": "Hi Dana,\nthe form is live."]] }
    return v
}

let agentDeskSuite = Suite("agent desk") { t in
    t.test("the list is read on open: oldest first, answered asks left out, names filled in, lessons quiet") {
        let v = seeded(); defer { v.stop() }
        let got: ([String], Int)? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = deskModel(v); m.willShow(front: nil); return m }
            _ = await until { m.desk.waiting.count == 3 }
            let rows = await MainActor.run { m.desk.waiting.map(\.title) }
            let loud = await MainActor.run { m.desk.loud }
            await MainActor.run { m.didHide() }
            return (rows, loud)
        }
        t.eq(got?.0, ["juno asks to run npm test", "Vyre proposes: \"Sign emails as Alex\"", "juno drafted a message to dana@harlowlegal.com"])
        t.eq(got?.1, 2, "the proposed lesson does not count toward the dot")
    }

    t.test("the stream adds and removes rows; ↑ opens the list; a card for a hold reads gate.get") {
        let v = seeded(); defer { v.stop() }
        let got: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = deskModel(v); m.willShow(front: nil); return m }
            _ = await until { m.desk.waiting.count == 3 && m.vyred.follower.isStreaming }
            _ = v.emit("ask.raised", thread: "tj", ["ask": "a2", "tool": "Write", "summary": "write notes.md"])
            _ = await until { m.desk.waiting.count == 4 }
            _ = v.emit("ask.answered", thread: "tj", ["ask": "a1", "decision": "allow"])
            _ = await until { m.desk.waiting.count == 3 }
            let titles = await MainActor.run { m.desk.waiting.map(\.title).joined(separator: " | ") }
            await MainActor.run { m.desk.openList(); if let h = m.desk.waiting.first(where: { $0.source == .gate }) { m.desk.openCard(h) } }
            _ = await until { m.desk.held != nil }
            let d = await MainActor.run { [m.desk.draft.to, m.desk.draft.subject, m.desk.draft.body].joined(separator: " / ") }
            let pinned = await MainActor.run { m.pinned }
            await MainActor.run { m.didHide() }
            return [titles, d, pinned ? "pinned" : "not pinned"]
        }
        // The fake stamps its first event at 1000: the new ask is the oldest.
        t.eq(got?[0], "juno asks to write notes.md | Vyre proposes: \"Sign emails as Alex\" | juno drafted a message to dana@harlowlegal.com")
        t.eq(got?[1], "dana@harlowlegal.com / Your intake / Hi Dana,\nthe form is live.")
        t.eq(got?[2], "pinned", "an open card keeps the Capsule up")
    }

    t.test("Send sends every field on the card, edited; the row stays until vyred says it went") {
        let v = seeded(); defer { v.stop() }
        v.tool("gate.approve") { _ in ["state": "approved"] }
        let got: (input: [String: Any]?, still: Bool, gone: Bool)? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = deskModel(v); m.willShow(front: nil); return m }
            _ = await until { m.desk.waiting.count == 3 && m.vyred.follower.isStreaming }
            let h = await MainActor.run { m.desk.waiting.first { $0.source == .gate }! }
            await MainActor.run { m.desk.openCard(h) }
            _ = await until { m.desk.held != nil }
            await MainActor.run { m.desk.draft.subject = "Your intake form"; m.desk.draft.to = "dana@harlowlegal.com, sam@northwindbakery.com" }
            await m.desk.yes(h)
            let still = await MainActor.run { m.desk.waiting.contains { $0.key == h.key } }
            _ = v.emit("gate.released", thread: "tj", ["id": "h1"])
            let gone = await until { !m.desk.waiting.contains { $0.key == h.key } && m.desk.mode != .card(h.key) }
            await MainActor.run { m.didHide() }
            return (v.callsOf("gate.approve").first, still, gone)
        }
        let edited = got?.input?["edited"] as? [String: Any]
        t.eq(VJ.s(got?.input?["id"]), "h1")
        t.eq(edited?["to"] as? [String], ["dana@harlowlegal.com", "sam@northwindbakery.com"])
        t.eq(VJ.s(edited?["subject"]), "Your intake form")
        t.eq(VJ.s(edited?["body"]), "Hi Dana,\nthe form is live.")
        t.ok(got?.still == true, "not removed on optimism (gate.held still lists it)")
        t.ok(got?.gone == true, "gone, and the card closed, once gate.released arrived")
    }

    t.test("an ask is answered with threads.answer; a lesson refused for want of presence says where to do it") {
        let v = seeded(); defer { v.stop() }
        v.tool("threads.answer") { _ in ["answered": true] }
        v.tool("learn.accept") { _ in FakeError(code: "presence", message: "needs a signed click") }
        let got: (ask: [String: Any]?, note: String?, stays: Bool)? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = deskModel(v); m.willShow(front: nil); return m }
            _ = await until { m.desk.waiting.count == 3 }
            let a = await MainActor.run { m.desk.waiting.first { $0.source == .ask }! }
            await m.desk.no(a)
            let l = await MainActor.run { m.desk.waiting.first { $0.source == .lesson }! }
            await MainActor.run { m.desk.openCard(l) }
            await m.desk.yes(l)
            let note = await MainActor.run { m.desk.note }
            let stays = await MainActor.run { m.desk.waiting.contains { $0.key == l.key } }
            await MainActor.run { m.didHide() }
            return (v.callsOf("threads.answer").first, note, stays)
        }
        t.eq(VJ.s(got?.ask?["ask"]), "a1")
        t.eq(VJ.s(got?.ask?["decision"]), "deny")
        t.eq(VJ.s(got?.ask?["surface"]), "capsule")
        t.eq(got?.note, "Vyre needs proof that a person accepted this, which the Capsule cannot give yet. Do it in the Deck, or with vyre learn accept 7. It is still waiting.")
        t.ok(got?.stays == true)
    }
}
