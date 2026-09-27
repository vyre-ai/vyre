// State: what is waiting on the user, and what a thread is saying, folded from vyred's events.
// Ported from local/capsule/lib/state.js.
//
// Two kinds of thing wait: a Gate hold (a draft or a send that needs a yes, spec 7.7) and a
// permission question from a running session (ask.raised, spec 7.8). The Capsule shows both in
// one attention list, oldest first, because whoever has waited longest should be answered first.
// Only an explicit question asks for attention (floor rule 6).
//
// A third kind waits quietly: a lesson Vyre proposes (lesson.proposed, core/learn). It sits in
// the same list for the user to accept or decline, marked quiet, and never raises attention on
// its own: it does not count toward the attention dot or the menu-bar badge (loud() counts what does).
//
// Pure: events in, values out. VyreModel owns the one copy and publishes it, so a Capsule that
// wakes up is shown the truth rather than what it last saw.
//
// One change from the JS, from the gallery: a proposed lesson's card showed the rule three times,
// and its Where and From lines said "all" and "everywhere". A lesson row now carries a LessonCard
// with the rule once and only the lines that say something; a scope of "all" says nothing (every
// rule applies everywhere unless it says otherwise), so it is left out of the card and the row.

import Foundation

public enum WaitingSource: String, Sendable, Equatable { case gate, ask, lesson }

/// Where a lesson applies: everywhere, a project, an agent, or a word the learn module chose.
public enum LessonScope: Sendable, Equatable {
    case all
    case project(String)
    case agent(String)
    case named(String)

    init?(_ v: Any?) {
        if let s = v as? String { if s.isEmpty { return nil }; self = s == "all" ? .all : .named(s); return }
        guard let o = v as? [String: Any] else { return nil }
        if let p = VJ.nonEmpty(o["project"]) { self = .project(p); return }
        if let a = VJ.nonEmpty(o["agent"]) { self = .agent(a); return }
        return nil
    }
}

public struct LessonLine: Sendable, Equatable {
    public var label: String
    public var text: String
}

/// What a proposed lesson's card shows: the rule, once, and the lines that say something.
public struct LessonCard: Sendable, Equatable {
    public var rule: String
    public var lines: [LessonLine]
}

/// One row in the attention list.
public struct Waiting: Sendable, Equatable {
    public var source: WaitingSource
    /// The id vyred knows it by (a hold, an ask, a lesson). Not unique across sources: use `key`.
    public var id: String
    public var title: String
    public var sub: String
    public var at: Double
    public var thread: String?
    public var project: String?
    public var to: String?
    public var via: String?
    public var kind: String?
    public var why: String?
    public var rule: String?
    public var tool: String?
    public var scope: LessonScope?
    /// A lesson's scope in words, when it says something ("in Harlow Legal", "for juno").
    public var `where`: String?
    /// Where a lesson came from, in words.
    public var from: String?
    public var lesson: LessonCard?
    /// Waits without asking for attention (proposed lessons).
    public var quiet: Bool

    public var key: String { "\(source.rawValue):\(id)" }
    public func age(now: Double = vyNowMs()) -> String { Route.age(at, now: now) }
}

public typealias SlugName = (String) -> String

public enum VyState {
    private static func s(_ v: Any?) -> String { VJ.s(v) }

    /// A Gate hold as a row, from gate.held or a gate.held event: `{id, kind, via, to: [string],
    /// summary, why, agent, thread, project, at, error?}`. The words are not in it; the card asks
    /// gate.get for them when it opens.
    public static func fromHeld(_ h: [String: Any]) -> Waiting {
        let who = VJ.nonEmpty(h["agent"]) ?? "an agent"
        let to: [String] = ((h["to"] as? [Any]) ?? [h["to"] as Any]).compactMap { VJ.truthy($0) ? VJ.str($0) : nil }
        var first = (to.first ?? "someone").replacingOccurrences(of: "\\s*<.*>$", with: "", options: .regularExpression)
        if to.count > 1 { first += " and \(to.count - 1) more" }
        let kind = VJ.str(h["kind"])
        let what = kind == "spend" ? "a payment to" : kind == "delete" ? "a deletion at" : "a message to"
        let sub = [VJ.nonEmpty(h["summary"]), VJ.nonEmpty(h["projectName"]) ?? VJ.nonEmpty(h["project"]), VJ.truthy(h["error"]) ? "last send failed" : nil]
            .compactMap { $0 }.joined(separator: " · ")
        return Waiting(source: .gate, id: s(h["id"]), title: "\(who) drafted \(what) \(first)", sub: sub, at: VJ.num(h["at"]).flatMap { $0 == 0 ? nil : $0 } ?? vyNowMs(),
                       thread: VJ.nonEmpty(h["thread"]), project: VJ.nonEmpty(h["project"]), to: to.joined(separator: ", "), via: VJ.nonEmpty(h["via"]),
                       kind: (kind?.isEmpty == false ? kind : nil) ?? "send", why: VJ.nonEmpty(h["why"]), quiet: false)
    }

    /// An ask.raised event as a row. `name` turns a project slug into the name people know it by.
    public static func fromAsk(_ e: VyredEvent, name: SlugName = { $0 }) -> Waiting {
        let p = e.payload
        let who = VJ.nonEmpty(p["agent"]) ?? VJ.nonEmpty(p["thread_name"]) ?? "a session"
        let sub = [e.project.flatMap { $0.isEmpty ? nil : name($0) }, VJ.nonEmpty(p["destination"]).map { "to \($0)" }, VJ.nonEmpty(p["reason"])]
            .compactMap { $0 }.joined(separator: " · ")
        return Waiting(source: .ask, id: VJ.nonEmpty(p["ask"]) ?? s(p["id"]), title: "\(who) asks to \(VJ.nonEmpty(p["summary"]) ?? VJ.nonEmpty(p["tool"]) ?? "use a tool")",
                       sub: sub, at: e.at != 0 ? Double(e.at) : vyNowMs(), thread: e.thread ?? VJ.nonEmpty(p["thread"]), project: e.project,
                       rule: VJ.nonEmpty(p["reason"]), tool: VJ.nonEmpty(p["tool"]), quiet: false)
    }

    /// How a lesson's scope reads. "all" reads as nothing: it is what every rule is unless it says
    /// otherwise, and a card line saying "everywhere" told the user nothing.
    static func scopeWords(_ scope: LessonScope?, _ name: SlugName) -> String? {
        switch scope {
        case .none, .all?: return nil
        case .named(let w)?: return w
        case .project(let p)?: return "in \(name(p))"
        case .agent(let a)?: return "for \(a)"
        }
    }

    /// Where a lesson came from, in words: its source's kind ({kind, session, ...}) or a string.
    static func sourceWords(_ source: Any?) -> String? {
        let kind = (source as? String) ?? VJ.str((source as? [String: Any])?["kind"])
        guard let kind, !kind.isEmpty else { return nil }
        switch kind {
        case "prompt": return "from what you said"
        case "edited": return "from a draft you edited"
        case "remember", "user": return "you wrote it"
        default: return kind
        }
    }

    /// A proposed lesson as a row, from learn.lessons ({id, rule, scope, source, created}) or from a
    /// lesson.proposed payload ({lesson, rule, checked, scope, source}, with the event's `at`).
    /// Quiet: it waits in the list and never asks for attention.
    public static func fromLesson(_ l: [String: Any], name: SlugName = { $0 }) -> Waiting {
        let id = s(l["lesson"] ?? l["id"])
        let rule = s(l["rule"])
        let scope = LessonScope(l["scope"])
        let w = scopeWords(scope, name), f = sourceWords(l["source"])
        var lines: [LessonLine] = []
        if let w { lines.append(LessonLine(label: "Where", text: w)) }
        if let f { lines.append(LessonLine(label: "From", text: f)) }
        let project: String? = { if case .project(let p)? = scope { return p }; return nil }()
        let at = VJ.num(l["at"]).flatMap { $0 == 0 ? nil : $0 } ?? VJ.num(l["created"]).flatMap { $0 == 0 ? nil : $0 } ?? vyNowMs()
        return Waiting(source: .lesson, id: id, title: "Vyre proposes: \"\(rule)\"", sub: [w, f].compactMap { $0 }.joined(separator: " · "), at: at,
                       thread: VJ.nonEmpty((l["source"] as? [String: Any])?["session"]), project: project, rule: rule, scope: scope,
                       where: w, from: f, lesson: LessonCard(rule: rule, lines: lines), quiet: true)
    }

    /// How many waiting items ask for attention: the quiet ones (proposed lessons) do not.
    public static func loud(_ list: [Waiting]) -> Int { list.filter { !$0.quiet }.count }

    /// Oldest first, one row per source and id (the last word on it wins, in its first place).
    public static func waiting(_ list: [Waiting]) -> [Waiting] {
        var order: [String] = [], byKey: [String: Waiting] = [:]
        for w in list where !w.id.isEmpty {
            if byKey[w.key] == nil { order.append(w.key) }
            byKey[w.key] = w
        }
        let rows: [(Int, Waiting)] = order.enumerated().map { (i: Int, k: String) in (i, byKey[k]!) }
        let sorted = rows.sorted { (a: (Int, Waiting), b: (Int, Waiting)) -> Bool in a.1.at != b.1.at ? a.1.at < b.1.at : a.0 < b.0 }
        return sorted.map { $0.1 }
    }

    private static func drop(_ list: [Waiting], _ source: WaitingSource, _ id: Any?) -> [Waiting] {
        let key = s(id)
        return list.filter { !($0.source == source && $0.id == key) }
    }

    /// Fold one event into the waiting list. The same list comes back when the event changes nothing.
    public static func applyWaiting(_ list: [Waiting], _ e: VyredEvent, name: SlugName = { $0 }) -> [Waiting] {
        let p = e.payload
        switch e.type {
        case "ask.raised": return waiting(list + [fromAsk(e, name: name)])
        // ask.answered {ask, decision, by}: decision "cancelled" when Claude Code withdrew the
        // question or its thread stopped. There is no separate event for that.
        case "ask.answered": return drop(list, .ask, p["ask"] ?? p["id"])
        case "gate.held":
            var h = p
            h["at"] = e.at; h["thread"] = e.thread ?? NSNull(); h["project"] = e.project ?? NSNull()
            return waiting(list + [fromHeld(h)])
        case "gate.released", "gate.rejected": return drop(list, .gate, p["id"])
        case "lesson.proposed":
            var l = p; l["at"] = e.at
            return waiting(list + [fromLesson(l, name: name)])
        case "lesson.learned", "lesson.retired": return drop(list, .lesson, p["lesson"] ?? p["id"])
        // A send that failed is held again, with its error, for the user to send again or discard.
        case "gate.failed":
            let id = s(p["id"])
            return list.map { w in
                guard w.source == .gate, w.id == id else { return w }
                var x = w
                let base = w.sub.hasSuffix(" · last send failed") ? String(w.sub.dropLast(" · last send failed".count)) : (w.sub == "last send failed" ? "" : w.sub)
                x.sub = [base, "last send failed"].filter { !$0.isEmpty }.joined(separator: " · ")
                return x
            }
        default: return list
        }
    }

    // MARK: a reply as it streams

    /// thread.text is `{message, delta}`, a piece to append (throttled to 20 a second by the
    /// switchboard), or `{message, text, done: true}`, the whole block, which replaces the pieces:
    /// the whole block is what Claude Code said, the pieces are only how it arrived. `message` is
    /// Claude Code's message id, shared by a block's pieces and its whole text.
    public static func reply(_ thread: String) -> Reply { Reply(thread: thread) }

    /// The user stopped it: finished, with the error "stopped", and deaf to what comes after.
    public static func cancel(_ r: Reply) -> Reply {
        var x = r; x.finished = true; x.ok = false; x.error = "stopped"; x.cancelled = true; return x
    }

    public static func applyReply(_ r: Reply, _ e: VyredEvent) -> Reply {
        if r.cancelled || e.thread != r.thread { return r }
        let p = e.payload
        var x = r
        // A notice is vyred talking (a usage limit), not the model: status, never the answer.
        if e.type == "thread.text" && VJ.truthy(p["notice"]) { x.notice = s(p["text"]); return x }
        // Words queued for a session busy in a terminal reached it (the Harness handed them over).
        if e.type == "thread.sent" && p["queued"] != nil && !(p["queued"] is NSNull), x.queued != nil { x.queued?.delivered = true; return x }
        // Every event of a turn names it: the first one fixes this reply's turn.
        if let t = VJ.nonEmpty(p["turn"]) {
            if x.turn == nil { x.turn = t } else if t != x.turn { return r }
        }
        switch e.type {
        case "thread.turn": break
        case "thread.state":
            let st = VJ.s(p["state"])
            x.state = st
            if st == "failed" { x.finished = true; x.ok = false; x.error = VJ.nonEmpty(p["error"]) ?? "the turn failed" }
            if st == "idle" && x.finished && x.error == nil { x.idle = true }
        case "thread.usage":
            if let c = VJ.num(p["cost_usd"]) { x.cost = c }
            if let t = VJ.num(p["total_cost_usd"]) { x.totalCost = t }
        case "thread.text":
            let id = VJ.nonEmpty(p["message"]) ?? "m"
            if !x.order.contains(id) { x.order.append(id) }
            x.text[id] = VJ.truthy(p["done"]) ? s(p["text"]) : (r.text[id] ?? "") + s(p["delta"])
            x.finished = false
        case "thread.tool":
            x.tools = foldTool(r.tools, p, keep: 6)
        case "thread.stopped":
            // reason "idle": the session closed after 10 quiet minutes and resumes on the next
            // send (ADR 0030). The answer stands; nothing failed.
            if VJ.str(p["reason"]) == "idle" { x.finished = true; x.idle = true; break }
            x.finished = true; x.ok = false; x.error = "the thread stopped" + (VJ.nonEmpty(p["reason"]).map { ": \($0)" } ?? "")
        case "thread.finished":
            // A reply with turn ids is one turn: its cost is that turn's. Without them (an older
            // switchboard) the turns of the reply are summed, as before.
            if let c = VJ.num(p["cost_usd"]) ?? VJ.num(p["cost"]) { x.cost = x.turn != nil ? c : (r.cost ?? 0) + c }
            if let ms = VJ.num(p["duration_ms"]) { x.ms = ms }
            // canceled: an interrupt (Esc here or elsewhere) or a restart. Stopped, not failed.
            if VJ.truthy(p["canceled"]) { x.finished = true; x.ok = false; x.error = "stopped"; x.tools = r.tools.map { t in var t = t; if t.status == .running { t.status = .canceled }; return t }; break }
            let failed = VJ.bool(p["ok"]) == false || VJ.nonEmpty(p["error"]) != nil
            x.finished = true; x.ok = !failed; x.error = failed ? (VJ.nonEmpty(p["error"]) ?? "the turn failed") : nil
        // lease.changed {holder, previous, took?}: holder null when the keyboard was given back.
        case "lease.changed": x.lease = VJ.str(p["holder"])
        default: return r
        }
        return x
    }

    /// thread.tool's status: `status` (ADR 0030), or the older `phase` with `error`.
    static func toolStatus(_ p: [String: Any]) -> ToolStatus {
        if let st = VJ.str(p["status"]).flatMap(ToolStatus.init(rawValue:)) { return st }
        guard VJ.str(p["phase"]) == "done" else { return .running }
        return VJ.truthy(p["error"]) ? .failed : .completed
    }

    /// Fold one thread.tool into a turn's rows: a known call id changes its status in place (a
    /// row never moves), a new one is added at the end, and only the newest `keep` stay.
    static func foldTool(_ tools: [ReplyTool], _ p: [String: Any], keep: Int) -> [ReplyTool] {
        let id = VJ.nonEmpty(p["call"]) ?? s(p["id"])
        let status = toolStatus(p)
        if let i = tools.firstIndex(where: { $0.id == id }) {
            var out = tools
            out[i].status = status
            if let words = VJ.nonEmpty(p["summary"]), out[i].summary != words { out[i].summary = words }
            return out
        }
        let words = VJ.nonEmpty(p["summary"]) ?? VJ.nonEmpty(p["name"]) ?? VJ.nonEmpty(p["tool"]) ?? "a tool"
        return Array((tools + [ReplyTool(id: id, summary: words, status: status)]).suffix(keep))
    }

    /// The reply as one string, messages in the order they began.
    public static func replyText(_ r: Reply) -> String { joined(r.order, r.text) }

    fileprivate static func joined(_ order: [String], _ text: [String: String]) -> String {
        order.compactMap { text[$0] }.filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    // MARK: direct messages
    //
    // `@juno` (the assistant) and `@<agent>` read as a conversation: the agent's current thread,
    // its history and the reply streaming in, in one list. It is folded from the same thread
    // events as a reply, so a DM opened mid-answer and one that watched the answer start end up
    // identical. A message is a turn, not a Claude Code message: what the user sent (thread.sent,
    // from any surface), then everything the agent said and did until thread.finished.

    /// Tool lines kept per turn: the newest, since a long turn can run hundreds.
    public static let dmTools = 10

    public static func dm(_ agent: String, thread: String? = nil, limit: Int = 30) -> Dm {
        Dm(agent: agent, thread: thread.flatMap { $0.isEmpty ? nil : $0 }, limit: max(1, limit))
    }

    /// What thread.sent carries of the user's words: the switchboard's cut(text, 2000).
    public static func sentText(_ t: String) -> String {
        let x = t.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return x.count > 2000 ? String(x.prefix(1999)) + "…" : x
    }

    /// The words the user just sent from this Capsule, shown at once and marked pending.
    public static func dmPending(_ d: Dm, _ key: String, _ text: String, _ at: Double) -> Dm {
        var x = d; x.busy = true
        x.messages.append(DmMessage(id: key, role: .user, text: text, at: at != 0 ? at : vyNowMs(), pending: true))
        return x
    }

    /// A send that failed: its pending message goes.
    public static func dmDrop(_ d: Dm, _ key: String) -> Dm {
        let messages = d.messages.filter { !($0.pending && $0.id == key) }
        if messages.count == d.messages.count { return d }
        let open = messages.contains { $0.pending } || messages.contains { $0.role == .agent && $0.done != true }
        var x = d; x.messages = messages; x.busy = open && d.busy
        return x
    }

    /// The agent's turn still being written, found from the end past the user's pending words.
    private static func openTurn(_ msgs: [DmMessage], _ message: String?) -> Int {
        var i = msgs.count - 1
        while i >= 0 {
            let m = msgs[i]
            if m.role == .user && m.pending { i -= 1; continue }
            if m.role == .agent && (m.done != true || (message != nil && (m.parts?.order.contains(message!) ?? false))) { return i }
            return -1
        }
        return -1
    }

    /// Put a new agent turn before any pending words (those are answered after it).
    private static func insertTurn(_ msgs: [DmMessage], _ m: DmMessage) -> [DmMessage] {
        var at = msgs.count
        while at > 0, msgs[at - 1].role == .user, msgs[at - 1].pending { at -= 1 }
        var out = msgs; out.insert(m, at: at); return out
    }

    private static func newTurn(_ e: VyredEvent, _ id: String) -> DmMessage {
        DmMessage(id: id, role: .agent, text: "", at: e.at != 0 ? Double(e.at) : vyNowMs(), tools: [], done: false, error: nil, parts: DmParts())
    }

    /// Fold one event into a DM. The same value comes back when nothing changed. Events of other
    /// threads change nothing, except the start of this agent's new thread, which the DM follows
    /// from then on.
    public static func applyDm(_ d0: Dm, _ e: VyredEvent, name: SlugName = { $0 }) -> Dm {
        var d = d0
        let p = e.payload
        let thread = e.thread.flatMap { $0.isEmpty ? nil : $0 }
        let hasId = e.id > 0
        if hasId && e.id <= d.last { return d }
        // The agent's thread is started by the first words sent to it (agents.ask), or replaced.
        if e.type == "thread.started", let thread, VJ.str(p["agent"]) == d.agent, thread != d.thread, !VJ.truthy(p["resumed"]) { d.thread = thread; d.holder = nil }
        // The words this Capsule sent, before agents.ask has said which thread took them.
        if d.thread == nil, e.type == "thread.sent", let thread, VJ.str(p["surface"]) == "capsule",
           d.messages.contains(where: { $0.pending && sentText($0.text) == s(p["text"]) }) { d.thread = thread }
        guard let thread, thread == d.thread else { return d }
        let last = hasId ? e.id : d.last
        let msgs = d.messages
        if e.type == "thread.text" && VJ.truthy(p["notice"]) { d.last = last; d.notice = s(p["text"]); return d }

        switch e.type {
        case "thread.sent":
            let surface = VJ.nonEmpty(p["surface"])
            var i = -1
            if surface == "capsule" {
                i = msgs.firstIndex { $0.pending && sentText($0.text) == s(p["text"]) } ?? -1
                if i < 0 { i = msgs.firstIndex { $0.pending } ?? -1 }
            }
            let m = DmMessage(id: "e\(hasId ? e.id : last)", role: .user, text: i >= 0 ? msgs[i].text : s(p["text"]),
                              at: e.at != 0 ? Double(e.at) : (i >= 0 ? msgs[i].at : vyNowMs()), surface: surface != nil && surface != "capsule" ? surface : nil)
            // A turn left open by a thread that never said finished (vyred restarted) is over now.
            var closed = msgs.map { x -> DmMessage in var y = x; if y.role == .agent && y.done != true { y.done = true }; return y }
            if i >= 0 { closed[i] = m } else { closed = insertTurn(closed, m) }
            d.last = last; d.busy = true; d.messages = closed
            return trim(d)
        case "thread.text":
            let id = VJ.nonEmpty(p["message"]) ?? "m"
            var list = msgs
            var i = openTurn(list, id)
            if i < 0 { list = insertTurn(list, newTurn(e, id)); i = openTurn(list, id) }
            var t = list[i]
            var parts = t.parts ?? DmParts()
            if !parts.order.contains(id) { parts.order.append(id) }
            parts.text[id] = VJ.truthy(p["done"]) ? s(p["text"]) : (parts.text[id] ?? "") + s(p["delta"])
            t.parts = parts; t.text = joined(parts.order, parts.text); t.done = false
            list[i] = t
            d.last = last; d.busy = true; d.messages = list
            return trim(d)
        case "thread.tool":
            var list = msgs
            var i = openTurn(list, nil)
            if toolStatus(p) != .running {
                d.last = last
                if i < 0 { return d }
                list[i].tools = foldTool(list[i].tools ?? [], p, keep: dmTools)
                d.messages = list
                return d
            }
            if i < 0 { list = insertTurn(list, newTurn(e, "t\(hasId ? e.id : last)")); i = openTurn(list, nil) }
            list[i].tools = foldTool(list[i].tools ?? [], p, keep: dmTools)
            d.last = last; d.busy = true; d.messages = list
            return trim(d)
        case "thread.finished", "thread.stopped":
            let error: String? = e.type == "thread.stopped"
                ? (d.busy && VJ.str(p["reason"]) != "idle" ? "the thread stopped" + (VJ.nonEmpty(p["reason"]).map { ": \($0)" } ?? "") : nil)
                : (VJ.bool(p["ok"]) == false ? (VJ.nonEmpty(p["error"]) ?? "the turn failed") : nil)
            let i = openTurn(msgs, nil)
            var list = msgs
            if i >= 0 { list[i].done = true; list[i].error = error }
            else if let error { var t = newTurn(e, "f\(hasId ? e.id : last)"); t.done = true; t.error = error; list = insertTurn(msgs, t) }
            d.last = last; d.busy = list.contains { $0.pending }; d.messages = list
            return trim(d)
        case "ask.raised", "ask.answered":
            // Whoever else asks in this thread, it is this agent's question.
            var ev = e
            if e.type == "ask.raised" && VJ.nonEmpty(p["agent"]) == nil { ev.payload["agent"] = d.agent }
            d.last = last; d.asks = applyWaiting(d.asks, ev, name: name)
            return d
        case "lease.changed":
            d.last = last; d.holder = VJ.str(p["holder"])
            return d
        default:
            d.last = last
            return d
        }
    }

    /// The newest `limit` messages; pending words are never cut.
    private static func trim(_ d: Dm) -> Dm {
        if d.messages.count <= d.limit { return d }
        let keep = Array(d.messages.suffix(d.limit))
        let lost = d.messages.dropLast(d.limit).filter { $0.pending }
        var x = d; x.messages = lost + keep; return x
    }

    /// A DM from threads.get: `{thread: record, asks: open rows, events}`. Events come without their
    /// thread (it is the one asked for), so it is put back. Open asks come from the table, which is
    /// what is open now; ask events in the history would only replay what was already answered.
    public static func dmHistory(_ d: Dm, _ got: [String: Any], askRow: ([String: Any]) -> Waiting, name: SlugName = { $0 }) -> Dm {
        let rec = (got["thread"] as? [String: Any]) ?? [:]
        let id = VJ.nonEmpty(rec["id"]) ?? d.thread ?? ""
        var x = d
        x.thread = id; x.holder = VJ.nonEmpty(rec["holder"])
        for raw in (got["events"] as? [Any]) ?? [] {
            guard let evd = raw as? [String: Any], var ev = VyredEvent(json: evd) else { continue }
            if ev.type == "ask.raised" || ev.type == "ask.answered" { x.last = max(x.last, ev.id); continue }
            ev.thread = id; ev.project = VJ.nonEmpty(rec["project"])
            x = applyDm(x, ev, name: name)
        }
        let busy = ["working", "waiting"].contains(VJ.s(rec["status"]))
        // A turn with no end in the log, on a thread that is not working, ended without saying so.
        if !busy { x.messages = x.messages.map { m in var y = m; if y.role == .agent && y.done != true { y.done = true }; return y } }
        x.busy = busy
        let open = ((got["asks"] as? [Any]) ?? []).compactMap { $0 as? [String: Any] }
            .filter { !VJ.truthy($0["decision"]) && (VJ.nonEmpty($0["state"]) == nil || VJ.str($0["state"]) == "open") }
        x.asks = waiting(open.map(askRow))
        return x
    }

    /// Words sent from this Capsule while the history loaded. One the history already holds (its
    /// thread.sent came after `after`, the event the stream had reached on open) is that message.
    public static func dmCarry(_ d: Dm, _ pending: [DmMessage], after: Int) -> Dm {
        var x = d
        var taken = Set<String>()
        for m in pending {
            if let i = x.messages.firstIndex(where: { y in
                y.role == .user && !y.pending && y.surface == nil && !taken.contains(y.id) && (Int(y.id.dropFirst()) ?? Int.min) > after && sentText(m.text) == y.text
            }) {
                taken.insert(x.messages[i].id); x.messages[i].text = m.text
            } else {
                x = dmPending(x, m.id, m.text, m.at)
            }
        }
        return x
    }

    /// What the UI is handed: no bookkeeping.
    public static func dmView(_ d: Dm) -> DmView {
        DmView(agent: d.agent, thread: d.thread, busy: d.busy, holder: d.holder, asks: d.asks, loading: d.loading,
               messages: d.messages.map { m in var y = m; y.parts = nil; return y })
    }
}

// MARK: - The values

/// A tool call's status, as thread.tool carries it (ADR 0030): running, then one of the others.
public enum ToolStatus: String, Sendable, Equatable {
    case running, completed, failed, canceled
}

/// One tool call in a turn, keyed by its call id so a status update finds its row.
public struct ReplyTool: Sendable, Equatable {
    public var id: String
    public var summary: String
    public var status: ToolStatus
    public var done: Bool { status != .running }
    public var error: Bool { status == .failed }
    public init(id: String, summary: String, status: ToolStatus) { self.id = id; self.summary = summary; self.status = status }
    public init(id: String, summary: String, done: Bool, error: Bool) {
        self.init(id: id, summary: summary, status: !done ? .running : error ? .failed : .completed)
    }
}

/// A place a memory answer came from: a fact's own turn, or a transcript quote.
public struct RecallSource: Sendable, Equatable {
    public var session: String
    public var seq: Int?
    public var name: String
    public var quote: String
    public var age: String
    /// A fact's confidence 0..1; nil for a transcript quote, which has none.
    public var confidence: Double?
}

public struct ReplyMemory: Sendable, Equatable {
    public var answer: String?
    public var sources: [RecallSource]
    public var confidence: Double?
    public var answerAge: String?
}

/// A thread's reply as it streams. `cost` is what thread.finished reported, summed over the turns
/// of this reply, `ms` how long the last turn took. The switchboard reports no token counts.
public struct Reply: Sendable, Equatable {
    public var thread: String
    /// The turn this reply is (`<thread>:<n>`), from the first event that names one; events of
    /// another turn of the same thread are not this reply's.
    public var turn: String?
    /// The session's state from thread.state: starting, running, waiting, idle, stopped, failed.
    public var state: String?
    /// What the whole session has cost so far (thread.usage total_cost_usd).
    public var totalCost: Double?
    public var order: [String] = []
    public var text: [String: String] = [:]
    public var tools: [ReplyTool] = []
    public var finished = false
    public var ok: Bool?
    public var error: String?
    public var lease: String?
    public var cost: Double?
    public var ms: Double?
    /// The user's Stop: nothing that arrives after it changes the reply.
    public var cancelled = false
    /// The session closed for idleness after this answer; the next send resumes it.
    public var idle = false
    public var model: String?
    public var memory: ReplyMemory?
    /// The newest notice from vyred itself, drawn as one faint line under the answer.
    public var notice: String?
    /// Words queued for a session busy in a terminal, until the Harness hands them over.
    public var queued: QueuedSend?
    public init(thread: String) { self.thread = thread }
}

public struct QueuedSend: Sendable, Equatable {
    public var name: String
    public var note: String?
    public var delivered = false
    /// Its id in the queue (threads.send's queued_id), for Esc to take it back (threads.unqueue).
    public var id: Int?
    /// Taken back before it was handed over.
    public var withdrawn = false
    public init(name: String, note: String? = nil, id: Int? = nil) { self.name = name; self.note = note; self.id = id }
}

public enum DmRole: String, Sendable, Equatable { case user, agent }

public struct DmParts: Sendable, Equatable {
    public var order: [String] = []
    public var text: [String: String] = [:]
}

public struct DmMessage: Sendable, Equatable, Identifiable {
    public var id: String
    public var role: DmRole
    public var text: String
    public var at: Double
    /// Another surface the user typed from ("deck", "cli"); nil for this Capsule.
    public var surface: String?
    public var pending = false
    /// An agent turn's tool calls, one line each; nil for the user's words.
    public var tools: [ReplyTool]?
    public var done: Bool?
    public var error: String?
    var parts: DmParts?
    public init(id: String, role: DmRole, text: String, at: Double, surface: String? = nil, pending: Bool = false,
                tools: [ReplyTool]? = nil, done: Bool? = nil, error: String? = nil, parts: DmParts? = nil) {
        self.id = id; self.role = role; self.text = text; self.at = at; self.surface = surface; self.pending = pending
        self.tools = tools; self.done = done; self.error = error; self.parts = parts
    }
}

/// The open DM, with its bookkeeping (`last`, the newest event folded in, so nothing folds twice).
public struct Dm: Sendable, Equatable {
    public var agent: String
    public var thread: String?
    public var messages: [DmMessage] = []
    public var asks: [Waiting] = []
    public var busy = false
    public var holder: String?
    public var last = 0
    public var limit = 30
    public var loading = false
    /// vyred's own words in this thread (a usage limit): a status line, never a message (rule 3).
    public var notice: String?
    public init(agent: String, thread: String? = nil, limit: Int = 30) { self.agent = agent; self.thread = thread; self.limit = limit }

    /// Whether a fold changed anything the UI draws (not only the event cursor).
    func visiblyDiffers(from b: Dm) -> Bool {
        messages != b.messages || asks != b.asks || busy != b.busy || holder != b.holder || thread != b.thread || loading != b.loading || notice != b.notice
    }
}

public struct DmView: Sendable, Equatable {
    public var agent: String
    public var thread: String?
    public var busy: Bool
    public var holder: String?
    public var asks: [Waiting]
    public var loading: Bool
    public var messages: [DmMessage]
}

public extension VyredEvent {
    /// An event as vyred writes it: `{id, type, source, thread, project, at, payload}`.
    init?(json e: [String: Any]) {
        guard let type = VJ.str(e["type"]) else { return nil }
        self.init(id: VJ.int(e["id"]) ?? 0, type: type, source: VJ.s(e["source"]), thread: VJ.nonEmpty(e["thread"]), project: VJ.nonEmpty(e["project"]),
                  at: VJ.int(e["at"]) ?? 0, payload: (e["payload"] as? [String: Any]) ?? [:])
    }
}
