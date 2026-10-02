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

/// Holds a fake tool until the test has seen what it streamed (at most 4 s, so a failure cannot hang).
private final class Gate: @unchecked Sendable {
    private let sem = DispatchSemaphore(value: 0)
    func open() { sem.signal() }
    func wait() { _ = sem.wait(timeout: .now() + 4) }
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

    t.test("a question about the screen, or with text selected, goes to the fast model with the screen; \"memory: ...\" goes to memory.ask") {
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
        let r: [String]? = t.wait {
            let err = await run("what is this error")
            let sel = await run("explain it simply", selected: true)
            let mem = await run("memory: which car do I drive")
            return ["\(err.iq)", VJ.s(err.start?["model"]), "\(VJ.s(err.start?["append"]).contains("Screen: Safari"))",
                    "\(sel.iq)", "\(sel.start != nil)", "\(mem.iq)", "\(mem.start == nil)"]
        }
        t.eq(r, ["0", "haiku", "true", "0", "true", "1", "true"])
    }

    t.test("an asked-for memory question does not wait for the screen chip; a screen question does") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("memory.ask") { _ in ["answer": "You drive a blue Volvo XC40.", "confidence": 0.9, "abstained": false, "known": [Any](), "sources": [Any]()] }
        v.tool("threads.start") { _ in ["id": "q10"] }
        let screen = MainActor.assumeIsolated { () -> FakeScreen in let s = FakeScreen(); s.slow = 600_000_000; return s }
        let r: [Double]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.attachers = [screen]; m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("memory.ask") }
            // ⏎ at once, while the chip is still settling (600 ms).
            await MainActor.run { m.text = "memory: which car do I drive" }
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
        t.eq(ok.abstained, false)

        let unsure = IQAnswer.from("who signed off on the homepage", ["answer": NSNull(), "abstained": true, "confidence": 0.1, "answer_id": "a_unsure",
                                                                      "known": ["alex reviewed the Harlow Legal homepage draft"], "sources": [Any]()])
        t.eq(unsure.text, "Not sure yet.\n\nWhat I do know:\n- alex reviewed the Harlow Legal homepage draft\n\nAsk Claude instead: ⌘⏎")
        t.ok(unsure.memory == nil, "no chip without an answer")
        t.eq(unsure.answerId, "a_unsure")
        t.eq(unsure.abstained, true)

        // via "corrected": the answer draws with "you corrected this" and no source chips, but the
        // chip area still shows (its "fix:<n>" source is provenance, never a chip).
        let fixed = IQAnswer.from("which car do I drive", ["answer": "You drive a green Subaru.", "confidence": 1, "abstained": false, "known": [Any](), "via": "corrected",
                                                           "answer_id": "a_fixed",
                                                           "sources": [["session": "fix:3", "name": "your correction", "quote": "green Subaru"]]])
        t.eq(fixed.text, "You drive a green Subaru.")
        t.ok(fixed.memory != nil, "a corrected answer still shows its chip area")
        t.eq(fixed.memory?.corrected, true)
        t.ok(fixed.memory?.sources.isEmpty ?? false, "a correction's source is not drawn as a chip")
        t.eq(fixed.answerId, "a_fixed")

        let limited = IQAnswer.from("x", ["limited": true, "abstained": true, "message": "Vyre IQ used today's $0.50. It resets at midnight."])
        t.eq(limited.text, "Vyre IQ used today's $0.50. It resets at midnight.")
        t.eq(limited.answerId, nil)

        // C13's stages, each a short plain word; an unknown stage shows nothing new.
        t.eq(["understand", "search", "read", "answer", "check"].map { IQAnswer.stageWord($0) ?? "nil" },
             ["Understanding", "Searching your sessions", "Reading", "Writing", "Checking"])
        t.eq(IQAnswer.stageWord("ponder"), nil)
        t.eq(IQAnswer.stageWord("understanding"), nil, "the pre-C13 names are not stages")
    }

    t.test("\"memory: ...\" goes to memory.ask, not a session; a follow-up starts one told the conversation") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("memory.ask") { _ in ["answer": "You drive a blue Volvo XC40.", "confidence": 0.9, "abstained": false, "known": [Any](),
                                     "sources": [["session": "s1", "seq": 4, "name": "Insurance renewal", "quote": "I drive a blue Volvo XC40"]], "via": "fact"] }
        v.tool("threads.start") { _ in ["id": "q2"] }
        let r: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("memory.ask") }
            await MainActor.run { m.text = "memory: which car do I drive" }
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

    t.test("streaming: memory.thinking stages show as words while memory.ask is out, then clear") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        let seenChecking = Gate()
        v.tool("memory.ask") { input in
            v.emit("memory.thinking", ["id": VJ.s(input["id"]), "stage": "understand"])
            v.emit("memory.thinking", ["id": VJ.s(input["id"]), "stage": "search"])
            v.emit("memory.thinking", ["id": VJ.s(input["id"]), "stage": "read"])
            // Another ask's stage, and a stage this Capsule does not know: neither shows. They come
            // before "check", so seeing "Checking" means they were already dispatched.
            v.emit("memory.thinking", ["id": "cap_other", "stage": "answer"])
            v.emit("memory.thinking", ["id": VJ.s(input["id"]), "stage": "ponder"])
            v.emit("memory.thinking", ["id": VJ.s(input["id"]), "stage": "check"])
            // A real answer takes seconds: held until the test has seen the last stage, not a timer.
            seenChecking.wait()
            return ["answer": "You drive a blue Volvo XC40.", "answer_id": "a1", "confidence": 0.9, "abstained": false, "known": [Any](),
                    "sources": [["session": "s1", "seq": 4, "name": "Insurance renewal", "quote": "I drive a blue Volvo XC40"]], "via": "fact"]
        }
        let r: (id: String, stage: String?, done: Bool)? = t.wait(timeout: 40) {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("memory.ask") }
            await MainActor.run { m.text = "memory: which car do I drive" }
            _ = await MainActor.run { m.handleReturn(command: false) }
            _ = await until { !v.callsOf("memory.ask").isEmpty }
            let id = VJ.s(v.callsOf("memory.ask").first?["id"])
            let stream = VJ.truthy(v.callsOf("memory.ask").first?["stream"])
            let stage = await until { m.iqStage == "Checking" }
            seenChecking.open()
            _ = await until { m.reply?.finished == true }
            let cleared = await MainActor.run { m.iqStage == nil }
            let answerId = await MainActor.run { m.iqAnswerId }
            await MainActor.run { m.didHide() }
            return (id.isEmpty || !stream ? "" : id, stage ? "Checking" : nil, cleared && answerId == "a1")
        }
        t.ok(r?.id.hasPrefix("cap_") == true, "the call's own id, cap_<n>: \(r?.id ?? "nil")")
        t.eq(r?.stage, "Checking", "the last known stage stays; another id's and an unknown stage change nothing")
        t.eq(r?.done, true, "iqStage clears once the answer is in, answer_id kept")
    }

    t.test("streaming: draft lines show dimmed, the whole text so far, then the answer replaces them") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        let seen = Gate()
        let sawFirst = Gate()
        v.draftTool("memory.ask") { input, draft in
            let id = VJ.s(input["id"])
            v.emit("memory.thinking", ["id": id, "stage": "answer"])
            draft(id, "You drive")
            sawFirst.wait()
            draft("cap_other", "someone else's draft")
            draft(id, "You drive a blue Volvo")
            v.emit("memory.thinking", ["id": id, "stage": "check"])
            // Held until the test has seen the second frame, as a real check takes seconds.
            seen.wait()
            return ["answer": "You drive a blue Volvo XC40.", "answer_id": "a4", "confidence": 0.9, "abstained": false, "known": [Any](),
                    "sources": [["session": "s1", "seq": 4, "name": "Insurance renewal", "quote": "I drive a blue Volvo XC40"]], "via": "fact"]
        }
        let r: [String]? = t.wait(timeout: 40) {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("memory.ask") }
            await MainActor.run { m.text = "memory: which car do I drive" }
            _ = await MainActor.run { m.handleReturn(command: false) }
            let first = await until { m.iqDraft == "You drive" }
            sawFirst.open()
            let second = await until { m.iqDraft == "You drive a blue Volvo" && m.iqStage == "Checking" }
            let during = await MainActor.run { [m.replyText.isEmpty ? "no reply yet" : m.replyText, "\(m.pending)"] }
            seen.open()
            _ = await until { m.reply?.finished == true }
            let after = await MainActor.run { [m.replyText, m.iqDraft ?? "no draft"] }
            await MainActor.run { m.didHide() }
            return ["\(first)", "\(second)"] + during + after
        }
        t.eq(r, ["true", "true", "no reply yet", "true", "You drive a blue Volvo XC40.", "no draft"])
    }

    t.test("streaming: a draft is clipped to 4,000 characters, and the ndjson buffer is capped at 2 MB") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        let seen = Gate()
        v.draftTool("memory.ask") { input, draft in
            draft(VJ.s(input["id"]), String(repeating: "a", count: 5000))
            seen.wait()
            return ["answer": "ok", "answer_id": "a9", "confidence": 0.9, "abstained": false, "known": [Any](), "sources": [Any]()]
        }
        let n: Int? = t.wait(timeout: 40) {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("memory.ask") }
            await MainActor.run { m.text = "memory: which car do I drive" }
            _ = await MainActor.run { m.handleReturn(command: false) }
            _ = await until { m.iqDraft != nil }
            let n = await MainActor.run { m.iqDraft?.count ?? -1 }
            seen.open()
            _ = await until { m.reply?.finished == true }
            await MainActor.run { m.didHide() }
            return n
        }
        t.eq(n, 4000)
        let s = NDJSONState()
        t.eq(s.feed(Data("{\"draft\":1}\n{\"dr".utf8)).count, 1, "whole lines only")
        t.eq(s.feed(Data(count: NDJSONState.limit + 1)).count, 0)
        t.ok(s.overflowed, "a line past 2 MB with no newline stops the reader")
        t.eq(s.feed(Data("{}\n".utf8)).count, 0, "and it stays stopped")
    }

    t.test("streaming: a draft is removed when the answer abstains") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        let seen = Gate()
        v.draftTool("memory.ask") { input, draft in
            let id = VJ.s(input["id"])
            draft(id, "Priya signed off on")
            seen.wait()
            return ["answer": NSNull(), "answer_id": "a5", "abstained": true, "confidence": 0.2, "known": [Any](), "sources": [Any]()]
        }
        let r: [String]? = t.wait(timeout: 40) {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("memory.ask") }
            await MainActor.run { m.text = "memory: who signed off on the homepage" }
            _ = await MainActor.run { m.handleReturn(command: false) }
            let drew = await until { m.iqDraft == "Priya signed off on" }
            seen.open()
            _ = await until { m.reply?.finished == true }
            let after = await MainActor.run { [m.iqDraft ?? "no draft", "\(m.replyText.hasPrefix(IQAnswer.notSure))", "\(m.replyText.contains("Priya"))"] }
            await MainActor.run { m.didHide() }
            return ["\(drew)"] + after
        }
        t.eq(r, ["true", "no draft", "true", "false"])
    }

    t.test("bad_input from an older vyred: retried once without stream or id") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        var calls = 0
        v.tool("memory.ask") { input in
            calls += 1
            if input["stream"] != nil || input["id"] != nil { return FakeError(code: "bad_input", message: "stream is not a known field") }
            return ["answer": "You drive a blue Volvo XC40.", "confidence": 0.9, "abstained": false, "known": [Any](), "sources": [Any]()]
        }
        let r: (String, Int)? = t.wait(timeout: 40) {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("memory.ask") }
            await MainActor.run { m.text = "memory: which car do I drive" }
            _ = await MainActor.run { m.handleReturn(command: false) }
            _ = await until { m.reply?.finished == true }
            let text = await MainActor.run { m.replyText }
            await MainActor.run { m.didHide() }
            return (text, v.callsOf("memory.ask").count)
        }
        t.eq(r?.0, "You drive a blue Volvo XC40.", "the retry (no stream/id) still answers")
        t.eq(r?.1, 2, "one call with stream/id, one plain retry")
    }

    t.test("⌘1..⌘3: a source chip opens that turn in Vyre chat, seq included") {
        let v = FakeVyred()
        let m = MainActor.assumeIsolated { () -> CapsuleModel in
            let m = CapsuleModel(home: vyScratch("iq-src-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
            m.catalog = VyreCatalog(box: "https://box.example.ts.net:8443")
            m.askedMemory = MemoryAnswer(text: "which car do I drive", answer: "A blue Volvo XC40.", answerKind: .memory,
                                        sources: [MemorySource(kind: .quote, role: "user", session: "s1", seq: 4, name: "Insurance renewal", quote: "I drive a Volvo", age: "")])
            m.askedMemory?.iq = true
            return m
        }
        var opened: URL?
        let ok = MainActor.assumeIsolated { m.openSource(0, opener: { opened = $0; return true }) }
        t.eq(ok, true)
        t.eq(opened?.absoluteString, "https://box.example.ts.net:8443/chat/thread/s1?seq=4")
        // No server paired: says so, opens nothing.
        MainActor.assumeIsolated { m.catalog = VyreCatalog() }
        let none = MainActor.assumeIsolated { m.openSource(0, opener: { _ in true }) }
        t.eq(none, false)
        t.eq(MainActor.assumeIsolated { m.line }, "Vyre chat is on your server, and this Mac is not paired with one.")
    }

    t.test("corrections (95b2b891): replace shows the fix at once with Undo; wrong and forget too") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("memory.ask") { _ in ["answer": "You drive a blue Volvo XC40.", "answer_id": "a2", "confidence": 0.9, "abstained": false, "known": [Any](),
                                     "sources": [["session": "s1", "seq": 4, "name": "Insurance renewal", "quote": "I drive a Volvo"]], "via": "fact"] }
        var lastCorrect: [String: Any]?
        v.tool("memory.correct") { input in
            lastCorrect = input
            let action = VJ.s(input["action"])
            var fix: [String: Any] = ["id": 7, "action": action]
            if action == "replace" { fix["text"] = VJ.s(input["object"]) }
            return ["fix": fix]
        }
        v.tool("memory.uncorrect") { _ in ["fix": ["id": 7, "undone": 1]] }
        let r: [String]? = t.wait(timeout: 40) {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("memory.ask") }
            await MainActor.run { m.text = "memory: which car do I drive" }
            _ = await MainActor.run { m.handleReturn(command: false) }
            _ = await until { m.reply?.finished == true }
            await MainActor.run { m.openIQCorrect() }
            let opened = await MainActor.run { m.iqCorrecting?.answerId == "a2" && m.iqCorrecting?.hadAnswer == true && m.iqCorrecting?.draft == "You drive a blue Volvo XC40." }
            await MainActor.run { m.correctIQ(action: "replace", object: "You drive a green Subaru.") }
            _ = await until { m.iqFixed != nil }
            let afterReplace = await MainActor.run { [m.replyText, VJ.s(lastCorrect?["answer"]), "\(m.iqFixed?.action ?? "")"] }
            await MainActor.run { m.undoIQFix() }
            // iqFixed clears at once (Undo hides eagerly); the restore itself lands after
            // memory.uncorrect answers, so wait on the text, not the flag.
            _ = await until { m.replyText == "You drive a blue Volvo XC40." }
            let afterUndo = await MainActor.run { m.replyText }
            await MainActor.run { m.didHide() }
            return ["\(opened)"] + afterReplace + [afterUndo]
        }
        t.eq(r, ["true", "You drive a green Subaru.", "a2", "replace", "You drive a blue Volvo XC40."])
    }

    t.test("a 'not sure' answer's correction panel offers only the field") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("memory.ask") { _ in ["answer": NSNull(), "abstained": true, "answer_id": "a3", "confidence": 0.1, "known": [Any](), "sources": [Any]()] }
        let r: (Bool, String)? = t.wait(timeout: 40) {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("memory.ask") }
            await MainActor.run { m.text = "memory: who signed off on the homepage" }
            _ = await MainActor.run { m.handleReturn(command: false) }
            _ = await until { m.reply?.finished == true }
            await MainActor.run { m.openIQCorrect() }
            let had = await MainActor.run { m.iqCorrecting?.hadAnswer }
            let draft = await MainActor.run { m.iqCorrecting?.draft ?? "x" }
            await MainActor.run { m.didHide() }
            return (had ?? true, draft)
        }
        t.eq(r?.0, false, "no 'That's wrong' or 'Forget this' with nothing to blame")
        t.eq(r?.1, "", "an empty field, not the 'Not sure yet.' text")
    }

    t.test("listed but not there (no_such_tool): asking memory says there is no memory to ask, and starts nothing") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.listed = ["memory.ask"]
        v.tool("threads.start") { _ in ["id": "q3"] }
        let got: (String?, Int)? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("memory.ask") }
            await MainActor.run { m.text = "memory: which car do I drive" }
            _ = await MainActor.run { m.handleReturn(command: false) }
            _ = await until { m.line != nil }
            let line = await MainActor.run { m.line }
            await MainActor.run { m.didHide() }
            return (line, v.callsOf("threads.start").count)
        }
        t.ok(got?.0?.contains("no memory to ask") == true, got?.0 ?? "no line")
        t.eq(got?.1, 0)
    }

    t.test("a plain typed question never goes to memory.ask, with or without memory on this vyred (#46)") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("memory.ask") { _ in ["answer": "From memory.", "abstained": false, "known": [Any](), "sources": [Any]()] }
        v.tool("memory.answer") { _ in ["answer": "From memory.", "kind": "fact", "sources": [Any]()] }
        v.tool("threads.start") { _ in ["id": "q4"] }
        let got: (Int, Int, Int)? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in let m = model(v); m.willShow(front: nil); return m }
            _ = await until { m.vyred.isUp && m.vyred.has("memory.ask") }
            await MainActor.run { m.text = "which car do I drive" }
            try? await Task.sleep(nanoseconds: 400_000_000)
            _ = await MainActor.run { m.handleReturn(command: false) }
            _ = await until { !v.callsOf("threads.start").isEmpty }
            await MainActor.run { m.didHide() }
            return (v.callsOf("memory.ask").count, v.callsOf("memory.answer").count, v.callsOf("threads.start").count)
        }
        t.eq(got?.0, 0, "memory.ask was not asked")
        t.eq(got?.1, 0, "memory.answer did not run as you typed")
        t.eq(got?.2, 1, "the question went to the model")
    }
}
