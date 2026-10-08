// ActivityFeed: a conversation's stream frames folded into what Lumen draws (SPEC-0.3.0 part 11.5; the frames are
// team/0.3/IFACE-activity.md and the app's chat folder apps/app/src/chat/frames.js). Pure: no view, no socket, no clock.
//
// Rows, in the order they happened:
//   user       what the person said
//   reply      the assistant's words, streaming until text-done
//   thinking   the reasoning of a reply (text-delta with data.reasoning); the latest line is the thinking line, the whole of it opens on a tap
//   step       a tool or hand-off step: running, then done or failed (tool-started, tool-finished, paired by data.tool_id)
//   handoff    "Asked <name> (<role>)": one row per data.request, its state replaced by every later frame; the teammate's own frames
//              (data.via = the request) nest inside it, and the report-back is its result at done or failed
//   ask        a permission question waiting for the person
// A frame whose cursor is not above the last one is dropped, so a resume that replays does not repeat anything.
// What a teammate wrote (a result, its text) is data from another session, never the person's words.

import Foundation

struct ActivityFeed: Equatable {
    enum State: String, Equatable { case idle, starting, working, asking, waiting, paused, stopped, finished, failed }
    enum StepStatus: String, Equatable { case running, done, failed }
    enum HandoffState: String, Equatable { case queued, running, done, failed, cancelled
        var finished: Bool { self == .done || self == .failed || self == .cancelled }
    }

    struct Step: Equatable, Identifiable { var id: String; var tool: String; var summary: String; var status: StepStatus; var author: String? }
    struct Handoff: Equatable, Identifiable {
        var id: String            // the request id
        var agent: String; var role: String; var name: String; var project: String?
        var text: String; var state: HandoffState
        var thread: String?       // the teammate's own session, once it has started: "open kit's conversation"
        var result: String?
        var children: [Row]
        /// "Asked kit (billing)".
        var label: String { "Asked \(name)" + (role.isEmpty || role == name ? "" : " (\(role))") }
    }
    enum Row: Equatable, Identifiable {
        case user(id: String, text: String)
        case reply(id: String, text: String, done: Bool, author: String?)
        case thinking(id: String, text: String, done: Bool, author: String?)
        case step(Step)
        case handoff(Handoff)
        case ask(id: String, title: String, open: Bool)
        var id: String {
            switch self {
            case .user(let id, _), .reply(let id, _, _, _), .thinking(let id, _, _, _), .ask(let id, _, _): return id
            case .step(let s): return "t:" + s.id
            case .handoff(let h): return "h:" + h.id
            }
        }
    }

    var rows: [Row] = []
    var state: State = .idle
    /// The last cursor folded: where a reopened screen resumes (`from`).
    var cursor = 0

    /// Fold one frame. Anything that is not a chat frame, or is at or below the cursor, changes nothing. @discardableResult: true when something changed.
    @discardableResult
    mutating func apply(_ f: [String: Any]) -> Bool {
        guard let type = f["type"] as? String, type.hasPrefix("chat.") else { return false }
        let kind = String(type.dropFirst(5))
        let cur = VJ.int(f["cur"]) ?? 0
        if cur > 0 { if cur <= cursor { return false }; cursor = cur }
        let d = (f["data"] as? [String: Any]) ?? [:]
        if kind == "status" {
            let next = State(rawValue: VJ.s(d["state"])) ?? state
            if next == state { return false }
            state = next; return true
        }
        if kind == "reset" { rows = []; state = .idle; cursor = VJ.int(d["head"]) ?? cur; return true }
        let author = VJ.nonEmpty(f["author"])
        let message = VJ.nonEmpty(f["message"]) ?? VJ.nonEmpty(d["message"]) ?? "m\(cur)"
        if kind == "handoff" { return applyHandoff(d, author: author) }
        // A teammate's own frame lives inside the hand-off it answers.
        if let via = VJ.nonEmpty(d["via"]) {
            guard let i = rows.firstIndex(where: { if case .handoff(let h) = $0 { return h.id == via } else { return false } }), case .handoff(var h) = rows[i] else {
                // the hand-off frame has not been seen (a resume that began mid-way): a placeholder keeps the teammate's work together
                var h = Handoff(id: via, agent: "", role: "", name: author.map(Self.plain) ?? "a teammate", project: nil, text: "", state: .running, thread: nil, result: nil, children: [])
                let changed = Self.fold(&h.children, kind: kind, d: d, message: message, cur: cur, author: author)
                _ = changed; rows.append(.handoff(h)); return true
            }
            let changed = Self.fold(&h.children, kind: kind, d: d, message: message, cur: cur, author: author)
            if changed { rows[i] = .handoff(h) }
            return changed
        }
        return Self.fold(&rows, kind: kind, d: d, message: message, cur: cur, author: author)
    }

    private mutating func applyHandoff(_ d: [String: Any], author: String?) -> Bool {
        guard let request = VJ.nonEmpty(d["request"]) else { return false }
        let to = (d["to"] as? [String: Any]) ?? [:]
        let stateWord = VJ.s(d["state"])
        let hs = HandoffState(rawValue: stateWord) ?? .queued
        if let i = rows.firstIndex(where: { if case .handoff(let h) = $0 { return h.id == request } else { return false } }), case .handoff(var h) = rows[i] {
            let before = h
            // a later frame replaces the earlier state; a field it leaves out stays
            if let a = VJ.nonEmpty(to["agent"]) { h.agent = a }
            if let r = VJ.nonEmpty(to["role"]) { h.role = r }
            if let n = VJ.nonEmpty(to["name"]) { h.name = n }
            if let p = VJ.nonEmpty(to["project"]) { h.project = p }
            if let t = VJ.nonEmpty(d["text"]) { h.text = t }
            if let th = VJ.nonEmpty(d["thread"]) { h.thread = th }
            if let r = VJ.nonEmpty(d["result"]) { h.result = r }
            // a hand-off that has ended never goes back to running
            if !(before.state.finished && !hs.finished) { h.state = hs }
            if h == before { return false }
            rows[i] = .handoff(h); return true
        }
        rows.append(.handoff(Handoff(id: request, agent: VJ.s(to["agent"]), role: VJ.s(to["role"]), name: VJ.nonEmpty(to["name"]) ?? VJ.s(to["agent"]), project: VJ.nonEmpty(to["project"]),
                                     text: VJ.s(d["text"]), state: hs, thread: VJ.nonEmpty(d["thread"]), result: VJ.nonEmpty(d["result"]), children: [])))
        return true
    }

    /// The ordinary frames, into any list of rows (the conversation's, or a hand-off's).
    private static func fold(_ rows: inout [Row], kind: String, d: [String: Any], message: String, cur: Int, author: String?) -> Bool {
        switch kind {
        case "user-message":
            let key = "u:" + (VJ.nonEmpty(d["message"]) ?? message)
            if let i = rows.firstIndex(where: { $0.id == key }) { rows[i] = .user(id: key, text: VJ.s(d["text"])); return true }
            rows.append(.user(id: key, text: VJ.s(d["text"]))); return true
        case "text-delta":
            let reasoning = VJ.bool(d["reasoning"]) == true
            let key = (reasoning ? "r:" : "a:") + message + (reasoning ? ":" + String(VJ.int(d["index"]) ?? 0) : "")
            let piece = VJ.s(d["text"])
            if let i = rows.firstIndex(where: { $0.id == key }) {
                switch rows[i] {
                case .reply(_, let t, let done, let a): if done || piece.isEmpty { return false }; rows[i] = .reply(id: key, text: t + piece, done: false, author: a)
                case .thinking(_, let t, let done, let a): if done || piece.isEmpty { return false }; rows[i] = .thinking(id: key, text: t + piece, done: false, author: a)
                default: return false
                }
                return true
            }
            if piece.isEmpty { return false }
            rows.append(reasoning ? .thinking(id: key, text: piece, done: false, author: author) : .reply(id: key, text: piece, done: false, author: author)); return true
        case "text-done":
            // one frame closes the message's reply and its thoughts
            var changed = false
            for i in rows.indices {
                switch rows[i] {
                case .reply(let id, let t, false, let a) where id == "a:" + message: rows[i] = .reply(id: id, text: t, done: true, author: a); changed = true
                case .thinking(let id, let t, false, let a) where id.hasPrefix("r:" + message + ":"): rows[i] = .thinking(id: id, text: t, done: true, author: a); changed = true
                default: break
                }
            }
            return changed
        case "tool-started":
            let id = VJ.nonEmpty(d["tool_id"]) ?? "c\(cur)"
            if let i = rows.firstIndex(where: { $0.id == "t:" + id }) { _ = i; return false }
            rows.append(.step(Step(id: id, tool: VJ.nonEmpty(d["tool"]) ?? "tool", summary: VJ.s(d["summary"]), status: .running, author: author))); return true
        case "tool-finished":
            let id = VJ.nonEmpty(d["tool_id"]) ?? ""
            let status: StepStatus = VJ.bool(d["ok"]) == false ? .failed : .done
            if let i = rows.firstIndex(where: { $0.id == "t:" + id }), case .step(var s) = rows[i] {
                if s.status == status { return false }
                s.status = status; rows[i] = .step(s); return true
            }
            rows.append(.step(Step(id: id.isEmpty ? "c\(cur)" : id, tool: VJ.nonEmpty(d["tool"]) ?? "tool", summary: VJ.s(d["summary"]), status: status, author: author))); return true
        case "ask":
            let id = "k:" + (VJ.nonEmpty(d["ask_id"]) ?? "c\(cur)")
            if rows.contains(where: { $0.id == id }) { return false }
            rows.append(.ask(id: id, title: VJ.nonEmpty(d["title"]) ?? VJ.s(d["summary"]), open: true)); return true
        case "ask-answered":
            let id = "k:" + VJ.s(d["ask_id"])
            guard let i = rows.firstIndex(where: { $0.id == id }), case .ask(_, let title, let open) = rows[i], open else { return false }
            rows[i] = .ask(id: id, title: title, open: false); return true
        default: return false
        }
    }

    // ---- what the screen reads --------------------------------------------------------------------------------------------

    /// The thinking line: the last line of the latest thought, cut for one row. nil when nothing was thought this conversation.
    var thinkingLine: String? {
        for r in rows.reversed() {
            if case .thinking(_, let t, _, _) = r {
                let line = t.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.last { !$0.isEmpty } ?? ""
                if line.isEmpty { continue }
                return line.count > 140 ? String(line.prefix(139)) + "…" : line
            }
        }
        return nil
    }
    /// Every thought, in order: what the thinking line opens to.
    var thinkingAll: String {
        rows.compactMap { if case .thinking(_, let t, _, _) = $0 { return t } else { return nil } }.joined(separator: "\n\n")
    }
    /// Whether the assistant is still thinking now: the last reasoning row has not finished and no reply started after it.
    var thinkingNow: Bool {
        guard let i = rows.lastIndex(where: { if case .thinking = $0 { return true } else { return false } }) else { return false }
        if case .thinking(_, _, let done, _) = rows[i], !done { return !rows[(i + 1)...].contains { if case .reply = $0 { return true } else { return false } } }
        return false
    }
    var runningSteps: Int { rows.reduce(0) { n, r in if case .step(let s) = r, s.status == .running { return n + 1 } else if case .handoff(let h) = r, !h.state.finished { return n + 1 } else { return n } } }
    /// The words beside the header: what the conversation is doing now.
    var headerState: String {
        if state == .asking { return "waiting for you" }
        if runningSteps > 0 { return "working" }
        if state == .working || state == .starting { return thinkingNow ? "thinking" : "working" }
        switch state { case .failed: return "failed"; case .paused: return "paused"; case .stopped: return "stopped"; default: return "" }
    }

    static func plain(_ id: String) -> String {
        let s = String(id.split(separator: ":", maxSplits: 1).last ?? Substring(id)).replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
        return s.prefix(1).uppercased() + s.dropFirst()
    }
}
