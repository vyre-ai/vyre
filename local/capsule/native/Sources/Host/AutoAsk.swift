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
// - ⌘⏎ asks the same question (or the follow-up typed) on the deeper model, with the
//   conversation so far. threads.send has no model switch yet, so it is a new thread that is told
//   what was said; its follow-ups continue there.
// - ⌘O opens the answer's thread in Vyre chat on the box. Esc clears back to plain search.

import AppKit
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
        guard words.count >= 2 else { return false }
        // An exact local match (an app, a file, a setting) is what the words meant.
        if let k = topKind, k != "ask", k != "mention", topScore >= 0.95 { return false }
        if Route.asksQuestion(text) { return true }
        return words.count >= 3 && Route.intent(text, topKind: topKind, topScore: topScore) == .ask
    }

    /// The best local row: what the words would open if they are not a question.
    var topLocal: ResultItem? { flat.first { $0.kind != "ask" && $0.kind != "mention" } }

    /// Called by search() on every change of the words, plain search only.
    func scheduleAuto(_ q: Query, token t: Int) {
        autoTask?.cancel()
        let key = Self.autoKey(q.text)
        // The answer on screen was for other words: typing on lets it go.
        if let k = autoKey, k != key { dropAuto() }
        guard autoKey != key, key.split(separator: " ").count >= 2 else { return }
        let words = q.text.trimmingCharacters(in: .whitespacesAndNewlines)
        autoTask = Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(self.autoDelay * 1_000_000_000))
            guard !Task.isCancelled, t == self.token, self.autoKey != key, !self.followUp, self.target == nil else { return }
            let top = self.topLocal
            guard Self.wantsAnswer(words, topKind: top?.kind, topScore: top?.score ?? 0), self.quickFirst(words) else { return }
            if let hit = self.answerCache.first(where: { $0.key == key }) { self.showCached(hit, words); return }
            await self.waitForMemory(words)
            guard !Task.isCancelled, t == self.token else { return }
            self.autoKey = key
            self.handle(await self.ask(words))
            if !self.userMoved { self.selected = -1 }
        }
    }

    /// The router's first choice for these words is a quick answer. The user's own work, or a
    /// command, goes to the assistant ("Ask juno"), and ⏎ runs that row instead.
    func quickFirst(_ words: String) -> Bool {
        let first = Route.destinations(nil, words, catalog, quick: true).options.first
        return first == nil || first?.kind == .quick
    }

    /// Memory is asked 180 ms after the last key; give it a moment more so the answer has it.
    func waitForMemory(_ words: String) async {
        for _ in 0..<8 where memory?.text != words && recallTask != nil {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
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
        let top = topLocal
        let onScreen = answerOnTop && autoKey == Self.autoKey(text)
        let question = onScreen || (Self.wantsAnswer(words, topKind: top?.kind, topScore: top?.score ?? 0) && quickFirst(words))
        guard question else { return false }
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
            Task { @MainActor in self.handle(await self.ask(words)) }
            return
        }
        let who = VyreCandidate(kind: .thread, id: r.thread, label: "this answer")
        Task { @MainActor in self.handle(await self.send(words, to: who, model: r.model)) }
    }

    /// ⌘⏎: the same question, or the follow-up typed, on the deeper model, told the conversation.
    func deeper(_ words: String) {
        let said = convo.map { "Q: \($0.q)\nA: \($0.a)" }.joined(separator: "\n\n")
        let context = said.isEmpty ? nil : "Earlier in this conversation (answered by a faster model; answer again, more carefully):\n\n" + said
        text = ""
        followUp = true
        Task { @MainActor in self.handle(await self.ask(words, model: "sonnet", context: context)) }
    }

    /// Esc with an answer on screen: back to plain search.
    func clearAnswer() {
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
            line = "Vyre chat is on your box, and this Mac is not paired with one."
            return
        }
        NSWorkspace.shared.open(url)
        onClose?(nil)
    }
}
