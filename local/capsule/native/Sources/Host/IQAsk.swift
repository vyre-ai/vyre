// IQAsk: a quick question goes to Vyre IQ, memory.ask (memory-iq), not to a model session of its own.
//
// memory.ask answers from the person's own sessions with its sources, or abstains; nothing the
// Capsule composes is sent with it. What is drawn (memory-iq's spec for the Capsule):
//   answered   the answer, then a chip "confidence 0.82 · from 2 sessions" that unfolds three sources
//   abstained  "Not sure yet.", what memory does know, then "Ask Claude instead" (⌘⏎, the deeper model)
//   limited    the message exactly as it comes (the day's cap)
// A follow-up or ⌘⏎ has no IQ thread to continue: it starts a session told the conversation
// (AutoAsk.followUpSend, deeper). The old path (threads.start, lean) is kept only for a vyred with
// no memory.ask. Streaming (memory.thinking stages) is 0.1.1.

import Foundation

/// memory.ask's answer as the Capsule shows it.
public struct IQAnswer: Sendable, Equatable {
    /// The card's words.
    public var text: String
    /// The sources, for the chip under the answer (nil when there are none to show).
    public var memory: MemoryAnswer?

    public static let notSure = "Not sure yet."
    public static let askClaude = "Ask Claude instead: ⌘⏎"

    /// { answer, confidence, abstained, known[], sources[{session, seq, name, quote, ts}], via, limited?, message? }
    public static func from(_ question: String, _ data: Any?, now: Double = vyNowMs()) -> IQAnswer {
        let d = (data as? [String: Any]) ?? [:]
        if VJ.truthy(d["limited"]) {
            return IQAnswer(text: VJ.nonEmpty(d["message"]) ?? "Vyre IQ has reached today's limit.", memory: nil)
        }
        let known = ((d["known"] as? [Any]) ?? []).compactMap { VJ.nonEmpty($0) }
        let answer = VJ.nonEmpty(d["answer"])
        if VJ.truthy(d["abstained"]) || answer == nil {
            let lines = known.isEmpty ? "" : "\n\nWhat I do know:\n" + known.map { "- \($0)" }.joined(separator: "\n")
            return IQAnswer(text: notSure + lines + "\n\n" + askClaude, memory: nil)
        }
        // A correction's own source ("fix:<n>", "your correction") is provenance, never a chip.
        let sources: [MemorySource] = ((d["sources"] as? [[String: Any]]) ?? []).filter { !VJ.s($0["session"]).hasPrefix("fix:") }.map { x in
            MemorySource(kind: .quote, role: "user", session: VJ.s(x["session"]), seq: VJ.int(x["seq"]),
                         name: VJ.nonEmpty(x["name"]) ?? String(VJ.s(x["session"]).prefix(8)), quote: VJ.s(x["quote"]),
                         age: Route.age(VJ.num(x["ts"]), now: now), confidence: nil)
        }
        var m = MemoryAnswer(text: question.trimmingCharacters(in: .whitespacesAndNewlines), answer: answer, answerKind: .memory,
                             answerAge: sources.first.map(\.age).flatMap { $0.isEmpty ? nil : $0 },
                             confidence: VJ.num(d["confidence"]), sources: Array(sources.prefix(3)))
        m.iq = true
        return IQAnswer(text: answer ?? "", memory: sources.isEmpty ? nil : m)
    }

    /// The chip's words: "confidence 0.82 · from 2 sessions".
    public static func chip(_ m: MemoryAnswer) -> String {
        let n = m.conversationCount
        let from = n == 1 ? "from 1 session" : "from \(n) sessions"
        guard let c = m.confidence else { return from }
        return "confidence \(String(format: "%.2f", c)) · \(from)"
    }
}

extension CapsuleModel {
    /// A plain quick question through memory.ask. Nil: this vyred has no memory.ask, so the caller
    /// takes the old path.
    func askIQ(_ words: String) async -> ActionOutcome? {
        guard vyred.has("memory.ask") else { return nil }
        // Only words that may be about the screen (they point at it, or text may be selected) wait
        // for its chip; any other question goes to memory.ask at once.
        let w = words.trimmingCharacters(in: .whitespacesAndNewlines)
        let asking = attachers.filter { $0.mayBeAbout(w) }
        if !asking.isEmpty {
            // The chips already asked for these words, else ask now (⏎ can beat the search, and the
            // follow-up box empties the words as this runs).
            var got = attachedWords == w ? attachments : []
            if got.isEmpty {
                for a in asking {
                    if let x = await a.attachment(for: w, to: .ask), !removedAttachments.contains(x.id) { got.append(x) }
                }
            }
            // Words about the screen, or a selection: memory cannot see it. The fast model with the
            // screen context answers instead (the lead, 2026-09-27: the Capsule always knows the screen).
            if got.contains(where: \.aboutIt) { attachments = got; return nil }
        }
        asked = words
        askedMemory = nil
        pending = true
        reply = nil
        replySub?.cancel(); replySub = nil
        doing = false
        var input: [String: Any] = ["question": words]
        if let c = askContext { input["context"] = c }
        let r = await vyred.call("memory.ask", input, presence: false)
        pending = false
        if r.errorCode == "no_such_tool" { return nil }
        // The words changed while it answered: this answer is not theirs.
        guard asked == words else { return .said("") }
        if let why = Bridge.explain(r) { asked = nil; return .failed(why) }
        let iq = IQAnswer.from(words, r.data)
        askedMemory = iq.memory
        var rep = VyState.reply("")
        rep.model = models.quick
        reply = rep
        // Finished in a second step, so the answer is kept for follow-ups and read aloud like any other.
        rep.order = ["iq"]; rep.text = ["iq": iq.text]; rep.finished = true; rep.ok = true
        reply = rep
        return .said("")
    }
}
