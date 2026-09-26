// Said: which of the user's past turns answer what they just asked, and the memory box's lines.
// Ported from local/capsule/lib/said.js and bridge.js memoItems/memoLines/quickAppend
// (capsule-now rules 1, 2 and 7). No model runs for any of it.
//
// recall.search ranks by words, so for "which car do I own" it finds the question itself first.
// What answers it is a statement the user made about themselves ("I own a blue Volvo XC40"). So:
//   - out: the Capsule's own ask threads, any turn that repeats the question
//   - down: questions, and Claude's words
//   - up: the user's first-person statements that share a word with the question
//   - at most maxSaid

import Foundation

/// One recall.search row, as much of it as the ranking reads.
public struct SaidHit: Sendable, Equatable {
    public var session: String
    public var seq: Int?
    public var role: String
    public var text: String
    public var name: String
    public var cwd: String?
    public var ts: Double?
    public init(session: String, seq: Int? = nil, role: String, text: String, name: String = "", cwd: String? = nil, ts: Double? = nil) {
        self.session = session; self.seq = seq; self.role = role; self.text = text; self.name = name; self.cwd = cwd; self.ts = ts
    }
    public init(_ d: [String: Any]) {
        session = VJ.s(d["session"]); seq = VJ.int(d["seq"]); role = VJ.s(d["role"])
        text = VJ.nonEmpty(d["text"]) ?? VJ.s(d["snippet"])
        name = VJ.nonEmpty(d["name"]) ?? VJ.s(d["title"])
        cwd = VJ.str(d["cwd"]); ts = VJ.num(d["ts"])
    }
}

public enum Said {
    public static let maxSaid = 2

    static func fold(_ s: String) -> String {
        var t = s.lowercased().replacingOccurrences(of: "«", with: "").replacingOccurrences(of: "»", with: "")
        t = VyRx.rx("[^a-z0-9' ]+", caseless: false).map { $0.stringByReplacingMatches(in: t, range: NSRange(t.startIndex..., in: t), withTemplate: " ") } ?? t
        return t.split(separator: " ").joined(separator: " ")
    }

    /// A turn that asks rather than tells.
    public static func isQuestion(_ t: String) -> Bool {
        VyRx.test("\\?\\s*$", t.trimmingCharacters(in: .whitespacesAndNewlines), caseless: false)
            || VyRx.test("^(who|what|which|where|when|why|how|do|does|did|is|are|was|were|can|could|should|would|will|have|has)\\b", fold(t), caseless: false)
    }

    static let first = "(^|[^a-z'])(i|i'm|i've|i'd|my|mine|we|our)([^a-z']|$)"

    static func sharesWord(_ t: String, _ qw: [String]) -> Bool { let tw = Route.words(t); return qw.contains { tw.contains($0) } }

    /// Hits worth showing for `query`, best first, at most maxSaid. `scratch` is the Capsule's ask folder.
    public static func rank(_ hits: [SaidHit], query: String, scratch: String? = nil) -> [SaidHit] {
        let q = fold(query)
        let qw = Route.words(query)
        func own(_ h: SaidHit) -> Bool {
            h.name.hasPrefix("Capsule: ") || (scratch != nil && h.cwd.map { $0.hasPrefix(scratch!) } == true)
        }
        func repeats(_ h: SaidHit) -> Bool {
            let t = fold(h.text)
            if q.split(separator: " ").count >= 3 && t.contains(q) { return true }
            let tw = Route.words(h.text)
            if qw.isEmpty || tw.isEmpty { return false }
            let shared = qw.filter { tw.contains($0) }.count
            return Double(shared) / Double(qw.count) >= 0.8 && tw.count <= qw.count + 2
        }
        return hits.enumerated()
            .filter { !own($0.element) && !repeats($0.element) }
            .map { (i, h) -> (SaidHit, Int) in
                let user = h.role != "assistant"
                var s = -i
                if isQuestion(h.text) { s -= 20 }
                if !user { s -= 5 }
                if user && VyRx.test(first, h.text) && !isQuestion(h.text) && sharesWord(h.text, qw) { s += 20 }
                return (h, s)
            }
            .sorted { $0.1 > $1.1 }
            .prefix(maxSaid).map(\.0)
    }

    static let swaps: [(String, String, Bool)] = [
        ("\\bI am\\b", "you are", false), ("\\bI'm\\b", "you're", false), ("\\bI've\\b", "you've", false), ("\\bI'd\\b", "you'd", false),
        ("\\bI was\\b", "you were", false), ("\\bI\\b", "you", false), ("\\bmyself\\b", "yourself", true), ("\\bmy\\b", "your", true),
        ("\\bmine\\b", "yours", true), ("\\bme\\b", "you", false),
    ]

    /// The one-line answer from a hit, or nil: only the user's own clear statement about themselves
    /// that shares a word with the question ("I own a blue Volvo XC40" -> "You own a blue Volvo XC40.").
    public static func yourAnswer(_ hit: SaidHit?, query: String) -> String? {
        guard let hit, hit.role != "assistant" else { return nil }
        let qw = Route.words(query)
        let text = hit.text.replacingOccurrences(of: "«", with: "").replacingOccurrences(of: "»", with: "")
        guard let splitter = VyRx.rx("(?<=[.!?])\\s+|\\n+", caseless: false) else { return nil }
        let marked = splitter.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "\u{1}")
        let sentences = marked.split(separator: "\u{1}").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let sentence = sentences.first(where: { VyRx.test("^(i|i'm|i've|my)\\b", $0) && !isQuestion($0) && sharesWord($0, qw) }) else { return nil }
        var out = sentence
        while let last = out.last, last == "." || last == "!" || last.isWhitespace { out.removeLast() }
        for (p, to, caseless) in swaps {
            if let r = VyRx.rx(p, caseless: caseless) { out = r.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: to) }
        }
        out = out.prefix(1).uppercased() + out.dropFirst()
        if out.count > 120 {
            var cut = String(out.prefix(119))
            if let sp = cut.range(of: "\\s+\\S*$", options: .regularExpression) { cut.removeSubrange(sp) }
            return cut + "…"
        }
        return out + "."
    }
}

// MARK: the memory box

/// What memory said about the words in the box: the distilled fact, and up to three sources.
public struct MemoryAnswer: Sendable, Equatable {
    public enum Kind: String, Sendable { case memory, said }
    public var text: String
    public var answer: String?
    public var answerKind: Kind?
    public var answerAge: String?
    public var confidence: Double?
    public var more: [String] = []
    public var sources: [MemorySource]
    public var ms: Double = 0
    public var error: String?
    public init(text: String, answer: String? = nil, answerKind: Kind? = nil, answerAge: String? = nil, confidence: Double? = nil,
                more: [String] = [], sources: [MemorySource] = [], ms: Double = 0, error: String? = nil) {
        self.text = text; self.answer = answer; self.answerKind = answerKind; self.answerAge = answerAge; self.confidence = confidence
        self.more = more; self.sources = sources; self.ms = ms; self.error = error
    }
    public var isEmpty: Bool { answer == nil && sources.isEmpty }
    /// "From memory" with a fact, "From your sessions" with only quotes.
    public var label: String { answerKind == .memory || sources.contains { $0.kind == .fact } ? "From memory" : "From your sessions" }
}

public struct MemorySource: Sendable, Equatable {
    public enum Kind: String, Sendable { case fact, quote }
    public var kind: Kind
    /// "user" or "assistant", for a quote.
    public var role: String
    public var session: String
    public var seq: Int?
    public var name: String
    public var quote: String
    public var age: String
    public var confidence: Double?
}

/// One line of the memory box, and of what a quick question is told.
public struct MemoItem: Sendable, Equatable, Identifiable {
    public enum Kind: String, Sendable { case fact, quote }
    public var kind: Kind
    public var text: String
    public var age: String
    /// "You" or "Claude", for a quote.
    public var who: String?
    public var confidence: Double?
    /// A line made from the user's own words: shown, never sent (the quote under it is).
    public var said: Bool
    public var source: MemorySource?
    public var id: String { "\(kind.rawValue):\(source?.session ?? ""):\(text)" }
}

public enum Memo {
    public static let quickAppend = "Answer briefly, in markdown. You have no tools here; if the question needs the user's files or accounts, say so in one line."

    /// "2 weeks ago", "just now", or "".
    public static func ago(_ age: String) -> String { age.isEmpty ? "" : age == "now" ? "just now" : "\(age) ago" }

    /// What the memory box shows, line by line: the fact first, then each source on screen.
    public static func items(_ m: MemoryAnswer?) -> [MemoItem] {
        guard let m else { return [] }
        var out: [MemoItem] = []
        let srcs = Array(m.sources.prefix(3))
        if let a = m.answer {
            let said = m.answerKind == .said
            out.append(MemoItem(kind: .fact, text: a, age: m.answerAge ?? "", who: nil, confidence: m.confidence, said: said,
                                source: said ? srcs.first { $0.kind == .quote } : srcs.first { $0.kind != .quote && $0.quote == a }))
        }
        for x in srcs {
            if x.kind == .quote {
                out.append(MemoItem(kind: .quote, text: x.quote, age: x.age, who: x.role == "assistant" ? "Claude" : "You", confidence: nil, said: false, source: x))
            } else if !x.quote.isEmpty && x.quote != m.answer {
                out.append(MemoItem(kind: .fact, text: x.quote, age: x.age, who: nil, confidence: x.confidence, said: false, source: x))
            }
        }
        return out
    }

    /// The memory items as the model reads them, one line each.
    public static func lines(_ m: MemoryAnswer?) -> [String] {
        items(m).filter { !$0.said }.map { x in
            x.kind == .quote
                ? "\(x.who == "Claude" ? "Claude said" : "The user said")\(x.age.isEmpty ? "" : ", \(ago(x.age))"): \"\(x.text)\""
                : "\(x.text)\(x.age.isEmpty ? "" : " (noted \(ago(x.age)))")"
        }
    }

    /// The system-prompt append for a quick question: only the lines on screen, nothing else.
    public static func append(_ m: MemoryAnswer?) -> String {
        let l = lines(m)
        if l.isEmpty { return quickAppend }
        return "\(quickAppend)\n\nWhat the user's own notes say:\n\(l.map { "- \($0)" }.joined(separator: "\n"))\n\n" +
            "If these answer the question, answer from them and say when the user said it, like \"a blue Volvo XC40 (you said so 2 weeks ago)\". They may be old or partial; say so if it matters."
    }

    /// memory.relevant and recall.search answers, folded into what the box shows (bridge.js recall).
    public static func fold(text: String, facts: [[String: Any]], hits: [[String: Any]], scratch: String?, now: Double = vyNowMs()) -> MemoryAnswer {
        let asked = Route.words(text)
        func score(_ x: [String: Any]) -> Double { VJ.num(x["score"]) ?? VJ.num(x["confidence"]) ?? 0 }
        let f = facts.filter { score($0) >= 0.5 }
            .map { x -> ([String: Any], Double) in
                let matched = Route.words(VJ.str(x["matched"]))
                return (x, score(x) + 0.5 * Double(Route.words(VJ.s(x["text"])).filter { asked.contains($0) && !matched.contains($0) }.count))
            }
            .sorted { $0.1 > $1.1 }.map(\.0)
        let h = Said.rank(hits.map(SaidHit.init), query: text, scratch: scratch)
        let said = f.first == nil ? Said.yourAnswer(h.first, query: text) : nil
        func conf(_ x: [String: Any]) -> Double? { Bridge.confidenceOf(x) }
        var sources: [MemorySource] = f.compactMap { x in
            guard let ref = x["ref"] as? [String: Any] else { return nil }
            return MemorySource(kind: .fact, role: "user", session: VJ.s(ref["session"]), seq: VJ.int(ref["seq"]),
                                name: VJ.nonEmpty(ref["name"]) ?? VJ.s(x["source"]), quote: VJ.s(x["text"]), age: VJ.s(x["age"]), confidence: conf(x))
        }
        sources += h.map { x in
            MemorySource(kind: .quote, role: x.role == "assistant" ? "assistant" : "user", session: x.session, seq: x.seq,
                         name: x.name.isEmpty ? String(x.session.prefix(8)) : x.name,
                         quote: x.text.replacingOccurrences(of: "«", with: "").replacingOccurrences(of: "»", with: ""),
                         age: Route.age(x.ts, now: now), confidence: nil)
        }
        var seen = Set<String>()
        sources = sources.filter { seen.insert($0.session).inserted }
        let top = f.first
        var answerAge: String?
        if let top { answerAge = VJ.nonEmpty(top["age"]) } else if said != nil, let h0 = h.first { let a = Route.age(h0.ts, now: now); answerAge = a.isEmpty ? nil : a }
        return MemoryAnswer(text: text.trimmingCharacters(in: .whitespacesAndNewlines),
                            answer: top.map { VJ.s($0["text"]) } ?? said,
                            answerKind: top != nil ? .memory : said != nil ? .said : nil,
                            answerAge: answerAge,
                            confidence: top.flatMap(conf),
                            more: f.dropFirst().map { VJ.s($0["text"]) },
                            sources: Array(sources.prefix(3)))
    }
}
