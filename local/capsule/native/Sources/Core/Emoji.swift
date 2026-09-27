// Emoji: "emoji heart", "smile emoji", ":thumbs" find an emoji by name to copy or paste.
//
// No data file ships with the Capsule: the table is built on first use from the Unicode scalar
// properties Swift already carries (isEmoji, isEmojiPresentation, name), so it follows the OS's
// Unicode version for free and costs nothing until someone asks. It is small (about 1,400 rows of
// a scalar and a lowercased name) and `release()` drops it when the Capsule cools, to be rebuilt
// on the next emoji query.
//
// What it covers: single-scalar emoji, including the ones drawn as text by default (they get
// U+FE0F so they draw as emoji). Not covered: flags, keycaps, skin tones and ZWJ sequences
// (families, professions), which have no scalar name to search by.
//
// A query is only an emoji search when it says so ("emoji" before or after, or a leading colon),
// so typing "heart" still finds the Heart app or a note, not a list of hearts.

import Foundation

public struct EmojiEntry: Sendable, Equatable {
    public var emoji: String
    /// Lowercased Unicode name: "thumbs up sign".
    public var name: String
    public var scalar: UInt32
}

public final class EmojiIndex: @unchecked Sendable {
    public let entries: [EmojiEntry]
    /// Words of each entry's name plus its aliases, parallel to entries.
    let words: [[String]]
    /// Alias words alone, only for the few entries that have them.
    let aliasWords: [UInt32: [String]]

    /// Names people type that the Unicode names do not use.
    static let aliases: [UInt32: String] = [
        0x1F602: "lol laugh laughing", 0x1F923: "rofl lol", 0x2764: "love red heart", 0x1F44D: "like yes approve +1",
        0x1F44E: "dislike no -1", 0x1F389: "party tada celebrate", 0x1F525: "lit hot", 0x1F64F: "thanks please pray",
        0x1F44B: "wave hello hi bye", 0x1F914: "hmm think", 0x1F62D: "sob cry", 0x1F60A: "happy blush", 0x1F622: "sad",
        0x2705: "done check tick yes", 0x274C: "no cross wrong", 0x1F680: "launch ship", 0x1F440: "look see", 0x1F4AF: "hundred",
        0x1F642: "smile", 0x1F600: "smile grin happy", 0x1F44C: "ok okay perfect", 0x1F937: "shrug", 0x1F926: "facepalm",
    ]

    init() {
        var out: [EmojiEntry] = [], ws: [[String]] = []
        func scan(_ r: ClosedRange<UInt32>) {
            for v in r {
                guard let s = Unicode.Scalar(v) else { continue }
                let p = s.properties
                guard p.isEmoji, !p.isEmojiModifier, !(0x1F1E6...0x1F1FF).contains(v), let n = p.name else { continue }
                let e = p.isEmojiPresentation ? String(s) : String(s) + "\u{FE0F}"
                let name = n.lowercased()
                out.append(EmojiEntry(emoji: e, name: name, scalar: v))
                ws.append((name + " " + (Self.aliases[v] ?? "")).split(separator: " ").map(String.init))
            }
        }
        scan(0x00A9...0x00AE)
        scan(0x203C...0x3299)
        scan(0x1F000...0x1FAFF)
        entries = out
        words = ws
        aliasWords = Self.aliases.mapValues { $0.split(separator: " ").map(String.init) }
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var cached: EmojiIndex?

    /// The table, built on first use.
    public static var shared: EmojiIndex {
        lock.lock(); defer { lock.unlock() }
        if let c = cached { return c }
        let c = EmojiIndex()
        cached = c
        return c
    }

    public static var isBuilt: Bool { lock.lock(); defer { lock.unlock() }; return cached != nil }

    /// Drop the table (the Capsule cooled); the next emoji query builds it again.
    public static func release() { lock.lock(); cached = nil; lock.unlock() }

    /// 1 for the whole name, 0.95 for an alias ("lol" is tears of joy, not lollipop), 0.9 for the
    /// name's start, 0.8 when every typed word starts a word of the name or an alias, 0.5 for a
    /// word containing each typed word, else 0.
    func score(_ i: Int, _ term: String, _ termWords: [String]) -> Double {
        let name = entries[i].name
        if name == term { return 1 }
        if let a = aliasWords[entries[i].scalar], a.contains(where: { $0 == term }) { return 0.95 }
        if name.hasPrefix(term) { return 0.9 }
        let w = words[i]
        if termWords.allSatisfy({ t in w.contains { $0.hasPrefix(t) } }) { return 0.8 }
        if termWords.allSatisfy({ t in w.contains { $0.contains(t) } }) { return 0.5 }
        return 0
    }

    public func search(_ term: String, limit: Int = 8) -> [(entry: EmojiEntry, score: Double)] {
        let t = Match.fold(term).trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "_", with: " ")
        if t.isEmpty { return [] }
        let tw = t.split(separator: " ").map(String.init)
        var hits: [(Int, Double)] = []
        for i in entries.indices { let s = score(i, t, tw); if s > 0 { hits.append((i, s)) } }
        hits.sort { a, b in
            if a.1 != b.1 { return a.1 > b.1 }
            let la = entries[a.0].name.count, lb = entries[b.0].name.count
            return la != lb ? la < lb : entries[a.0].scalar < entries[b.0].scalar
        }
        return hits.prefix(limit).map { (entries[$0.0], $0.1) }
    }
}

public enum Emoji {
    /// The search term when the query asks for emoji: "emoji heart", "heart emoji", ":thumbs:".
    public static func term(_ text: String) -> String? {
        let q = Query(text).normalized
        var t: String?
        if q.hasPrefix(":") {
            var s = String(q.dropFirst())
            if s.hasSuffix(":") { s.removeLast() }
            if !s.contains(" "), s.count >= 2 { t = s }
        } else if q.hasPrefix("emoji ") { t = String(q.dropFirst(6)) }
        else if q.hasSuffix(" emoji") { t = String(q.dropLast(6)) }
        guard let t, !t.trimmingCharacters(in: .whitespaces).isEmpty, t.count <= 40 else { return nil }
        return t
    }

    public static func search(_ text: String, limit: Int = 8) -> [EmojiEntry] {
        guard let t = term(text) else { return [] }
        return EmojiIndex.shared.search(t, limit: limit).map(\.entry)
    }

    /// "THUMBS UP SIGN" -> "Thumbs up sign".
    static func title(_ name: String) -> String { name.prefix(1).uppercased() + name.dropFirst() }
}

/// Emoji rows. Enter copies (or pastes, the app decides) the emoji itself.
public func emojiResults(_ q: Query, limit: Int = 8) -> [ResultItem] {
    guard let t = Emoji.term(q.text) else { return [] }
    return EmojiIndex.shared.search(t, limit: limit).map { hit in
        ResultItem(id: "emoji:\(String(hit.entry.scalar, radix: 16))", kind: "emoji", title: Emoji.title(hit.entry.name),
                   subtitle: "Emoji", icon: .glyph(hit.entry.emoji), section: .answer, score: hit.score,
                   copyText: hit.entry.emoji, payload: ["emoji": hit.entry.emoji])
    }
}
