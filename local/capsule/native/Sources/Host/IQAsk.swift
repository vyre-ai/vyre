// IQAsk: a quick question goes to Vyre IQ, memory.ask (memory-iq), not to a model session of its own.
//
// memory.ask answers from the person's own sessions with its sources, or abstains; nothing the
// Capsule composes is sent with it. What is drawn (memory-iq's spec for the Capsule, capsule.md):
//   thinking   memory.thinking {id, stage} as each step starts: "Understanding", "Searching your
//              sessions", "Reading", "Writing", "Checking" (C13)
//   draft      {"draft":{id,text}} lines on memory.ask's ndjson response: the whole text so far, dimmed with "Checking"; the reply
//              replaces it, or removes it when it abstains or the check fails
//   answered   the answer, "confidence 0.82 · from 2 sessions", then up to three source chips
//              (⌘1..⌘3), each opening that turn in Vyre; "+N more" past three
//   abstained  "Not sure yet.", what memory does know, then "Ask Claude instead" (⌘⏎, the deeper model)
//   limited    the message exactly as it comes (the day's cap)
//   corrected  the answer, "you corrected this", no source chips (its "fix:<n>" source is provenance)
// A follow-up or ⌘⏎ has no IQ thread to continue: it starts a session told the conversation
// (AutoAsk.followUpSend, deeper). The old path (threads.start, lean) is kept only for a vyred with
// no memory.ask.
//
// Corrections (95b2b891, memory.correct/memory.uncorrect): a quiet "Wrong?" line under the answer
// opens three choices in place: "That's wrong", "Forget this", and a field prefilled with the
// answer where Enter replaces it. A "not sure" card offers only the field. Nothing is sent until
// Enter; no Touch ID. See Sources/UI/IQCardViews.swift for the views.

import AppKit
import Foundation

/// memory.ask's answer as the Capsule shows it.
public struct IQAnswer: Sendable, Equatable {
    /// The most of a draft the card keeps.
    public static let draftLimit = 4000
    /// The card's words.
    public var text: String
    /// The sources, for the chip under the answer (nil when there are none to show).
    public var memory: MemoryAnswer?
    /// memory.ask's answer_id (95b2b891): nil with no memory.ask, or on the day's limit.
    public var answerId: String?
    public var abstained: Bool

    public static let notSure = "Not sure yet."
    public static let askClaude = "Ask Claude instead: ⌘⏎"

    /// { answer, answer_id, confidence, abstained, known[], sources[{session, seq, name, quote, ts}], via, limited?, message? }
    public static func from(_ question: String, _ data: Any?, now: Double = vyNowMs()) -> IQAnswer {
        let d = (data as? [String: Any]) ?? [:]
        if VJ.truthy(d["limited"]) {
            return IQAnswer(text: VJ.nonEmpty(d["message"]) ?? "Vyre Memory has reached today's limit.", memory: nil, answerId: nil, abstained: true)
        }
        let known = ((d["known"] as? [Any]) ?? []).compactMap { VJ.nonEmpty($0) }
        let answer = VJ.nonEmpty(d["answer"])
        let answerId = VJ.nonEmpty(d["answer_id"])
        if VJ.truthy(d["abstained"]) || answer == nil {
            let lines = known.isEmpty ? "" : "\n\nWhat I do know:\n" + known.map { "- \($0)" }.joined(separator: "\n")
            return IQAnswer(text: notSure + lines + "\n\n" + askClaude, memory: nil, answerId: answerId, abstained: true)
        }
        let corrected = VJ.s(d["via"]) == "corrected"
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
        m.corrected = corrected
        // Corrected answers still show ("you corrected this"), even with no sources left.
        return IQAnswer(text: answer ?? "", memory: (sources.isEmpty && !corrected) ? nil : m, answerId: answerId, abstained: false)
    }

    /// The chip's words: "confidence 0.82 · from 2 sessions".
    public static func chip(_ m: MemoryAnswer) -> String {
        let n = m.conversationCount
        let from = n == 1 ? "from 1 session" : "from \(n) sessions"
        guard let c = m.confidence else { return from }
        return "confidence \(String(format: "%.2f", c)) · \(from)"
    }

    /// The stage line's word for memory.thinking {stage} (C13: understand|search|read|answer|check);
    /// nil for a stage this Capsule does not know, which shows nothing new.
    public static func stageWord(_ stage: String) -> String? {
        switch stage {
        case "understand": return "Understanding"
        case "search": return "Searching your sessions"
        case "read": return "Reading"
        case "answer": return "Writing"
        case "check": return "Checking"
        default: return nil
        }
    }
}

/// State for the "Wrong?" panel opened under an IQ answer (95b2b891, IQCardViews.swift).
public struct IQCorrecting: Sendable, Equatable {
    public var answerId: String
    /// false for an abstained ("not sure") answer: only the field shows, no "That's wrong"/"Forget this".
    public var hadAnswer: Bool
    /// The field's text, prefilled with the answer (empty for "not sure").
    public var draft: String
    public init(answerId: String, hadAnswer: Bool, draft: String) { self.answerId = answerId; self.hadAnswer = hadAnswer; self.draft = draft }
}

/// A correction just applied, shown with Undo until it is undone or a new question replaces it.
public struct IQFixShown: Sendable, Equatable {
    public var fixId: Int?
    public var action: String
    /// What was on screen before the fix, so Undo can put it back.
    public var previousText: String
    public var previousMemory: MemoryAnswer?
    public var previousAbstained: Bool
}

extension CapsuleModel {
    /// Only words that may be about the screen (they point at it, or text may be selected) wait for the screen chip; any other
    /// question does not wait. Returns true when the words are about the screen, with the chips settled into `attachments`, so the
    /// caller sends them with the question (the lead, 2026-09-27: Lumen always knows the screen).
    func settleScreenChips(_ words: String) async -> Bool {
        let w = words.trimmingCharacters(in: .whitespacesAndNewlines)
        let asking = attachers.filter { $0.mayBeAbout(w) }
        guard !asking.isEmpty else { return false }
        // The chips already asked for these words, else ask now (⏎ can beat the search, and the follow-up box empties the words as this runs).
        var got = attachedWords == w ? attachments : []
        if got.isEmpty {
            for a in asking {
                if let x = await a.attachment(for: w, to: .ask), !removedAttachments.contains(x.id) { got.append(x) }
            }
        }
        if got.contains(where: \.aboutIt) { attachments = got; return true }
        return false
    }

    /// A plain quick question through memory.ask. Nil: this vyred has no memory.ask, so the caller
    /// takes the old path.
    func askIQ(_ words: String) async -> ActionOutcome? {
        guard vyred.has("memory.ask") else { return nil }
        // Words about the screen, or a selection: memory cannot see it. The fast model with the screen context answers instead.
        if await settleScreenChips(words) { return nil }
        asked = words
        askedMemory = nil
        iqStage = nil; iqDraft = nil; iqAnswerId = nil; iqCorrecting = nil; iqFixed = nil; iqAbstained = false
        pending = true
        reply = nil
        replySub?.cancel(); replySub = nil
        doing = false
        iqAskSeq += 1
        let id = "cap_\(iqAskSeq)"
        // C13: memory.thinking {id, stage} names each step; the draft {id, text} (the whole
        // text so far) arrives on the call itself; memory.answered {id, abstained} ends it. Only this ask's id, and only
        // while these words are still the ones asked.
        var subs: [VyredSubscription] = []
        subs.append(vyred.on("memory.thinking") { [weak self] e in
            guard let self, VJ.s(e.payload["id"]) == id, self.pending, self.asked == words else { return }
            // An unknown stage shows nothing new.
            if let w = IQAnswer.stageWord(VJ.s(e.payload["stage"])) { self.iqStage = w }
        })
        subs.append(vyred.on("memory.answered") { [weak self] e in
            guard let self, VJ.s(e.payload["id"]) == id else { return }
            // The check failed or it abstained: the draft was never the answer.
            if VJ.truthy(e.payload["abstained"]) || VJ.truthy(e.payload["limited"]) { self.iqDraft = nil }
        })
        var input: [String: Any] = ["question": words, "stream": true, "id": id]
        if let c = askContext { input["context"] = c }
        // The draft comes on this call's own ndjson response, never the events bus: {"draft":{id,text}}
        // lines (the whole text so far; empty text means the check failed, so drop it), then the result.
        var r = await vyred.call("memory.ask", input, timeout: iqTimeout) { [weak self] did, text in
            Task { @MainActor [weak self] in
                guard let self, did == id, self.pending, self.asked == words else { return }
                self.iqDraft = VJ.nonEmpty(String(text.prefix(IQAnswer.draftLimit)))
            }
        }
        // An older vyred may not know stream/id: retry once, plain (ADR 0034, capsule-pro's brief).
        if r.errorCode == "bad_input" {
            input["stream"] = nil; input["id"] = nil
            r = await vyred.call("memory.ask", input, presence: false)
        }
        for sub in subs { sub.cancel() }
        iqStage = nil
        // The reply replaces the draft (the answer), or removes it (abstained, limited, failed).
        iqDraft = nil
        pending = false
        if r.errorCode == "no_such_tool" { return nil }
        // The words changed while it answered: this answer is not theirs.
        guard asked == words else { return .said("") }
        // Memory has not answered in time (the user's Mac sat on "starting" with nothing): say so, and point at who can still answer.
        if r.errorCode == "timeout" {
            asked = nil
            let who = catalog.assistant?.name
            return .failed(who.map { "Memory did not answer in time. Ask \($0) instead, or try again." } ?? "Memory did not answer in time. Try again in a moment.")
        }
        if let why = Bridge.explain(r) { asked = nil; return .failed(why) }
        let iq = IQAnswer.from(words, r.data)
        askedMemory = iq.memory
        iqAnswerId = iq.answerId
        iqAbstained = iq.abstained
        var rep = VyState.reply("")
        rep.model = models.quick
        reply = rep
        // Finished in a second step, so the answer is kept for follow-ups and read aloud like any other.
        rep.order = ["iq"]; rep.text = ["iq": iq.text]; rep.finished = true; rep.ok = true
        reply = rep
        return .said("")
    }

    // MARK: sources: ⌘1..⌘3 open a source in Vyre at that turn

    /// The Vyre chat URL for a source's turn (docs/using/chat.md: `/chat/thread/<session>?seq=N`),
    /// or nil with no box paired, no session, or the index is out of range.
    func iqSourceURL(_ index: Int) -> URL? {
        guard let m = askedMemory, m.sources.indices.contains(index), let box = catalog.box else { return nil }
        let s = m.sources[index]
        guard !s.session.isEmpty, var comps = URLComponents(string: box.hasPrefix("http") ? box : "https://" + box) else { return nil }
        comps.path += "/chat/thread/\(s.session)"
        if let seq = s.seq { comps.queryItems = [URLQueryItem(name: "seq", value: String(seq))] }
        return comps.url
    }

    /// ⌘1..⌘3: open a Vyre IQ source at its turn. Nil box: says so, once, as a status line.
    @discardableResult
    func openSource(_ index: Int, opener: (URL) -> Bool = { NSWorkspace.shared.open($0) }) -> Bool {
        guard let url = iqSourceURL(index) else {
            if askedMemory?.sources.indices.contains(index) == true, catalog.box == nil {
                line = "Vyre chat is on your server, and this Mac is not paired with one."
            }
            return false
        }
        return opener(url)
    }

    // MARK: corrections (95b2b891): "Wrong?" opens its three choices in place

    /// "Wrong?" under an IQ answer. Nothing is sent until a choice or Enter.
    func openIQCorrect() {
        guard let id = iqAnswerId else { return }
        iqCorrecting = IQCorrecting(answerId: id, hadAnswer: !iqAbstained, draft: iqAbstained ? "" : (askedMemory?.answer ?? replyText))
    }

    func cancelIQCorrect() { iqCorrecting = nil }

    /// memory.correct {answer, action, object?}. "wrong" and "forget" go at once; "replace" is the
    /// field's Enter (CapsuleView/IQCardViews call this, never a keystroke).
    func correctIQ(action: String, object: String? = nil) {
        guard let c = iqCorrecting else { return }
        let id = c.answerId
        let previous = IQFixShown(fixId: nil, action: action, previousText: replyText, previousMemory: askedMemory, previousAbstained: iqAbstained)
        iqCorrecting = nil
        Task { @MainActor in
            var input: [String: Any] = ["answer": id, "action": action]
            if let object { input["object"] = object }
            let r = await vyred.call("memory.correct", input, presence: false)
            guard let fix = (r.data as? [String: Any])?["fix"] as? [String: Any] else {
                if let why = Bridge.explain(r) { line = why }
                return
            }
            self.applyFix(fix, previous: previous)
        }
    }

    private func applyFix(_ fix: [String: Any], previous: IQFixShown) {
        let fixId = VJ.int(fix["id"])
        let action = VJ.s(fix["action"])
        if action == "replace" {
            let text = VJ.nonEmpty(fix["text"]) ?? previous.previousText
            var m = askedMemory ?? MemoryAnswer(text: asked ?? "")
            m.answer = text
            m.iq = true
            m.corrected = true
            m.sources = []
            askedMemory = m
            iqAbstained = false
            if var rep = reply { rep.order = ["iq"]; rep.text = ["iq": text]; rep.finished = true; rep.ok = true; reply = rep }
        } else if action == "wrong" {
            // That answer is never given again for this question; the card says so, plainly.
            var m = askedMemory ?? MemoryAnswer(text: asked ?? "")
            m.iq = true
            m.corrected = true
            askedMemory = m
        }
        // "forget" (the turns behind it never ground an answer again) leaves the card as it is;
        // asking the same question again reads differently next time.
        var shown = previous
        shown.fixId = fixId
        shown.action = action
        iqFixed = shown
    }

    /// memory.uncorrect {fix}: puts the answer back as it was before the fix.
    func undoIQFix() {
        guard let f = iqFixed, let id = f.fixId else { return }
        iqFixed = nil
        Task { @MainActor in
            let r = await vyred.call("memory.uncorrect", ["fix": id], presence: false)
            if let why = Bridge.explain(r) { line = why; return }
            askedMemory = f.previousMemory
            iqAbstained = f.previousAbstained
            if var rep = reply { rep.order = ["iq"]; rep.text = ["iq": f.previousText]; rep.finished = true; rep.ok = true; reply = rep }
        }
    }
}
