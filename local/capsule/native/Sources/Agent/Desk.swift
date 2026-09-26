// Desk: what waits on the user (Gate holds, permission asks, proposed lessons), and the card that
// answers one. Ported from the Electron bridge's loadWaiting, held and answer.
//
// The list is read whole on every open (gate.held, threads.asks, learn.lessons) and then kept true
// by the stream (VyState.applyWaiting): a Capsule that was hidden still sees a question raised
// meanwhile. Nothing is removed on optimism: a row goes when vyred says it was answered, so a yes
// that never arrived still shows as waiting.
//
// A Gate hold's card reads its words from gate.get. Mail is To, Subject and a body, each edited in
// place; Send sends exactly what is on the card (gate.approve with `edited`), so the Gate sends
// the user's words and Learning sees the correction. Anything else (an http call, a payment) is
// shown as the Gate summarised it and approved as it is.

import Combine
import Foundation
import SwiftUI

@MainActor
public final class Desk: ObservableObject {
    public enum Mode: Equatable {
        case none
        /// The list, with the highlighted row.
        case list(Int)
        /// One item's card.
        case card(String)
    }

    @Published public private(set) var waiting: [Waiting] = []
    @Published public var mode: Mode = .none
    /// The open card's words, once gate.get has answered (holds only).
    @Published public private(set) var held: HeldCard?
    /// The draft as the user is editing it.
    @Published public var draft = MailDraft(to: "", subject: "", body: "")
    @Published public private(set) var loading = false
    /// One line on the card: why a Send did not happen, or that it is being sent.
    @Published public var note: String?
    @Published public private(set) var busy = false

    let vyred: VyredClient
    /// A project's name from its slug, for the rows.
    var projectName: SlugName = { $0 }
    /// Who is asking, for an ask with no agent in it: the thread's name as the catalog knows it.
    var who: (String?) -> String? = { _ in nil }
    private var subs: [VyredSubscription] = []
    private var sink: AnyCancellable?
    /// Told of every change, so the Capsule redraws and resizes (CapsuleModel forwards it).
    var changed: (() -> Void)?

    init(vyred: VyredClient) {
        self.vyred = vyred
        sink = objectWillChange.sink { [weak self] in self?.changed?() }
    }

    /// The Capsule hid: the list and any card close; what waits stays, and is read again on open.
    func hidden() { closeCard(); mode = .none }

    /// What counts toward the Beacon dot: proposed lessons are quiet.
    public var loud: Int { VyState.loud(waiting) }
    public var open: Waiting? { if case .card(let k) = mode { return waiting.first { $0.key == k } }; return nil }
    public var pinned: Bool { if case .card = mode { return true }; return false }

    // MARK: the list

    /// Follow the events that change the list. Once, for the life of the Capsule.
    func follow() {
        guard subs.isEmpty else { return }
        for p in ["ask.*", "gate.*", "lesson.*"] {
            subs.append(vyred.on(p) { [weak self] e in self?.heard(e) })
        }
    }

    func heard(_ e: VyredEvent) {
        var ev = e
        if e.type == "ask.raised", VJ.nonEmpty(e.payload["agent"]) == nil, let w = who(e.thread ?? VJ.nonEmpty(e.payload["thread"])) {
            ev.payload["agent"] = w
        }
        let next = VyState.applyWaiting(waiting, ev, name: projectName)
        if next != waiting { waiting = next }
        settle()
        // The open hold was revised elsewhere: read its words again.
        if e.type == "gate.revised", let o = open, o.source == .gate, VJ.s(e.payload["id"]) == o.id { Task { await loadCard(o) } }
    }

    /// Read everything waiting now. A missing module means none of its rows, never an error.
    func load() async {
        var rows: [Waiting] = []
        if vyred.has("gate.held") {
            let g = await vyred.call("gate.held", [:], presence: false)
            let list = (g.data as? [[String: Any]]) ?? ((g.data as? [String: Any])?["held"] as? [[String: Any]]) ?? []
            rows += list.map(VyState.fromHeld)
        }
        if vyred.has("threads.asks") {
            let a = await vyred.call("threads.asks", [:], presence: false)
            let list = (a.data as? [[String: Any]]) ?? ((a.data as? [String: Any])?["asks"] as? [[String: Any]]) ?? []
            for x in list {
                // Only questions still open; an answered one stays in the table with its decision.
                if VJ.truthy(x["decision"]) { continue }
                if let st = VJ.nonEmpty(x["state"]), !["open", "pending", "waiting"].contains(st) { continue }
                var p = x
                if VJ.nonEmpty(p["agent"]) == nil, let w = who(VJ.nonEmpty(x["thread"])) { p["agent"] = w }
                if p["ask"] == nil { p["ask"] = x["id"] }
                let at = Int(VJ.num(x["at"]) ?? 0)
                rows.append(VyState.fromAsk(VyredEvent(id: 0, type: "ask.raised", source: "load", thread: VJ.nonEmpty(x["thread"]),
                                                       project: VJ.nonEmpty(x["project"]), at: at, payload: p), name: projectName))
            }
        }
        if vyred.has("learn.lessons") {
            let l = await vyred.call("learn.lessons", ["status": "proposed"], presence: false)
            for x in (l.data as? [[String: Any]]) ?? [] where VJ.nonEmpty(x["status"]) == nil || VJ.s(x["status"]) == "proposed" {
                rows.append(VyState.fromLesson(x, name: projectName))
            }
        }
        let next = VyState.waiting(rows)
        if next != waiting { waiting = next }
        settle()
    }

    /// The list and the card follow the rows: a card whose item left closes, the list stays in range.
    private func settle() {
        switch mode {
        case .list(let i):
            if waiting.isEmpty { mode = .none } else if i >= waiting.count { mode = .list(waiting.count - 1) }
        case .card(let k):
            if !waiting.contains(where: { $0.key == k }) { closeCard(); mode = waiting.isEmpty ? .none : .list(0) }
        case .none: break
        }
    }

    public func openList() { if !waiting.isEmpty { mode = .list(0) } }

    public func move(_ by: Int) {
        guard case .list(let i) = mode, !waiting.isEmpty else { return }
        let n = i + by
        // Up from the first row goes back to the box.
        if n < 0 { mode = .none; return }
        mode = .list(min(n, waiting.count - 1))
    }

    public var highlighted: Waiting? { if case .list(let i) = mode, waiting.indices.contains(i) { return waiting[i] }; return nil }

    // MARK: the card

    public func openCard(_ w: Waiting) {
        mode = .card(w.key)
        note = nil
        held = nil
        draft = MailDraft(to: "", subject: "", body: "")
        if w.source == .gate { Task { await loadCard(w) } }
    }

    func loadCard(_ w: Waiting) async {
        loading = true
        let r = await vyred.call("gate.get", ["id": w.id], presence: false)
        loading = false
        guard open?.key == w.key else { return }
        if let why = Bridge.explain(r) { note = why; return }
        let g = (r.data as? [String: Any]) ?? [:]
        let c = (g["final"] as? [String: Any]) ?? (g["draft"] as? [String: Any]) ?? [:]
        let to = ((g["to"] as? [Any]) ?? [g["to"] as Any]).compactMap { VJ.truthy($0) ? VJ.str($0) : nil }.joined(separator: ", ")
        let mail = c["subject"] is String || c["body"] is String
        let card = HeldCard(id: w.id, draft: mail ? MailDraft(to: to, subject: VJ.s(c["subject"]), body: VJ.s(c["body"])) : nil,
                            summary: VJ.s(g["summary"]), via: VJ.nonEmpty(g["via"]), kind: VJ.nonEmpty(g["kind"]), error: VJ.nonEmpty(g["error"]))
        held = card
        if let d = card.draft { draft = d }
        // It was approved before and the sender failed; it is back, as the user last left it.
        if let e = card.error { note = "The last send failed: \(e)" }
    }

    func closeCard() { held = nil; note = nil; loading = false }

    /// Back from the card to the list.
    public func back() { closeCard(); mode = waiting.isEmpty ? .none : .list(0) }

    // MARK: answering

    /// Every field on the card, changed or not: another surface may have revised the hold since the
    /// card opened, and Send must send what this card shows. The Gate takes recipients as a list.
    var edited: DraftEdit? {
        guard held?.draft != nil else { return nil }
        let to = draft.to.split(whereSeparator: { ",;\n".contains($0) }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return DraftEdit(to: to, subject: draft.subject, body: draft.body)
    }

    /// Yes for the item: Send a hold, Allow an ask, Accept a lesson.
    public func yes(_ w: Waiting) async { await answer(w, w.source == .gate ? .send : w.source == .lesson ? .accept : .allow) }
    /// No for the item: Discard, Deny, Decline.
    public func no(_ w: Waiting) async { await answer(w, w.source == .gate ? .discard : w.source == .lesson ? .decline : .deny) }

    /// Answer one item. It leaves the list when vyred says so (the event), and the list is read
    /// again for an older module that answers without one.
    public func answer(_ w: Waiting, _ decision: AnswerDecision) async {
        guard !busy else { return }
        busy = true; note = nil
        defer { busy = false }
        let r: VyredResult
        switch w.source {
        case .lesson:
            let yes = decision == .accept || decision == .allow || decision == .send
            let tool = yes ? "learn.accept" : "learn.retire"
            guard vyred.has(tool) else { note = "Lessons come from core/learn, which this vyred is not running."; return }
            let idv: Any = Int(w.id).map { $0 as Any } ?? w.id
            r = await vyred.call(tool, ["id": idv], presence: false)
            if case .failure(let code, let message) = r {
                note = Bridge.presenceRefused(code: code, message: message, lesson: true, yes: yes, id: w.id) ?? Bridge.explain(code: code, message: message)
                return
            }
        case .gate:
            let send = decision == .send || decision == .allow
            var input: [String: Any] = ["id": w.id]
            if send, let e = edited { input["edited"] = e.json }
            r = await vyred.call(send ? "gate.approve" : "gate.reject", input, presence: false)
            if case .failure(let code, let message) = r {
                note = Bridge.presenceRefused(code: code, message: message, lesson: false, yes: send, id: w.id) ?? Bridge.explain(code: code, message: message)
                return
            }
            // A send the user approved and the sender refused goes back to held with its error.
            if let d = r.data as? [String: Any], VJ.s(d["state"]) == "failed" {
                note = "Not sent: \(VJ.nonEmpty(d["error"]) ?? "the sender failed"). It is still held; Send tries again."
                return
            }
        case .ask:
            let d = decision == .send ? "allow" : decision == .discard ? "deny" : decision.rawValue
            r = await vyred.call("threads.answer", ["ask": w.id, "decision": d, "surface": "capsule"], presence: false)
            if let why = Bridge.explain(r) { note = why; return }
            if let x = r.data as? [String: Any], VJ.bool(x["answered"]) == false {
                note = VJ.nonEmpty(x["note"]) ?? "That question was already answered or withdrawn."
                return
            }
        }
        await load()
    }
}
