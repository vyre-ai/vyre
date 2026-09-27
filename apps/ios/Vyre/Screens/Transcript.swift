import Foundation

/// A thread's transcript, built from its events (CONTRACT.md 3.3 and 3.4). Pure: `threads.get`'s
/// backlog and the live stream go through the same `apply`, so a reload and a live view agree.
struct Transcript: Equatable, Sendable {
    struct ToolLine: Equatable, Sendable, Identifiable {
        let id: String
        var tool: String
        var summary: String
        var phase: String
        var error: Bool
        /// The output, when the box sends it with the result (`output`); none yet on main.
        var output: String? = nil

        /// The action and its target, as the session's tool rows read: "Ran npm test",
        /// "Edited q3.tsx". The full command or path is in the expanded row.
        var action: String {
            let rest = summary.hasPrefix(tool + " ") ? String(summary.dropFirst(tool.count + 1)) : summary
            let base = rest.split(separator: "/").last.map(String.init) ?? rest
            switch tool {
            case "Bash": return rest.isEmpty ? "Ran a command" : "Ran \(rest)"
            case "Edit", "MultiEdit", "NotebookEdit": return "Edited \(base)"
            case "Write": return "Wrote \(base)"
            case "Read": return "Read \(base)"
            case "WebFetch":
                let url = summary.replacingOccurrences(of: "fetch ", with: "")
                return "Fetched \(URL(string: url)?.host ?? url)"
            case "WebSearch": return "Searched " + summary.replacingOccurrences(of: "search ", with: "")
            default: return summary.isEmpty ? tool : summary
            }
        }
    }

    /// How an ask was answered (`ask.answered`): the card shrinks to one line of it.
    struct Answer: Equatable, Sendable {
        let decision: String
        let by: String?
        let scope: String?
        let at: Double

        /// "Approved by you, 12:07", "Always allowed in Harlow Legal, 12:07". `time` is the
        /// answer's time as the phone writes times.
        func line(project: String?, question: Bool, time: String) -> String {
            let who = by.map { $0.hasPrefix("agent:") ? String($0.dropFirst(6)) : "you" } ?? "you"
            let what: String
            switch decision {
            case "always": what = scope == "project" ? "Always allowed in \(project ?? "this project")" : "Always allowed"
            case "allow": what = question ? "Answered by \(who)" : "Approved by \(who)"
            case "deny": what = question ? "Put off by \(who)" : "Denied by \(who)"
            default: what = "Withdrawn"
            }
            return time.isEmpty ? what : "\(what), \(time)"
        }
    }

    enum Entry: Equatable, Sendable, Identifiable {
        /// The person (or an agent or module) typed this.
        case said(key: String, text: String, surface: String?)
        /// The model's message: deltas until `done` replaces them.
        case reply(message: String, text: String, done: Bool)
        case notice(key: String, text: String)
        /// Consecutive tool calls grouped into one block.
        case tools(key: String, lines: [ToolLine])
        case finished(key: String, text: String)
        case stopped(key: String, reason: String)
        /// A held Gate item or a permission ask, drawn inline from the NeedsStore.
        case gate(id: String)
        case ask(id: String)

        var id: String {
            switch self {
            case .said(let k, _, _), .notice(let k, _), .tools(let k, _), .finished(let k, _), .stopped(let k, _): k
            case .reply(let m, _, _): "m-" + m
            case .gate(let id): "g-" + id
            case .ask(let id): "a-" + id
            }
        }
    }

    /// Where each event landed: its id and time, and the entry (and tool line) it drew. What Open
    /// session resolves an anchor against.
    struct Mark: Equatable, Sendable {
        let event: Int
        let at: Double
        let entry: String
        let line: String?
    }

    /// What Open session scrolls to and flashes: an entry, and a tool line inside it.
    struct Target: Equatable, Sendable {
        let entry: String
        var line: String?
    }

    private(set) var entries: [Entry] = []
    private(set) var marks: [Mark] = []
    /// Answers by ask id, from `ask.answered`.
    private(set) var answers: [String: Answer] = [:]
    /// Which asks were questions (`ask.raised` kind), so an answered one reads "Answered by you".
    private(set) var questions: Set<String> = []
    /// When each entry began (ms), for the time stamps at gaps of more than an hour.
    private(set) var times: [String: Double] = [:]
    private(set) var lastId = 0
    /// Texts this phone sent and has already drawn, waiting for their `thread.sent` echo.
    private(set) var pending: [String] = []
    var working = false

    /// A turn the phone sent, drawn at once.
    mutating func echo(_ text: String, now: Date = Date()) {
        pending.append(text)
        let key = "local-\(pending.count)-\(entries.count)"
        entries.append(.said(key: key, text: text, surface: "ios"))
        times[key] = now.timeIntervalSince1970 * 1000
        working = true
    }

    /// The entries that get a centred time stamp before them: the first, and each one more than an
    /// hour after the one before it.
    func stamped(gap: Double = 3_600_000) -> Set<String> {
        var out: Set<String> = []
        var last: Double?
        for e in entries {
            guard let t = times[e.id] else { continue }
            if last == nil || t - last! > gap { out.insert(e.id) }
            last = t
        }
        return out
    }

    mutating func apply(_ e: VyreEvent) {
        if e.id > 0 {
            if e.id <= lastId { return }
            lastId = e.id
        }
        let before = entries
        draw(e)
        // The entry this event drew or grew: the one that changed, else the last.
        guard e.id > 0 || e.at > 0 else { return }
        var entry: String?
        if entries.count > before.count { entry = entries.last?.id }
        else if let i = entries.indices.first(where: { $0 < before.count && entries[$0] != before[$0] }) { entry = entries[i].id }
        if let entry {
            let line = e.type == "thread.tool" ? e["id"].string : nil
            marks.append(Mark(event: e.id, at: e.at, entry: entry, line: line))
            if times[entry] == nil && e.at > 0 { times[entry] = e.at }
        }
    }

    /// The anchor contract (phone.md section 15): the tool call when there is one, else the event,
    /// else the first item at or after `at`. Nil when the loaded part of the transcript lacks it.
    func resolve(_ a: Anchor) -> Target? {
        if let t = a.toolUseId {
            for entry in entries {
                if case .tools(let k, let lines) = entry, lines.contains(where: { $0.id == t }) { return Target(entry: k, line: t) }
            }
        }
        if let ev = a.event, let m = marks.first(where: { $0.event == ev }) { return Target(entry: m.entry, line: m.line) }
        if let at = a.at, let m = marks.first(where: { $0.at >= at }) { return Target(entry: m.entry, line: m.line) }
        return nil
    }

    private mutating func draw(_ e: VyreEvent) {
        let key = "e\(e.id)"
        switch e.type {
        case "thread.sent":
            let text = e["text"].text
            if e["surface"].string == "ios", let i = pending.firstIndex(of: text) { pending.remove(at: i); return }
            entries.append(.said(key: key, text: text, surface: e["surface"].string))
            working = true
        case "thread.text":
            let message = e["message"].text
            if e["notice"].bool == true { entries.append(.notice(key: key, text: e["text"].text)); return }
            let done = e["done"].bool == true
            if let i = entries.lastIndex(where: { if case .reply(let m, _, _) = $0 { return m == message }; return false }) {
                if case .reply(_, let old, let wasDone) = entries[i] {
                    if wasDone && !done { return }
                    entries[i] = .reply(message: message, text: done ? e["text"].text : old + e["delta"].text, done: done)
                }
            } else {
                entries.append(.reply(message: message, text: done ? e["text"].text : e["delta"].text, done: done))
            }
        case "thread.tool":
            let id = e["id"].text
            if e["phase"].string == "done" {
                for i in entries.indices.reversed() {
                    if case .tools(let k, var lines) = entries[i], let j = lines.firstIndex(where: { $0.id == id }) {
                        lines[j].phase = "done"
                        lines[j].error = e["error"].bool == true
                        if let o = e["output"].string ?? e["result"].string { lines[j].output = o }
                        entries[i] = .tools(key: k, lines: lines)
                        return
                    }
                }
                return
            }
            let line = ToolLine(id: id, tool: e["tool"].text, summary: e["summary"].text, phase: "started", error: false, output: e["output"].string)
            if case .tools(let k, var lines)? = entries.last {
                lines.append(line)
                entries[entries.count - 1] = .tools(key: k, lines: lines)
            } else {
                entries.append(.tools(key: key, lines: [line]))
            }
        case "thread.finished":
            working = false
            var parts: [String] = []
            if e["ok"].bool == false { parts.append(e["error"].string ?? "Ended with an error") }
            if let c = e["cost_usd"].double, c > 0 { parts.append(String(format: "$%.2f", c)) }
            if let d = e["duration_ms"].double { parts.append(String(format: "%.0f s", d / 1000)) }
            entries.append(.finished(key: key, text: parts.joined(separator: " · ")))
        case "thread.stopped":
            working = false
            entries.append(.stopped(key: key, reason: e["reason"].string ?? "stopped"))
        case "gate.held", "gate.revised":
            let id = e["id"].text
            if !id.isEmpty, !entries.contains(.gate(id: id)) { entries.append(.gate(id: id)) }
        case "ask.raised":
            let id = e["ask"].string ?? e["id"].text
            if !id.isEmpty, !entries.contains(.ask(id: id)) { entries.append(.ask(id: id)) }
            if e["kind"].string == "question" { questions.insert(id) }
        case "ask.answered":
            let id = e["ask"].text
            if !id.isEmpty { answers[id] = Answer(decision: e["decision"].string ?? "allow", by: e["by"].string, scope: e["scope"].string, at: e.at) }
        default: break
        }
    }

    /// `recall.thread`'s turns for a recorded session with no live thread.
    mutating func load(turns: [JSON]) {
        for (i, t) in turns.enumerated() {
            let text = t["text"].text
            if text.isEmpty { continue }
            if t["role"].string == "user" { entries.append(.said(key: "r\(i)", text: text, surface: "recorded")) }
            else { entries.append(.reply(message: "r\(i)", text: text, done: true)) }
        }
    }
}
