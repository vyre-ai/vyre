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

/// Stands in for sight's screen chip: about the screen when the words point at it (ScreenAttach's
/// own check) or when text is "selected".
@MainActor private final class FakeScreen: SendAttaching {
    var selected = false
    /// How long the chip takes to settle (sight's debounce and read).
    var slow: UInt64 = 0
    func mayBeAbout(_ words: String) -> Bool { selected || ScreenAttach.refersToScreen(words) }
    func attachment(for words: String, to: SendTargetKind) async -> SendAttachment? {
        if slow > 0 { try? await Task.sleep(nanoseconds: slow) }
        return SendAttachment(id: "sight:screen", chip: "sees: Safari · Northwind Bakery", body: "Screen: Safari, Northwind Bakery orders",
                       aboutIt: selected || ScreenAttach.refersToScreen(words))
    }
}

let iqAskSuite = Suite("iq ask") { t in
    t.test("words that point at the screen, and ones that do not") {
        for w in ["what is this error", "what am I looking at", "explain the selected text", "summarize what's on screen", "what does this mean",
                  "translate the selection"] {
            t.ok(ScreenAttach.refersToScreen(w), "points at the screen: \(w)")
        }
        for w in ["which car do I drive", "what is my wife's name", "when is the Harlow Legal renewal", "who did I meet this week"] {
            t.ok(!ScreenAttach.refersToScreen(w), "about memory: \(w)")
        }
    }

    t.test("a question about the screen, or with text selected, goes to the fast model with the screen; others to memory.ask") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("memory.ask") { _ in ["answer": "You drive a blue Volvo XC40.", "confidence": 0.9, "abstained": false, "known": [Any](), "sources": [Any]()] }
        v.tool("threads.start") { _ in ["id": "q9"] }
        let screen = MainActor.assumeIsolated { FakeScreen() }
        func run(_ words: String, selected: Bool = false) async -> (iq: Int, start: [String: Any]?) {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.attachers = [screen]; m.willShow(front: nil); return m }
            await MainActor.run { screen.selected = selected }
            _ = await until { m.vyred.isUp && m.vyred.has("memory.ask") }
            let before = (v.callsOf("memory.ask").count, v.callsOf("threads.start").count)
            await MainActor.run { m.text = words }
            _ = await until { !m.attachments.isEmpty }
            _ = await MainActor.run { m.handleReturn(command: false) }
            _ = await until { v.callsOf("memory.ask").count > before.0 || v.callsOf("threads.start").count > before.1 }
            try? await Task.sleep(nanoseconds: 100_000_000)
            await MainActor.run { m.didHide() }
            let starts = v.callsOf("threads.start")
            return (v.callsOf("memory.ask").count - before.0, starts.count > before.1 ? starts.last : nil)
        }
        let r: [String]? = t.wait(timeout: 40) {
            let err = await run("what is this error")
            let sel = await run("explain it simply", selected: true)
            let mem = await run("which car do I drive")
            return ["\(err.iq)", VJ.s(err.start?["model"]), "\(VJ.s(err.start?["append"]).contains("Screen: Safari"))",
                    "\(sel.iq)", "\(sel.start != nil)", "\(mem.iq)", "\(mem.start == nil)"]
        }
        t.eq(r, ["0", "haiku", "true", "0", "true", "1", "true"])
    }

    t.test("a memory question does not wait for the screen chip; a screen question does") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("memory.ask") { _ in ["answer": "You drive a blue Volvo XC40.", "confidence": 0.9, "abstained": false, "known": [Any](), "sources": [Any]()] }
        v.tool("threads.start") { _ in ["id": "q10"] }
        let screen = MainActor.assumeIsolated { () -> FakeScreen in let s = FakeScreen(); s.slow = 600_000_000; return s }
        let r: [Double]? = t.wait(timeout: 40) {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.attachers = [screen]; m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("memory.ask") }
            // ⏎ at once, while the chip is still settling (600 ms).
            await MainActor.run { m.text = "which car do I drive" }
            let t0 = vyNowMs()
            _ = await MainActor.run { m.handleReturn(command: false) }
            _ = await until { !v.callsOf("memory.ask").isEmpty }
            let iq = vyNowMs() - t0
            await MainActor.run { m.dropAuto(); m.followUp = false; m.text = "what is this error" }
            let t1 = vyNowMs()
            _ = await MainActor.run { m.handleReturn(command: false) }
            _ = await until { !v.callsOf("threads.start").isEmpty }
            let screenQ = vyNowMs() - t1
            await MainActor.run { m.didHide() }
            return [iq, screenQ, Double(v.callsOf("memory.ask").count)]
        }
        t.ok((r?[0] ?? 9999) < 300, "memory.ask at once, not after the chip: \(r?[0] ?? -1) ms")
        t.ok((r?[1] ?? 0) >= 500, "the screen question waited for its chip: \(r?[1] ?? -1) ms")
        t.eq(r?[2], 1, "the screen question did not go to memory.ask")
    }

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

        let fixed = IQAnswer.from("which car do I drive", ["answer": "You drive a green Subaru.", "confidence": 1, "abstained": false, "known": [Any](), "via": "corrected",
                                                           "sources": [["session": "fix:3", "name": "your correction", "quote": "green Subaru"]]])
        t.eq(fixed.text, "You drive a green Subaru.")
        t.ok(fixed.memory == nil, "a correction's source is not drawn as a chip")

        let limited = IQAnswer.from("x", ["limited": true, "abstained": true, "message": "Vyre IQ used today's $0.50. It resets at midnight."])
        t.eq(limited.text, "Vyre IQ used today's $0.50. It resets at midnight.")
    }

    t.test("a quick question goes to memory.ask, not a session; a follow-up starts one told the conversation") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("memory.ask") { _ in ["answer": "You drive a blue Volvo XC40.", "confidence": 0.9, "abstained": false, "known": [Any](),
                                     "sources": [["session": "s1", "seq": 4, "name": "Insurance renewal", "quote": "I drive a blue Volvo XC40"]], "via": "fact"] }
        v.tool("threads.start") { _ in ["id": "q2"] }
        let r: [String]? = t.wait(timeout: 40) {
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
        let started: Bool? = t.wait(timeout: 40) {
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
