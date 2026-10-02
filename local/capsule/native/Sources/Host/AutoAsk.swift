// AutoAsk: a question answers itself, and the box becomes the follow-up box (the user's feedback,
// 2026-09-27).
//
// - Words that read as a question (a question word, a "?", or three words or more that nothing on
//   this Mac matches strongly) are answered on the fast model once typing rests (autoDelay,
//   600 ms), with what memory said about them. The answer streams at the top of the panel, above
//   the local results. More typing cancels it and asks again after the next pause; the same words
//   never ask twice, and the last few answers come back at once from a small cache. A single word
//   or an exact app or file match never asks.
// - ⏎ keeps the answer and turns the box into the follow-up box ("Ask a follow-up"); ⏎ there
//   continues the same thread. ↓ into the results first makes ⏎ open that row instead.
// - ⌘⏎ always means think deeper: the same question (or the follow-up typed, or any words of
//   two or more) on the deeper model, in the SAME thread when there is one:
//   threads.model switches it and threads.thinking turns thinking on, so the conversation is
//   already there. With a vyred that has no threads.model, it is a new thread told what was said.
// - ⌘O opens the answer's thread in Vyre chat on the box. Esc clears back to plain search.

import AppKit
import AVFoundation
import Foundation

extension CapsuleModel {
    /// An answer is on screen above the results, and the box still holds its question.
    var answerOnTop: Bool { asked != nil && !followUp && target == nil && autoKey != nil }

    nonisolated static func autoKey(_ text: String) -> String {
        text.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// Whether these words ask for an answer, given the best local match. Pure, for the tests.
    nonisolated static func wantsAnswer(_ text: String, topKind: String?, topScore: Double) -> Bool {
        let words = text.split(whereSeparator: \.isWhitespace)
        guard words.count >= 2, CLIRun.parse(text) == nil else { return false }
        // An exact local match (an app, a file, a setting) is what the words meant.
        if let k = topKind, k != "ask", k != "mention", topScore >= 0.95 { return false }
        if Route.asksQuestion(text) { return true }
        return words.count >= 3 && Route.intent(text, topKind: topKind, topScore: topScore) == .ask
    }

    /// "memory: who is Dana" -> "who is Dana": the person asked memory on purpose. Nil for anything else.
    nonisolated static func memoryRequest(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.lowercased().hasPrefix("memory:") else { return nil }
        let rest = t.dropFirst("memory:".count).trimmingCharacters(in: .whitespacesAndNewlines)
        return rest.isEmpty ? nil : rest
    }

    /// Memory answers, as asked: memory.ask with its sources and Wrong?/Forget. Never the default.
    func askMemory(_ words: String) async -> ActionOutcome {
        guard !words.isEmpty else { return .said("Type a question for memory first.") }
        if let out = await askIQ(words) { return out }
        return .failed("This Vyre has no memory to ask yet.")
    }

    /// The best local row: what the words would open if they are not a question.
    var topLocal: ResultItem? { flat.first { $0.kind != "ask" && $0.kind != "mention" } }

    /// Called by search() on every change of the words, plain search only.
    func scheduleAuto(_ q: Query, token t: Int) {
        autoTask?.cancel()
        if q.text == prefilled { return }
        let key = Self.autoKey(q.text)
        // The answer on screen was for other words: typing on lets it go.
        if let k = autoKey, k != key { dropAuto() }
        guard autoKey != key, !dictating, Self.doRequest(q.text) == nil, key.split(separator: " ").count >= 2 else { return }
        let words = q.text.trimmingCharacters(in: .whitespacesAndNewlines)
        autoTask = Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(self.autoDelay * 1_000_000_000))
            guard !Task.isCancelled, t == self.token, self.autoKey != key, !self.followUp, self.target == nil else { return }
            let top = self.topLocal
            guard Self.wantsAnswer(words, topKind: top?.kind, topScore: top?.score ?? 0), self.quickFirst(words) else { return }
            if let hit = self.answerCache.first(where: { $0.key == key }) { self.showCached(hit, words); return }
            self.autoKey = key
            self.handle(await self.ask(words))
            if !self.userMoved { self.selected = -1 }
        }
    }

    /// The router's first choice for these words is a quick answer. The user's own work, or a
    /// command, goes to the assistant ("Ask juno"), and ⏎ runs that row instead.
    func quickFirst(_ words: String) -> Bool {
        let first = Route.destinations(nil, words, catalog, quick: true, models: (models.quick, models.deeper)).options.first
        return first == nil || first?.kind == .quick
    }

    func showCached(_ hit: (key: String, reply: Reply, memory: MemoryAnswer?), _ words: String) {
        replySub?.cancel(); replySub = nil
        autoKey = hit.key
        asked = words
        askedMemory = hit.memory
        reply = hit.reply
        if !userMoved { selected = -1 }
    }

    /// Let an answer go: stop its turn if it still streams, and clear it from the screen.
    func dropAuto() {
        autoTask?.cancel()
        if let r = reply, !r.finished, !r.thread.isEmpty {
            if vyred.has("threads.interrupt") {
                Task { [vyred] in _ = await vyred.call("threads.interrupt", ["thread": r.thread], presence: false) }
            } else { keeper.stop(r.thread) }
        }
        replySub?.cancel(); replySub = nil
        reply = nil; asked = nil; askedMemory = nil; autoKey = nil
        iqStage = nil; iqDraft = nil; iqAnswerId = nil; iqCorrecting = nil; iqFixed = nil; iqAbstained = false
    }

    /// A finished answer: kept for the conversation and the cache.
    func remember(_ q: String, _ r: Reply) {
        let a = VyState.replyText(r)
        guard !a.isEmpty else { return }
        convo.append((q, a))
        if convo.count > 8 { convo.removeFirst(convo.count - 8) }
        let key = Self.autoKey(q)
        answerCache.removeAll { $0.key == key }
        answerCache.insert((key, r, askedMemory), at: 0)
        if answerCache.count > 5 { answerCache.removeLast(answerCache.count - 5) }
    }

    /// ⏎ and ⌘⏎ in plain search and the follow-up box. False: the selected row takes the key.
    func handleReturn(command: Bool) -> Bool {
        guard target == nil, mentionQuery == nil else { return false }
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if followUp {
            guard !words.isEmpty else { return true }
            if command { deeper(words) } else { followUpSend(words) }
            return true
        }
        if userMoved && !command { return false }
        // "do …": computer use, from ⏎ or ⌘⏎.
        if let job = Self.doRequest(words) { startComputerUse(job); return true }
        // "memory: …": memory answers, on purpose, with its sources (the default is the assistant, #46).
        if !command, let q = Self.memoryRequest(words) {
            autoTask?.cancel()
            autoKey = Self.autoKey(q)
            Task { @MainActor in self.handle(await self.askMemory(q)) }
            commitFollowUp()
            return true
        }
        let top = topLocal
        let onScreen = answerOnTop && autoKey == Self.autoKey(text)
        let question = onScreen || (Self.wantsAnswer(words, topKind: top?.kind, topScore: top?.score ?? 0) && quickFirst(words))
        // ⌘⏎ has one meaning: think deeper, on any words of two or more (computer use starts only
        // from "do ...", above). One word, or a row the user moved to, keeps the row's own ⌘⏎.
        let deepAnyway = command && !question && !userMoved && words.split(separator: " ").count >= 2
        guard question || deepAnyway else { return false }
        autoTask?.cancel()
        if command {
            deeper(onScreen ? (asked ?? words) : words)
        } else if !onScreen {
            // ⏎ before the pause: ask now.
            autoKey = Self.autoKey(words)
            Task { @MainActor in self.handle(await self.ask(words)) }
        }
        commitFollowUp()
        return true
    }

    /// The answer stays; the box empties and becomes the follow-up box.
    func commitFollowUp() {
        followUp = true
        userMoved = false
        text = ""
    }

    /// Words typed in the follow-up box go to the answer's thread.
    func followUpSend(_ words: String) {
        text = ""
        guard let r = reply, !r.thread.isEmpty else {
            // A Vyre IQ answer has no thread: the follow-up starts one, told the conversation.
            let said = convo.map { "Q: \($0.q)\nA: \($0.a)" }.joined(separator: "\n\n")
            let context = said.isEmpty ? nil : "Earlier in this conversation:\n\n" + said
            Task { @MainActor in self.handle(await self.ask(words, context: context)) }
            return
        }
        let who = VyreCandidate(kind: .thread, id: r.thread, label: "this answer")
        Task { @MainActor in self.handle(await self.send(words, to: who, model: r.model)) }
    }

    /// ⌘⏎: the same question, or the follow-up typed, on the deeper model, told the conversation.
    func deeper(_ words: String) {
        // Read before the box empties: emptying it lets the answer on top go.
        let same = reply.flatMap { r in !r.thread.isEmpty && !doing && vyred.has("threads.model") ? r.thread : nil }
        let question = asked
        followUp = true
        text = ""
        if let same {
            Task { @MainActor in self.handle(await self.deeperInThread(words, thread: same, question: question)) }
            return
        }
        let said = convo.map { "Q: \($0.q)\nA: \($0.a)" }.joined(separator: "\n\n")
        let context = said.isEmpty ? nil : "Earlier in this conversation (answered by a faster model; answer again, more carefully):\n\n" + said
        Task { @MainActor in self.handle(await self.ask(words, model: models.deeper, context: context)) }
    }

    /// Today's fallback for the deeper model ⌘⏎ switches to: sessions.models.get's purpose
    /// "agent" overrides it (CapsuleModel.loadModels), read as `models.deeper`.
    static let deeperModel = ModelFallback.deeper

    /// ⌘⏎ in the answer's own thread: the deeper model and thinking on, then the words. The same
    /// question again is asked to be thought through; words typed after it are sent as they are.
    /// Thinking needs a running session: a thread that went idle gets it once the send wakes it.
    func deeperInThread(_ words: String, thread: String, question: String?) async -> ActionOutcome {
        let switched = await vyred.call("threads.model", ["thread": thread, "model": models.deeper], presence: false)
        if let why = Bridge.explain(switched) { return .failed("Could not switch to the deeper model: \(why)") }
        let before = await vyred.call("threads.thinking", ["thread": thread, "on": true], presence: false)
        let thinking = (before.data as? [String: Any])?["thinking"] as? Bool == true
        let again = Self.autoKey(words) == Self.autoKey(question ?? "")
        let prompt = again ? "Think this through more carefully and answer again: \(words)" : words
        let who = VyreCandidate(kind: .thread, id: thread, label: "this answer")
        let out = await send(prompt, to: who, model: models.deeper)
        if reply?.thread == thread { asked = words }
        if !thinking, reply?.thread == thread {
            _ = await vyred.call("threads.thinking", ["thread": thread, "on": true], presence: false)
        }
        return out
    }

    /// Esc with an answer on screen: back to plain search.
    func clearAnswer() {
        stopSpeaking()
        doing = false
        dropAuto()
        followUp = false
        convo = []
        userMoved = false
        text = ""
        search()
    }

    /// ⌘O: the answer's thread in Vyre chat, on the box's Deck.
    func openInChat() {
        guard let r = reply, !r.thread.isEmpty else { return }
        guard let box = catalog.box, let url = URL(string: box.hasPrefix("http") ? box : "https://" + box)?
            .appendingPathComponent("chat/thread").appendingPathComponent(r.thread) else {
            line = "Vyre chat is on your server, and this Mac is not paired with one."
            return
        }
        NSWorkspace.shared.open(url)
        onClose?(nil)
    }
}

// MARK: - Voice and computer use, first class in the same box


extension CapsuleModel {
    /// Words spoken into the box (sight's talk chord). Partial words show as they come and ask
    /// nothing. `final: true` ends the dictation with the words left in the box to edit -- tap
    /// or hold-release to stop never asks anything on its own (the user's spec, 28 Sep, matching
    /// chat's tap-to-talk); only submitDictated() (an ordinary ⏎ while listening, or the "send
    /// it" command word) actually asks.
    func dictate(_ words: String, final: Bool) {
        dictating = !final
        autoTask?.cancel()
        text = words
        if final && words.isEmpty { search() } // nothing heard: back to plain search, not a submit
    }

    /// ⏎ while still listening, or the "send it" command word: submit the box's current words
    /// right now, as ⏎ would. The caller (sight) has already stopped the mic.
    func submitDictated() {
        dictating = false
        guard !text.isEmpty else { return }
        voiceTurn = true
        if !handleReturn(command: false) { voiceTurn = false; search() }
    }

    /// Esc while listening: back to exactly what the box held before this utterance (never a
    /// general clear -- text typed before or after the dictated span is untouched, since the
    /// dictated span is the box's whole content in this single-line box).
    func cancelDictation(_ restore: String) {
        dictating = false
        autoTask?.cancel()
        text = restore
    }

    /// An answer is being read aloud (Esc stops it, with the answer).
    var speaking: Bool { (speaker as? AVAudioPlayer)?.isPlaying == true }

    /// Say the answer aloud, when spoken replies are on (voice.settings speak). Off, voice.speak
    /// refuses with speak_off and nothing happens.
    func speakAnswer(_ answer: String) {
        let words = String(answer.prefix(2000))
        guard !words.isEmpty, vyred.has("voice.speak") else { return }
        let socket = vyred.socket
        Task { @MainActor in
            // `reply: true` has vyred make the written reply speakable (markdown to words, code and tables dropped,
            // a link said as "a link", cut at a sentence) before it is spoken. Only a turn that came from the mic
            // is spoken; a typed question gets text only. speak_off and no_key are silent.
            let r = await vyred.call("voice.speak", ["text": words, "reply": true], presence: false)
            guard let d = r.data as? [String: Any], let url = VJ.nonEmpty(d["url"]) else { return }
            let got = await withCheckedContinuation { (k: CheckedContinuation<Data?, Never>) in
                DispatchQueue.global(qos: .userInitiated).async {
                    if case .success(let (status, body)) = VyHTTP.exchange(socket: socket, method: "GET", path: url, body: nil, timeout: 30), status == 200 {
                        k.resume(returning: body)
                    } else { k.resume(returning: nil) }
                }
            }
            guard let audio = got, let player = try? AVAudioPlayer(data: audio) else { return }
            self.speaker = player
            player.play()
        }
    }

    func stopSpeaking() {
        (speaker as? AVAudioPlayer)?.stop()
        speaker = nil
    }

    /// "do …": the words ask for something to be done on this Mac, not answered.
    nonisolated static func doRequest(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        for p in ["do ", "please do "] where t.lowercased().hasPrefix(p) {
            let rest = String(t.dropFirst(p.count)).trimmingCharacters(in: .whitespaces)
            return rest.isEmpty ? nil : rest
        }
        return nil
    }

    /// What a computer-use session is told, after the user's words.
    nonisolated static let computerUseBrief = """
    You were started from Vyre Lumen to do this on the user's Mac. Use the hands.* tools \
    (observe, find, act, commit) and screen.* to see and act; every action is shown on screen and \
    the user can stop it with Esc. Anything that sends, posts, pays or deletes goes through the \
    Gate and waits for the user's Touch ID: do not try to get around it. Say in one line what you \
    did, or what stopped you.
    """

    /// Start computer use for these words, in the answer area, with the tool rows live.
    func startComputerUse(_ words: String) {
        autoTask?.cancel()
        autoKey = Self.autoKey(words)
        Task { @MainActor in self.handle(await self.ask(words, computerUse: true)) }
        commitFollowUp()
    }
}
