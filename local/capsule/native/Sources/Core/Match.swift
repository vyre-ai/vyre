// Match: how well a query names a label, 0..1, the same tiers as local.js match() so rows from
// every provider rank on one scale: exact 1, prefix 0.9, word-prefix or initials 0.8, substring
// 0.5, in-order letters 0.3, else 0. A query under three letters matches only by prefix, word
// start or initials. A synonym counts slightly less than the label itself, so
// "Wi-Fi" typed out still beats a pane that only lists "wifi" as a synonym.

import Foundation

public enum Match {
    /// Lowercased with accents dropped: "Café" matches "cafe".
    public static func fold(_ s: String) -> String {
        s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil).lowercased()
    }

    static func compact(_ s: String) -> String { String(s.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) && $0.isASCII }) }

    /// Words of a label, split on punctuation, spaces and camelCase: "VisualStudio Code" ->
    /// visual, studio, code.
    public static func words(_ label: String) -> [String] {
        var out: [String] = [], cur = ""
        let chars = Array(label.folding(options: .diacriticInsensitive, locale: nil))
        for (i, c) in chars.enumerated() {
            let isAlnum = c.isASCII && (c.isLetter || c.isNumber)
            if !isAlnum { if !cur.isEmpty { out.append(cur) }; cur = ""; continue }
            if c.isUppercase, !cur.isEmpty {
                let prev = chars[i - 1]
                let nextLower = i + 1 < chars.count && chars[i + 1].isLowercase
                if prev.isLowercase || prev.isNumber || (prev.isUppercase && nextLower) { out.append(cur); cur = "" }
            }
            cur.append(Character(c.lowercased()))
        }
        if !cur.isEmpty { out.append(cur) }
        return out
    }

    static func isSubsequence(_ q: String, _ s: String) -> Bool {
        var qi = q.startIndex
        for ch in s where qi < q.endIndex { if ch == q[qi] { qi = q.index(after: qi) } }
        return qi == q.endIndex
    }

    static func score1(_ q: String, _ label: String) -> Double {
        let l = fold(label)
        if l.isEmpty { return 0 }
        let qc = compact(q), lc = compact(l)
        if l == q || (!qc.isEmpty && lc == qc) { return 1 }
        if l.hasPrefix(q) || (!qc.isEmpty && lc.hasPrefix(qc)) { return 0.9 }
        let ws = words(label)
        if ws.contains(where: { $0.hasPrefix(qc.isEmpty ? q : qc) }) { return 0.8 }
        if qc.count >= 2, ws.count >= 2, String(ws.compactMap(\.first)).hasPrefix(qc) { return 0.8 }
        // Under three letters, only a prefix, a word's start or initials count, as in Spotlight:
        // "sa" is Safari, never "Notes" with an s somewhere in it.
        if q.count < 3 { return 0 }
        if l.contains(q) || (qc.count >= 3 && lc.contains(qc)) { return 0.5 }
        if qc.count >= 3, isSubsequence(qc, lc) { return 0.3 }
        return 0
    }

    public static func score(_ query: String, _ label: String, synonyms: [String] = []) -> Double {
        let q = fold(query).trimmingCharacters(in: .whitespaces)
        if q.isEmpty { return 0 }
        var best = score1(q, label)
        if best == 1 { return 1 }
        for s in synonyms { best = max(best, score1(q, s) * 0.95) }
        return best
    }
}
