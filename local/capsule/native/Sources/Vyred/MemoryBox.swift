// MemoryBox: what memory said about the words in the box, and the lines a quick question is sent
// with. Every answer comes from vyred's memory.answer, which weighs where a fact came from (the
// person's own words, never dev, test or tool text). The Capsule ranks nothing itself: its old
// local ranker (Said) read any first-person line in any transcript as a fact about the user, and
// answered "Jordan" from a test session. Removed on 2026-09-27 (the user's bug report).

import Foundation

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
    /// How many conversations back the answer, when memory counts them (memory.answer); else the
    /// sessions among `sources`.
    public var conversations: Int?
    public var conversationCount: Int { conversations ?? Set(sources.map(\.session)).count }
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
    /// Empty with none: how to answer is sessions' Vyre IQ prompt, on the box.
    public static func append(_ m: MemoryAnswer?) -> String {
        let l = lines(m)
        if l.isEmpty { return "" }
        return "What the user's own notes say:\n\(l.map { "- \($0)" }.joined(separator: "\n"))\n\n" +
            "If these answer the question, answer from them and say when the user said it, like \"a blue Volvo XC40 (you said so 2 weeks ago)\". They may be old or partial; say so if it matters."
    }

    /// A memory.answer result as the box shows it: its answer (nil when memory does not know),
    /// how sure it is, and the turns it came from. Nothing is added or ranked here.
    public static func fromAnswer(text: String, _ data: Any?, now: Double = vyNowMs()) -> MemoryAnswer {
        let d = (data as? [String: Any]) ?? [:]
        let kind = VJ.s(d["kind"])
        let sources: [MemorySource] = ((d["sources"] as? [[String: Any]]) ?? []).map { x in
            MemorySource(kind: kind == "fact" ? .fact : .quote, role: "user", session: VJ.s(x["session"]), seq: VJ.int(x["seq"]),
                         name: VJ.nonEmpty(x["name"]) ?? String(VJ.s(x["session"]).prefix(8)), quote: VJ.s(x["quote"]),
                         age: Route.age(VJ.num(x["ts"]), now: now), confidence: nil)
        }
        let answer = VJ.nonEmpty(d["answer"])
        var m = MemoryAnswer(text: text.trimmingCharacters(in: .whitespacesAndNewlines),
                             answer: answer,
                             answerKind: answer == nil ? nil : kind == "said" ? .said : .memory,
                             answerAge: sources.first.map(\.age).flatMap { $0.isEmpty ? nil : $0 },
                             confidence: VJ.num(d["confidence"]),
                             sources: Array(sources.prefix(3)))
        if let n = VJ.int(d["from"]), n > 0 { m.conversations = n }
        return m
    }
}
