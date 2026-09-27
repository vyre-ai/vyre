// DictionaryProvider: "define serendipity", "serendipity meaning", "what does x mean" answered
// from the system dictionary (DCSCopyTextDefinition), on this Mac, as one Answer row.
//
// The system dictionary's text opens with the headword, its syllables and pronunciation between
// bars, and a part of speech; the gist shown is what follows, up to the end of the first sense
// (helper.js firstSentence). Enter opens the full entry in Dictionary (dict://word); ⌘C copies
// the gist. A word the dictionary does not know shows nothing.

import CoreServices
import Foundation

public final class DictionaryProvider: ResultProvider, @unchecked Sendable {
    public let id = "dictionary"
    public let speed = Speed.full
    let lookup: @Sendable (String) -> String?

    public init(lookup: @escaping @Sendable (String) -> String? = DictionaryProvider.systemDefinition) { self.lookup = lookup }

    static let define = try! NSRegularExpression(pattern: #"^(?:define|definition of|meaning of|what does)\s+([a-z][a-z' -]{1,40}?)(?:\s+mean)?\s*\??$"#, options: .caseInsensitive)
    static let meaning = try! NSRegularExpression(pattern: #"^([a-z][a-z'-]{1,40})\s+(?:meaning|definition|define)\s*$"#, options: .caseInsensitive)
    static let partOfSpeech = try! NSRegularExpression(pattern: #"^(noun|verb|adjective|adverb|pronoun|preposition|conjunction|exclamation|abbreviation|prefix|suffix|determiner)\b\s*"#, options: .caseInsensitive)

    /// A word to look up, when the box asks for one.
    public static func word(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let g = FileTaste.groups(define, t) ?? FileTaste.groups(meaning, t)
        return g.map { $0[1].trimmingCharacters(in: .whitespaces) }
    }

    /// The gist of a dictionary entry: after the last pronunciation bar in the first 160
    /// characters, without the part of speech or a sense number, up to the first : . or ;.
    public static func firstSentence(_ text: String) -> String {
        var t = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        let chars = Array(t)
        if let bar = chars.prefix(161).lastIndex(of: "|") { t = String(chars[(bar + 1)...]).trimmingCharacters(in: .whitespaces) }
        t = partOfSpeech.stringByReplacingMatches(in: t, range: NSRange(t.startIndex..., in: t), withTemplate: "")
        if let r = t.range(of: #"^\d+\s+"#, options: .regularExpression) { t.removeSubrange(r) }
        if let r = t.range(of: #"[:.;](\s|$)"#, options: .regularExpression) { t = String(t[..<r.lowerBound]) }
        return t.trimmingCharacters(in: .whitespaces)
    }

    /// The system dictionary's entry, or nil. Reads a local dictionary; asks no permission.
    public static let systemDefinition: @Sendable (String) -> String? = { w in
        let ns = w as NSString
        guard ns.length > 0, let def = DCSCopyTextDefinition(nil, w as CFString, CFRange(location: 0, length: ns.length))?.takeRetainedValue() else { return nil }
        return def as String
    }

    public func results(for query: Query) async -> [ResultItem] {
        guard let w = Self.word(query.text), let def = lookup(w) else { return [] }
        let gist = Self.firstSentence(def)
        if gist.isEmpty { return [] }
        let url = URL(string: "dict://" + (w.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? w))
        return [ResultItem(id: "define:" + w, kind: "define", title: w, subtitle: gist, icon: .symbol("character.book.closed", .recall),
                           section: .answer, score: 1.5, actions: [
                            ResultAction(id: "open", title: "Open in Dictionary", symbol: "book", shortcut: KeyShortcut("return")) { _, _ in
                                guard let url else { return .failed("No entry to open.") }
                                return await Launch.open(url)
                            },
                           ], copyText: gist)]
    }
}
