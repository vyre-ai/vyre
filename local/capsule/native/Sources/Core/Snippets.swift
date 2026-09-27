// Snippets: the user's own text snippets and commands, from one JSON file they edit by hand.
//
//   {
//     "snippets": [
//       { "keyword": ";sig", "title": "Signature", "text": "alex\nHarlow Legal\n{date}" },
//       { "keyword": ";re",  "text": "Re: {clipboard}{cursor}" }
//     ],
//     "commands": [
//       { "title": "Open the Northwind board", "keywords": ["board"], "run": { "open": "https://example.com/board" } },
//       { "title": "Deploy kit", "keywords": ["ship"], "run": { "shell": "make deploy", "confirm": true } }
//     ]
//   }
//
// This file is the model only: parse, validate, match, expand. Pasting a snippet and running a
// command belong to the app, which owns the clipboard, the front app and the confirm UI.
//
// Validation keeps every good entry and says what is wrong with each bad one, in words the
// Capsule can show as they are ("snippet 2: keyword is empty"), so one typo does not empty the
// list. A shell command always asks before it runs: `confirm` may be left out (it means true), and
// `"confirm": false` is refused, because a command in the list must never run from one keypress.
// Placeholders: {date} (2026-09-27), {time} (14:05), {clipboard} (injected by the app, which reads
// the clipboard only when the snippet uses it), {cursor} (where the caret goes after pasting).

import Foundation

public struct Snippet: Sendable, Equatable {
    public var keyword: String
    public var title: String?
    public var text: String
    public init(keyword: String, title: String? = nil, text: String) { self.keyword = keyword; self.title = title; self.text = text }
    /// Whether expanding needs the clipboard, so the app reads it only then.
    public var usesClipboard: Bool { text.contains("{clipboard}") }
}

public struct UserCommand: Sendable, Equatable {
    public enum Run: Sendable, Equatable { case open(URL), shell(String) }
    public var title: String
    public var keywords: [String]
    public var run: Run
    /// The line the Capsule asks before running, for shell commands.
    public var confirm: String? {
        if case .shell(let s) = run { return "Run \u{201C}\(s)\u{201D}?" }
        return nil
    }
}

public struct SnippetExpansion: Sendable, Equatable {
    public var text: String
    /// Where the caret goes, in UTF-16 units from the start (what NSText and AX count in).
    public var cursor: Int?
}

public struct UserSnippets: Sendable {
    public var snippets: [Snippet] = []
    public var commands: [UserCommand] = []
    /// What was wrong, one line per bad entry. Empty when the file is fine or absent.
    public var problems: [String] = []

    public init(snippets: [Snippet] = [], commands: [UserCommand] = [], problems: [String] = []) {
        self.snippets = snippets; self.commands = commands; self.problems = problems
    }

    /// Reads the file at `path`. A missing file is an empty list, not a problem.
    public static func load(path: String) -> UserSnippets {
        guard let data = FileManager.default.contents(atPath: path) else { return UserSnippets() }
        return parse(data)
    }

    public static func parse(_ data: Data) -> UserSnippets {
        var out = UserSnippets()
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            out.problems.append("The file is not valid JSON with snippets and commands.")
            return out
        }
        func str(_ v: Any?) -> String? { (v as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }
        var seen = Set<String>()
        for (i, raw) in ((root["snippets"] as? [Any]) ?? []).enumerated() {
            let n = "snippet \(i + 1)"
            guard let o = raw as? [String: Any] else { out.problems.append("\(n): not an object"); continue }
            guard let kw = str(o["keyword"]), !kw.isEmpty else { out.problems.append("\(n): keyword is empty"); continue }
            if kw.contains(where: \.isWhitespace) { out.problems.append("\(n): keyword \u{201C}\(kw)\u{201D} has a space"); continue }
            guard let text = o["text"] as? String, !text.isEmpty else { out.problems.append("\(n): text is empty"); continue }
            if !seen.insert(kw.lowercased()).inserted { out.problems.append("\(n): keyword \u{201C}\(kw)\u{201D} is used twice"); continue }
            let title = str(o["title"]).flatMap { $0.isEmpty ? nil : $0 }
            out.snippets.append(Snippet(keyword: kw, title: title, text: text))
        }
        if root["snippets"] != nil && !(root["snippets"] is [Any]) { out.problems.append("snippets: not a list") }
        for (i, raw) in ((root["commands"] as? [Any]) ?? []).enumerated() {
            let n = "command \(i + 1)"
            guard let o = raw as? [String: Any] else { out.problems.append("\(n): not an object"); continue }
            guard let title = str(o["title"]), !title.isEmpty else { out.problems.append("\(n): title is empty"); continue }
            let kws = ((o["keywords"] as? [Any]) ?? []).compactMap { str($0) }.filter { !$0.isEmpty }
            guard let run = o["run"] as? [String: Any] else { out.problems.append("\(n): run is missing"); continue }
            let open = str(run["open"]), shell = str(run["shell"])
            if (open == nil) == (shell == nil) { out.problems.append("\(n): run needs one of open or shell"); continue }
            if let open {
                guard let url = URL(string: open), let scheme = url.scheme?.lowercased(), !scheme.isEmpty,
                      !["javascript", "data"].contains(scheme),
                      !(scheme == "http" || scheme == "https") || url.host?.isEmpty == false else {
                    out.problems.append("\(n): \u{201C}\(open)\u{201D} is not a link to open"); continue
                }
                out.commands.append(UserCommand(title: title, keywords: kws, run: .open(url)))
            } else if let shell {
                if shell.isEmpty { out.problems.append("\(n): shell is empty"); continue }
                if let c = run["confirm"], (c as? Bool) != true {
                    out.problems.append("\(n): shell commands always confirm; set confirm to true"); continue
                }
                out.commands.append(UserCommand(title: title, keywords: kws, run: .shell(shell)))
            }
        }
        if root["commands"] != nil && !(root["commands"] is [Any]) { out.problems.append("commands: not a list") }
        return out
    }

    /// Snippets for this query, best first. A typed keyword is an exact hit.
    public func matchSnippets(_ query: String) -> [(snippet: Snippet, score: Double)] {
        let q = query.trimmingCharacters(in: .whitespaces)
        if q.isEmpty { return [] }
        return snippets.compactMap { s -> (Snippet, Double)? in
            if s.keyword.caseInsensitiveCompare(q) == .orderedSame { return (s, 1) }
            let sc = Match.score(q, s.keyword, synonyms: s.title.map { [$0] } ?? [])
            return sc >= 0.5 ? (s, sc) : nil
        }.sorted { $0.1 > $1.1 }
    }

    /// User commands for this query, best first.
    public func matchCommands(_ query: String) -> [(command: UserCommand, score: Double)] {
        let q = query.trimmingCharacters(in: .whitespaces)
        if q.isEmpty { return [] }
        return commands.compactMap { c -> (UserCommand, Double)? in
            let sc = Match.score(q, c.title, synonyms: c.keywords)
            return sc >= 0.5 ? (c, sc) : nil
        }.sorted { $0.1 > $1.1 }
    }

    /// The snippet's text with its placeholders filled. Unknown {words} stay as typed.
    public static func expand(_ text: String, now: Date = Date(), timeZone: TimeZone = .current, clipboard: String? = nil) -> SnippetExpansion {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        let c = cal.dateComponents([.year, .month, .day, .hour, .minute], from: now)
        let values: [String: String] = [
            "date": String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0),
            "time": String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0),
            "clipboard": clipboard ?? "",
        ]
        var out = "", cursor: Int?
        var rest = Substring(text)
        while let open = rest.firstIndex(of: "{") {
            out += rest[..<open]
            let after = rest[rest.index(after: open)...]
            if let close = after.firstIndex(of: "}") {
                let name = String(after[..<close])
                if name == "cursor" {
                    if cursor == nil { cursor = out.utf16.count }
                    rest = after[after.index(after: close)...]; continue
                }
                if let v = values[name] { out += v; rest = after[after.index(after: close)...]; continue }
            }
            out += "{"
            rest = after
        }
        out += rest
        return SnippetExpansion(text: out, cursor: cursor)
    }
}

/// A snippet row. The app pastes the expansion into the front app on Enter.
public func snippetResult(_ s: Snippet, score: Double) -> ResultItem {
    let firstLine = s.text.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? ""
    let preview = firstLine.count > 60 ? String(firstLine.prefix(59)) + "\u{2026}" : firstLine
    return ResultItem(id: "snippet:\(s.keyword)", kind: "snippet", title: s.title ?? s.keyword,
                      subtitle: s.title == nil ? preview : "\(s.keyword) · \(preview)", icon: .symbol("text.quote"),
                      section: .snippets, score: score, copyText: s.text, payload: ["keyword": s.keyword])
}

/// A user command row. The app runs it; a shell command asks with `payload["confirm"]` first.
public func userCommandResult(_ c: UserCommand, score: Double) -> ResultItem {
    var payload: [String: String] = [:]
    let subtitle: String, symbol: String
    switch c.run {
    case .open(let url): payload["run"] = "open"; payload["target"] = url.absoluteString; subtitle = url.absoluteString; symbol = "arrow.up.right.square"
    case .shell(let s): payload["run"] = "shell"; payload["target"] = s; subtitle = s; symbol = "terminal"
    }
    if let confirm = c.confirm { payload["confirm"] = confirm }
    return ResultItem(id: "user-command:\(c.title)", kind: "user-command", title: c.title, subtitle: subtitle,
                      icon: .symbol(symbol), section: .commands, score: score, payload: payload)
}
