// TagPicker: "#" in the box names anything in your work: a saved login, a file, an artifact, a repo or
// a pull request. Pure parts here (Host/TagMode.swift does the asking and the rows):
//   - finding the "#word" being typed at the end of the box,
//   - writing the picked tag into the words (#Name, or #"Name with spaces"),
//   - reading the platform's `mentions.search` answer in any of its shapes,
//   - which picked tags are still in the words, for the send.
// Names only ever: a search never returns a value.

import Foundation

public struct TagHit: Equatable, Sendable {
    public var key: String { "\(kind):\(id)" }
    public var kind: String
    public var id: String
    public var name: String
    public var hint: String?
    public var icon: String?
    public var label: String
}

public enum TagToken {
    /// The "#" token at the end of `text`: where it starts (the "#"), and what has been typed after it.
    /// A "#" counts only at the start, after whitespace, or after "(", so "issue#12" and "C#" are words.
    /// A quoted name being typed (`#"Quarterly rep`) is one token with its spaces.
    public static func trailing(in text: String) -> (start: String.Index, partial: String)? {
        let chars = Array(text)
        guard !chars.isEmpty else { return nil }
        // A quote opened after a "#" and not closed: the token runs from that "#".
        if let q = text.range(of: "#\"", options: .backwards), text[q.upperBound...].contains("\"") == false, isBoundary(text, q.lowerBound) {
            return (q.lowerBound, String(text[q.upperBound...]))
        }
        var i = chars.count - 1
        while i >= 0, !chars[i].isWhitespace, chars[i] != "#" { i -= 1 }
        guard i >= 0, chars[i] == "#" else { return nil }
        let start = text.index(text.startIndex, offsetBy: i)
        guard isBoundary(text, start) else { return nil }
        let partial = String(chars[(i + 1)...])
        if partial.contains("#") || partial.contains("\"") { return nil }
        return (start, partial)
    }

    private static func isBoundary(_ text: String, _ at: String.Index) -> Bool {
        if at == text.startIndex { return true }
        let prev = text[text.index(before: at)]
        return prev.isWhitespace || prev == "("
    }

    /// `text` with the token being typed replaced by the picked tag and a space after it.
    public static func insert(_ name: String, into text: String, replacing start: String.Index) -> String {
        String(text[..<start]) + token(name) + " "
    }

    /// #Name, or #"Name with spaces".
    public static func token(_ name: String) -> String {
        let clean = name.replacingOccurrences(of: "\"", with: "")
        return clean.contains(where: \.isWhitespace) ? "#\"\(clean)\"" : "#\(clean)"
    }

    /// Which of `picked` are still written in `text`, in the order they were picked.
    public static func stillIn(_ text: String, _ picked: [TagHit]) -> [TagHit] {
        picked.filter { text.contains(token($0.name)) }
    }
}

public enum TagResults {
    /// The hits in a `mentions.search` answer: a flat list, `results`, `items`, or `groups` of them, each
    /// {kind, id, name, hint?, icon?}. Order is kept; groups come in the order given. At most `limit`.
    public static func parse(_ data: Any?, limit: Int = 40) -> [TagHit] {
        var out: [TagHit] = []
        func take(_ rows: Any?, kind: String?, label: String?) {
            for r in (rows as? [[String: Any]]) ?? [] {
                guard let id = ViewText.string(r["id"]), let name = ViewText.string(r["name"]) else { continue }
                guard let k = ViewText.string(r["kind"]) ?? kind else { continue }
                out.append(TagHit(kind: k, id: id, name: name, hint: ViewText.string(r["hint"]), icon: ViewText.string(r["icon"]) ?? nil,
                                  label: ViewText.string(r["label"]) ?? label ?? k.capitalized))
            }
        }
        if let groups = (data as? [String: Any])?["groups"] as? [[String: Any]] {
            for g in groups {
                let kind = ViewText.string(g["kind"])
                take(g["items"] ?? g["results"], kind: kind, label: ViewText.string(g["label"]))
            }
        } else if let o = data as? [String: Any] {
            take(o["results"] ?? o["items"], kind: nil, label: nil)
        } else {
            take(data, kind: nil, label: nil)
        }
        return Array(out.prefix(limit))
    }

    /// A line icon for a kind, from the set the Capsule already has.
    public static func symbol(kind: String, icon: String?) -> String {
        switch kind {
        case "vault": return "key"
        case "drive", "file": return "doc"
        case "artifact": return "square.stack"
        case "github": return "arrow.triangle.branch"
        case "project": return "folder"
        case "session": return "bubble.left"
        case "teammate": return "person"
        default: return icon.flatMap { ViewIcon.spec($0) }.flatMap { if case .symbol(let n, _) = $0 { return n }; return nil } ?? "number"
        }
    }
}
