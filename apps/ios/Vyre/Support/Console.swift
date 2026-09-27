import Foundation

/// An agent's live console (phone.md section 8): the commands it runs and what it says, one line
/// each, from its thread's events. It shows at most 4 new lines a second (SPEC principle 8): a
/// line that comes sooner than 250 ms after the last one waits, and a newer one replaces it (the
/// session's tool rows keep every step). Pure, so the rate is tested.
struct Console: Equatable, Sendable {
    struct Line: Equatable, Sendable, Identifiable {
        let id: Int
        let text: String
        /// A command (drawn with `$` in `--label`), else words.
        let command: Bool
    }

    static let interval: TimeInterval = 0.25

    private(set) var lines: [Line] = []
    /// The newest line not shown yet.
    private(set) var held: Line?
    private(set) var lastShown: Date = .distantPast
    private var next = 0
    var cap = 200

    /// The line an event stands for, if any: a tool's command, the words of a finished reply, a
    /// question, the end of a turn.
    static func line(_ e: VyreEvent) -> (text: String, command: Bool)? {
        switch e.type {
        case "thread.tool" where e["phase"].string == "started":
            let s = e["summary"].string ?? e["tool"].text
            if e["tool"].string == "Bash" { return (s, true) }
            return (Transcript.ToolLine(id: "", tool: e["tool"].text, summary: s, phase: "started", error: false).action, false)
        case "thread.text" where e["done"].bool == true && e["notice"].bool != true:
            let last = e["text"].text.split(separator: "\n").last(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }).map(String.init) ?? ""
            return last.isEmpty ? nil : (String(last.prefix(160)), false)
        case "ask.raised":
            return ("Waiting on you: \(e["summary"].string ?? e["tool"].text)", false)
        case "thread.finished":
            return (e["ok"].bool == false ? "Ended with an error" : "Done", false)
        default:
            return nil
        }
    }

    /// Offer a line at `now`. True when it was held, so the caller flushes 250 ms later.
    @discardableResult
    mutating func offer(_ text: String, command: Bool, now: Date) -> Bool {
        next += 1
        let l = Line(id: next, text: text, command: command)
        if now.timeIntervalSince(lastShown) >= Console.interval && held == nil {
            show(l, now: now)
            return false
        }
        held = l
        return true
    }

    /// A line from the backlog (threads.get), shown at once: the rate is for live lines.
    mutating func append(_ text: String, command: Bool) {
        next += 1
        lines.append(Line(id: next, text: text, command: command))
        if lines.count > cap { lines.removeFirst(lines.count - cap) }
    }

    /// Show the held line, when its 250 ms have passed.
    mutating func flush(now: Date) {
        guard let h = held, now.timeIntervalSince(lastShown) >= Console.interval - 0.001 else { return }
        held = nil
        show(h, now: now)
    }

    private mutating func show(_ l: Line, now: Date) {
        lines.append(l)
        if lines.count > cap { lines.removeFirst(lines.count - cap) }
        lastShown = now
    }
}
