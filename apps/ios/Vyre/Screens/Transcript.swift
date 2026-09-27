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
    private(set) var lastId = 0
    /// Texts this phone sent and has already drawn, waiting for their `thread.sent` echo.
    private(set) var pending: [String] = []
    var working = false

    /// A turn the phone sent, drawn at once.
    mutating func echo(_ text: String) {
        pending.append(text)
        entries.append(.said(key: "local-\(pending.count)-\(entries.count)", text: text, surface: "ios"))
        working = true
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
                        entries[i] = .tools(key: k, lines: lines)
                        return
                    }
                }
                return
            }
            let line = ToolLine(id: id, tool: e["tool"].text, summary: e["summary"].text, phase: "started", error: false)
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
