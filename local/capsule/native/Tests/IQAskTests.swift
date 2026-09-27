// capsule-suite: iqAskSuite
// Vyre IQ in the Capsule (IQAsk.swift): a quick question is memory.ask's, answered with its
// sources, "Not sure yet." with what memory knows, or the day's limit in memory's own words.
// A follow-up starts a session told the conversation. The old path only without memory.ask.

import Foundation

@MainActor private func model(_ v: FakeVyred) -> CapsuleModel {
    let home = vyScratch("iq-\(UUID().uuidString.prefix(6))")
    let m = CapsuleModel(home: home, vyred: VyredClient(socket: v.socket), providers: [])
    m.autoDelay = 3600
    return m
}

private func until(_ cond: @escaping @MainActor () -> Bool) async -> Bool {
    for _ in 0..<250 { if await MainActor.run(body: cond) { return true }; try? await Task.sleep(nanoseconds: 20_000_000) }
    return false
}

let iqAskSuite = Suite("iq ask") { t in
    t.test("memory.ask's three answers, as drawn") {
        let now = vyNowMs()
        let ok = IQAnswer.from("which car do I own", ["answer": "You drive a blue Volvo XC40.", "confidence": 0.82, "abstained": false, "known": [Any](),
                                                      "sources": [["session": "s1", "seq": 4, "name": "Insurance renewal", "quote": "I drive a blue Volvo XC40", "ts": now - 2 * 86_400_000],
                                                                  ["session": "s2", "seq": 9, "name": "Northwind Bakery order", "quote": "the Volvo", "ts": now - 3_600_000]],
                                                      "via": "fact"], now: now)
        t.eq(ok.text, "You drive a blue Volvo XC40.")
        t.eq(ok.memory.map(IQAnswer.chip), "confidence 0.82 · from 2 sessions")
        t.eq(ok.memory?.sources.map(\.name), ["Insurance renewal", "Northwind Bakery order"])
        t.eq(ok.memory?.iq, true)

        let unsure = IQAnswer.from("who signed off on the homepage", ["answer": NSNull(), "abstained": true, "confidence": 0.1,
                                                                      "known": ["alex reviewed the Harlow Legal homepage draft"], "sources": [Any]()])
        t.eq(unsure.text, "Not sure yet.\n\nWhat I do know:\n- alex reviewed the Harlow Legal homepage draft\n\nAsk Claude instead: ⌘⏎")
        t.ok(unsure.memory == nil, "no chip without an answer")

        let limited = IQAnswer.from("x", ["limited": true, "abstained": true, "message": "Vyre IQ used today's $0.50. It resets at midnight."])
        t.eq(limited.text, "Vyre IQ used today's $0.50. It resets at midnight.")
    }

    t.test("a quick question goes to memory.ask, not a session; a follow-up starts one told the conversation") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("memory.ask") { _ in ["answer": "You drive a blue Volvo XC40.", "confidence": 0.9, "abstained": false, "known": [Any](),
                                     "sources": [["session": "s1", "seq": 4, "name": "Insurance renewal", "quote": "I drive a blue Volvo XC40"]], "via": "fact"] }
        v.tool("threads.start") { _ in ["id": "q2"] }
        let r: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("memory.ask") }
            await MainActor.run { m.text = "which car do I drive" }
            _ = await MainActor.run { m.handleReturn(command: false) }
            _ = await until { m.reply?.finished == true }
            let shown = await MainActor.run { [m.replyText, m.askedMemory.map(IQAnswer.chip) ?? "none", "\(m.followUp)"] }
            let startsBefore = v.callsOf("threads.start").count
            await MainActor.run { m.text = "when is the insurance due" }
            _ = await MainActor.run { m.handleReturn(command: false) }
            _ = await until { !v.callsOf("threads.start").isEmpty }
            let start = v.callsOf("threads.start").first
            await MainActor.run { m.didHide() }
            return shown + ["\(startsBefore)", VJ.s(v.callsOf("memory.ask").first?["question"]), VJ.s(start?["prompt"]),
                            "\(VJ.s(start?["append"]).contains("Q: which car do I drive\nA: You drive a blue Volvo XC40."))"]
        }
        t.eq(r, ["You drive a blue Volvo XC40.", "confidence 0.90 · from 1 session", "true", "0", "which car do I drive", "when is the insurance due", "true"])
    }

    t.test("listed but not there (no_such_tool): the old path answers") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.listed = ["memory.ask"]
        v.tool("threads.start") { _ in ["id": "q3"] }
        let started: Bool? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("memory.ask") }
            await MainActor.run { m.text = "which car do I drive" }
            _ = await MainActor.run { m.handleReturn(command: false) }
            let ok = await until { !v.callsOf("threads.start").isEmpty }
            await MainActor.run { m.didHide() }
            return ok
        }
        t.eq(started, true)
    }
}
